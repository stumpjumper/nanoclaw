/**
 * scripts/export-db-config.ts — Export config tables from data/v2.db as SQL.
 *
 * Dumps the rows that are painful to recreate (group definitions, wirings,
 * container configs, user roles) while skipping runtime state (sessions,
 * pending_*, chat_sdk_*, unregistered_senders).
 *
 * Usage:
 *   pnpm exec tsx scripts/export-db-config.ts [output-path]
 *
 * Default output: ~/.nanoclaw-private/db-config.sql
 * Stdout fallback: pass "-" as output-path
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

const CONFIG_TABLES = [
  'schema_version',
  'users',
  'user_roles',
  'agent_groups',
  'agent_group_members',
  'agent_message_policies',
  'messaging_groups',
  'messaging_group_agents',
  'agent_destinations',
  'container_configs',
  'user_dms',
];

const DB_PATH = resolve(join(import.meta.dirname ?? '', '..', 'data', 'v2.db'));
const DEFAULT_OUT = join(homedir(), '.nanoclaw-private', 'db-config.sql');

const outArg = process.argv[2];
const outPath = outArg === '-' ? null : (outArg ?? DEFAULT_OUT);

const db = new Database(DB_PATH, { readonly: true });

function quoteValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return String(v);
  // Escape single quotes by doubling them
  return `'${String(v).replace(/'/g, "''")}'`;
}

const lines: string[] = [];

lines.push(`-- NanoClaw DB config export`);
lines.push(`-- Generated: ${new Date().toISOString()}`);
lines.push(`-- Source: ${DB_PATH}`);
lines.push(`--`);
lines.push(`-- Restore with: pnpm exec tsx scripts/q.ts data/v2.db "$(cat db-config.sql)"`);
lines.push(`-- or:           sqlite3 data/v2.db < db-config.sql`);
lines.push(``);
lines.push(`PRAGMA foreign_keys = OFF;`);
lines.push(`BEGIN TRANSACTION;`);
lines.push(``);

for (const table of CONFIG_TABLES) {
  // Skip if table doesn't exist (older schema)
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table);
  if (!exists) continue;

  const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];

  lines.push(`-- ${table}`);
  lines.push(`DELETE FROM ${table};`);

  if (rows.length > 0) {
    const cols = Object.keys(rows[0]);
    const colList = cols.map((c) => `"${c}"`).join(', ');
    for (const row of rows) {
      const vals = cols.map((c) => quoteValue(row[c])).join(', ');
      lines.push(`INSERT INTO ${table} (${colList}) VALUES (${vals});`);
    }
  }

  lines.push(``);
}

lines.push(`COMMIT;`);
lines.push(`PRAGMA foreign_keys = ON;`);
lines.push(``);

db.close();

const output = lines.join('\n');

if (outPath === null) {
  process.stdout.write(output);
} else {
  writeFileSync(outPath, output, 'utf8');
  console.log(`Exported ${CONFIG_TABLES.length} tables → ${outPath}`);
}
