/**
 * One-off repair: move legacy task series out of their agent group's CHAT
 * session and into an isolated per-series task session
 * (thread `system:tasks:<seriesId>`), which is what `ncl tasks create` has
 * produced since v2.1.54.
 *
 * Legacy series predate that feature and stay pinned to the chat session
 * because `handleRecurrence` re-arms each series in whatever inbound.db its
 * row already occupies. Symptoms: task runs share one Claude Code transcript
 * with the group's chat, and every run's `task_log` row is discarded by
 * delivery.ts ("task_log row outside a task session") so no run log is ever
 * written.
 *
 * Preserves series_id, so tasks/<series>.md and the run counters stay
 * continuous. Only 'pending'/'paused' rows move; completed rows are inert
 * history and stay put.
 *
 *   pnpm exec tsx scripts/migrate-task-sessions.ts                 # dry run, all
 *   pnpm exec tsx scripts/migrate-task-sessions.ts --series <id>   # dry run, one
 *   pnpm exec tsx scripts/migrate-task-sessions.ts --series <id> --apply
 *   pnpm exec tsx scripts/migrate-task-sessions.ts --all --apply
 */
import type Database from 'better-sqlite3';

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { execFileSync } from 'child_process';

import { getDb } from '../src/db/index.js';
import { insertTaskRow } from '../src/modules/scheduling/db.js';
import { inboundDbPath, resolveTaskSession, withInboundDb } from '../src/session-manager.js';

/** Refuse to move a series firing sooner than this — avoids racing a wake. */
const MIN_LEAD_MS = 15 * 60 * 1000;

interface SessionRow {
  id: string;
  agent_group_id: string;
  thread_id: string | null;
}
interface TaskRow {
  id: string;
  series_id: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  content: string;
}

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const onlySeries = argv.includes('--series') ? argv[argv.indexOf('--series') + 1] : null;
/** Also relocate the series' completed rows — `ncl tasks list` derives run
 *  counts from completed rows in the SAME session, so leaving them behind
 *  resets the series' run history to 0. */
const withHistory = argv.includes('--with-history');

if (!onlySeries && !argv.includes('--all')) {
  console.error('Refusing to run without --series <id> or --all.');
  process.exit(2);
}

initDb(path.join(DATA_DIR, 'v2.db'));

/**
 * `isContainerRunning` from container-runner is an in-process Map owned by the
 * host — always empty here. Ask Docker directly instead. Container names are
 * `nanoclaw-v2-<group folder>-<ts>`, so this is group-granular: conservative,
 * which is what we want before moving rows out from under a live agent.
 */
function runningGroupFolders(): Set<string> {
  try {
    const out = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf-8' });
    return new Set(
      out
        .split('\n')
        .filter((n) => n.startsWith('nanoclaw-v2-'))
        .map((n) => n.replace(/^nanoclaw-v2-/, '').replace(/-\d+$/, '')),
    );
  } catch {
    return new Set();
  }
}
const busyFolders = runningGroupFolders();

const sessions = getDb()
  .prepare("SELECT id, agent_group_id, thread_id FROM sessions WHERE status = 'active'")
  .all() as SessionRow[];

let moved = 0;
let skipped = 0;

