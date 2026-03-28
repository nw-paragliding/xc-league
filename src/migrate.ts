// =============================================================================
// XC / Hike & Fly League Platform — Database Migration Runner
//
// Runs at container startup (before the HTTP server boots).
// Safe to run on every deploy — migrations are idempotent.
//
// Strategy: single schema.sql for initial setup tracked by a `migrations`
// table. Future schema changes are added as numbered migration files.
//
// Usage: node dist/migrate.js
// =============================================================================

import 'dotenv/config';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const DB_PATH = process.env['DB_PATH'] ?? './league.db';

console.log(`[migrate] Opening database at ${DB_PATH}`);
const db = new Database(DB_PATH);

// WAL mode and foreign keys — set before any schema work
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create migrations tracking table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS migrations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`);

const applied = new Set(
  db.prepare('SELECT name FROM migrations').all().map((r: any) => r.name as string),
);

// ---- Migration 0001: initial schema ----
// Applied once on first boot. Skipped on all subsequent deploys.
const INITIAL_MIGRATION = '0001_initial_schema';
if (!applied.has(INITIAL_MIGRATION)) {
  console.log(`[migrate] Applying ${INITIAL_MIGRATION}`);
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  db.prepare('INSERT INTO migrations (name) VALUES (?)').run(INITIAL_MIGRATION);
  console.log(`[migrate] ${INITIAL_MIGRATION} applied`);
} else {
  console.log(`[migrate] ${INITIAL_MIGRATION} already applied — skipping`);
}

// ---- Future migrations ----
// Add .sql files to src/migrations/ named 0002_description.sql, 0003_... etc.
// They will be picked up and applied in order on the next deploy.
const MIGRATIONS_DIR = join(__dirname, 'migrations');
let migrationFiles: string[] = [];
try {
  migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
} catch {
  // Directory doesn't exist yet — no additional migrations
}

for (const file of migrationFiles) {
  const name = file.replace('.sql', '');
  if (applied.has(name)) {
    console.log(`[migrate] ${name} already applied — skipping`);
    continue;
  }
  console.log(`[migrate] Applying ${name}`);
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  db.exec(sql);
  db.prepare('INSERT INTO migrations (name) VALUES (?)').run(name);
  console.log(`[migrate] ${name} applied`);
}

// ---- Bootstrap Super Admin ----
// If BOOTSTRAP_SUPER_ADMIN_EMAIL is set and no super admins exist,
// promote that user to super admin.
function bootstrapSuperAdmin() {
  const bootstrapEmail = process.env['BOOTSTRAP_SUPER_ADMIN_EMAIL'];
  if (!bootstrapEmail) {
    console.log('[migrate] No BOOTSTRAP_SUPER_ADMIN_EMAIL set, skipping super admin bootstrap');
    return;
  }

  // Check if the bootstrap email user exists and whether they're already a super admin
  const user = db.prepare(
    `SELECT id, email, is_super_admin FROM users WHERE email = ? AND deleted_at IS NULL`
  ).get(bootstrapEmail) as { id: string; email: string; is_super_admin: number } | undefined;

  if (!user) {
    console.warn(`[migrate] Bootstrap super admin email ${bootstrapEmail} not found - user must sign in first`);
    return;
  }

  if (user.is_super_admin) {
    console.log(`[migrate] ${bootstrapEmail} is already a super admin, skipping bootstrap`);
    return;
  }

  // Promote to super admin
  db.prepare(
    `UPDATE users SET is_super_admin = 1, updated_at = datetime('now') WHERE id = ?`
  ).run(user.id);

  // Log the bootstrap action
  db.prepare(
    `INSERT INTO admin_audit_log (id, actor_user_id, target_user_id, action, created_at)
     VALUES (?, ?, ?, 'BOOTSTRAP_SUPER_ADMIN', datetime('now'))`
  ).run(randomUUID(), user.id, user.id);

  console.log(`[migrate] ✅ Bootstrapped super admin: ${bootstrapEmail}`);
}

bootstrapSuperAdmin();

db.close();
console.log('[migrate] All migrations complete');
