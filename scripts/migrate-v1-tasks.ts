/**
 * One-shot migration: copy active scheduled tasks from v1 store/messages.db
 * into v2 per-session inbound.db files.
 *
 * Creates sessions in v2.db and the matching inbound.db for each agent group
 * that has tasks. The host sweep will fire them on schedule from that point on.
 *
 * Safe to re-run — skips tasks that already exist (by id).
 *
 * Usage: pnpm exec tsx scripts/migrate-v1-tasks.ts
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { INBOUND_SCHEMA } from '../src/db/schema.js';

const V1_DB = path.join(process.cwd(), 'store', 'messages.db');
const V2_DB = path.join(DATA_DIR, 'v2.db');
const SESSIONS_DIR = path.join(DATA_DIR, 'v2-sessions');

// v1 group_folder → v2 agent group id (must match what we inserted)
const AGENT_GROUP: Record<string, string> = {
  telegram_exercise:    'ag-telegram-exercise',
  telegram_spudtronomy: 'ag-telegram-spudtronomy',
  telegram_weather:     'ag-telegram-weather',
  telegram_youtube:     'ag-telegram-youtube',
};

// v2 agent group id → messaging group info
const MESSAGING_GROUP: Record<string, { id: string; platformId: string; channelType: string }> = {
  'ag-telegram-exercise':    { id: 'mg-1777072383009-1tuc0j', platformId: 'telegram:-5143925896', channelType: 'telegram' },
  'ag-telegram-spudtronomy': { id: 'mg-1777072537658-od29y2', platformId: 'telegram:-5086383187', channelType: 'telegram' },
  'ag-telegram-weather':     { id: 'mg-1777072410290-79sehq', platformId: 'telegram:-5170216733', channelType: 'telegram' },
  'ag-telegram-youtube':     { id: 'mg-1777072310184-3sb7ci', platformId: 'telegram:-4830803288', channelType: 'telegram' },
};

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cronToNextRun(cron: string): string {
  // Parse cron and compute next fire time. We use a simple approach:
  // just set process_after to now so tasks fire on the next sweep,
  // then recurrence handles subsequent runs correctly.
  return new Date().toISOString();
}

function getOrCreateSession(v2: Database.Database, agentGroupId: string): string {
  const mg = MESSAGING_GROUP[agentGroupId];
  const now = new Date().toISOString();

  // Check for existing session for this agent group + messaging group
  const existing = v2.prepare(
    `SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL LIMIT 1`
  ).get(agentGroupId, mg.id) as { id: string } | undefined;

  if (existing) {
    console.log(`  Reusing session ${existing.id} for ${agentGroupId}`);
    return existing.id;
  }

  const sessionId = generateId('sess');
  v2.prepare(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status, created_at)
     VALUES (?, ?, ?, NULL, 'active', 'stopped', ?)`
  ).run(sessionId, agentGroupId, mg.id, now);

  console.log(`  Created session ${sessionId} for ${agentGroupId}`);
  return sessionId;
}

function getOrCreateInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  const dir = path.join(SESSIONS_DIR, agentGroupId, 'sessions', sessionId);
  fs.mkdirSync(dir, { recursive: true });

  const dbPath = path.join(dir, 'inbound.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.exec(INBOUND_SCHEMA);

  // Apply any post-init schema additions (series_id, trigger columns)
  const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('series_id')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN series_id TEXT').run();
    db.prepare('UPDATE messages_in SET series_id = id WHERE series_id IS NULL').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id)').run();
  }
  if (!cols.includes('trigger')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN trigger INTEGER NOT NULL DEFAULT 1').run();
  }

  return db;
}

function insertTaskIfMissing(
  inDb: Database.Database,
  task: { id: string; schedule_value: string; prompt: string; schedule_type: string },
  seq: number,
): boolean {
  const exists = inDb.prepare('SELECT 1 FROM messages_in WHERE id = ?').get(task.id);
  if (exists) {
    console.log(`    Skip (already exists): ${task.id}`);
    return false;
  }

  const now = new Date().toISOString();
  const recurrence = task.schedule_type === 'cron' ? task.schedule_value : null;

  inDb.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, 'task', ?, 'pending', ?, ?, ?, 0, 1, NULL, NULL, NULL, ?)`
  ).run(
    task.id,
    seq,
    now,
    cronToNextRun(task.schedule_value),
    recurrence,
    task.id,
    JSON.stringify({ prompt: task.prompt }),
  );

  return true;
}

async function main(): Promise<void> {
  const v1 = new Database(V1_DB, { readonly: true });
  const v2 = new Database(V2_DB);
  v2.pragma('journal_mode = WAL');
  v2.pragma('busy_timeout = 5000');

  const tasks = v1.prepare(
    `SELECT id, group_folder, schedule_type, schedule_value, prompt, status FROM scheduled_tasks WHERE status = 'active'`
  ).all() as Array<{ id: string; group_folder: string; schedule_type: string; schedule_value: string; prompt: string; status: string }>;

  console.log(`Found ${tasks.length} active v1 tasks\n`);

  // Group tasks by agent group
  const byGroup: Record<string, typeof tasks> = {};
  for (const task of tasks) {
    const agId = AGENT_GROUP[task.group_folder];
    if (!agId) {
      console.log(`Skipping ${task.id} — no v2 agent group for folder '${task.group_folder}'`);
      continue;
    }
    (byGroup[agId] ??= []).push(task);
  }

  for (const [agentGroupId, groupTasks] of Object.entries(byGroup)) {
    console.log(`\n${agentGroupId} (${groupTasks.length} tasks):`);

    const sessionId = getOrCreateSession(v2, agentGroupId);
    const inDb = getOrCreateInboundDb(agentGroupId, sessionId);

    // seq numbers must be unique in messages_in; get current max
    const maxSeq = (inDb.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
    let seq = maxSeq + 2; // even numbers for host (odd for container)

    for (const task of groupTasks) {
      const inserted = insertTaskIfMissing(inDb, task, seq);
      if (inserted) {
        console.log(`    Created: ${task.id} [${task.schedule_value}] ${task.prompt.slice(0, 50)}...`);
        seq += 2;
      }
    }

    inDb.close();
  }

  v1.close();
  v2.close();

  console.log('\nDone. Tasks will fire on the next host sweep (60s).');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