for (const session of sessions) {
  // Already isolated — nothing to do.
  if (session.thread_id?.startsWith('system:tasks:')) continue;

  let rows: TaskRow[];
  try {
    rows = withInboundDb(session.agent_group_id, session.id, (db: Database.Database) =>
      db
        .prepare(
          `SELECT id, series_id, status, process_after, recurrence, content
             FROM messages_in
            WHERE kind = 'task' AND status IN ('pending','paused') AND series_id IS NOT NULL`,
        )
        .all() as TaskRow[],
    );
  } catch {
    continue; // no inbound.db yet
  }

  for (const row of rows) {
    if (onlySeries && row.series_id !== onlySeries) continue;

    const lead = row.process_after ? Date.parse(row.process_after) - Date.now() : Infinity;
    if (Number.isFinite(lead) && lead < MIN_LEAD_MS) {
      console.log(`SKIP  ${row.series_id} — fires in ${Math.round(lead / 60000)}min (< 15min lead)`);
      skipped++;
      continue;
    }
    const folder = (
      getDb().prepare('SELECT folder FROM agent_groups WHERE id = ?').get(session.agent_group_id) as
        | { folder: string }
        | undefined
    )?.folder;
    if (folder && busyFolders.has(folder)) {
      console.log(`SKIP  ${row.series_id} — container running for group ${folder}`);
      skipped++;
      continue;
    }

    const { session: target, created } = resolveTaskSession(session.agent_group_id, row.series_id);
    console.log(
      `${apply ? 'MOVE ' : 'PLAN '} ${row.series_id}  ${session.id} -> ${target.id}` +
        `${created ? ' (new)' : ''}  next=${row.process_after}`,
    );

    if (!apply) continue;

    if (!fs.existsSync(inboundDbPath(session.agent_group_id, target.id))) {
      console.log(`ERROR ${row.series_id} — target inbound.db missing; leaving in place`);
      skipped++;
      continue;
    }

    withInboundDb(session.agent_group_id, target.id, (db: Database.Database) =>
      insertTaskRow(db, {
        id: row.id,
        seriesId: row.series_id,
        processAfter: row.process_after,
        recurrence: row.recurrence,
        content: row.content,
        status: row.status === 'paused' ? 'paused' : 'pending',
      }),
    );
    withInboundDb(session.agent_group_id, session.id, (db: Database.Database) =>
      db.prepare('DELETE FROM messages_in WHERE id = ?').run(row.id),
    );

    if (withHistory) {
      const hist = withInboundDb(session.agent_group_id, session.id, (db: Database.Database) =>
        db
          .prepare(
            `SELECT id, seq, timestamp, status, tries, process_after, recurrence, content, series_id
               FROM messages_in WHERE kind = 'task' AND series_id = ? AND status NOT IN ('pending','paused')
              ORDER BY seq ASC`,
          )
          .all(row.series_id) as Array<Record<string, unknown>>,
      );
      // `seq` is INTEGER UNIQUE and the pending row already claimed a low even
      // seq in the fresh target DB. Copying historical seq values verbatim
      // collides with it, so renumber onto fresh even seqs (host parity) in
      // original order. A plain INSERT (not OR IGNORE) keeps any residual
      // collision loud instead of silently dropping history.
      const inserted = withInboundDb(session.agent_group_id, target.id, (db: Database.Database) => {
        const maxSeq =
          ((db.prepare('SELECT MAX(seq) AS m FROM messages_in').get() as { m: number | null }).m ?? 0) + 2;
        const base = maxSeq % 2 === 0 ? maxSeq : maxSeq + 1;
        const ins = db.prepare(
          `INSERT INTO messages_in
             (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
           VALUES (@id, @seq, @timestamp, @status, @tries, @process_after, @recurrence, 'task', NULL, NULL, NULL, @content, @series_id)`,
        );
        const tx = db.transaction((hs: Array<Record<string, unknown>>) =>
          hs.forEach((h, i) => ins.run({ ...h, seq: base + i * 2 })),
        );
        tx(hist);
        return hist.length;
      });
      if (inserted !== hist.length) throw new Error(`history insert mismatch: ${inserted}/${hist.length}`);
      withInboundDb(session.agent_group_id, session.id, (db: Database.Database) =>
        db
          .prepare(
            `DELETE FROM messages_in WHERE kind = 'task' AND series_id = ? AND status NOT IN ('pending','paused')`,
          )
          .run(row.series_id),
      );
      console.log(`      + relocated ${hist.length} completed row(s)`);
    }
    moved++;
  }
}

console.log(`\n${apply ? 'moved' : 'would move'}: ${moved}   skipped: ${skipped}`);
