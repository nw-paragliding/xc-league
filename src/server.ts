// =============================================================================
// XC / Hike & Fly League Platform — Server Entry Point
//
// Starts Fastify, registers plugins, mounts all routes, serves the
// React frontend as static files from the same process.
//
// Run order (see migrate.ts):
//   node dist/migrate.js && node dist/server.js
// =============================================================================

import 'dotenv/config';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { authPlugin, loadAuthConfig } from './auth';
import { bootstrapWorker, rebuildTaskResults, SQLiteJobQueue } from './job-queue';
import { dropRedundantLeagueIdColumns } from './migration-helpers';

// =============================================================================
// CONSTANTS
// =============================================================================

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const DB_PATH = process.env['DB_PATH'] ?? './league.db';
const IS_PROD = process.env['NODE_ENV'] === 'production';
// In production the built frontend sits next to server.js in dist/
// In development Vite serves the frontend on its own port (proxied via vite.config.ts)
const STATIC_DIR = join(__dirname, IS_PROD ? '../client' : '../public');

const MAX_IGC_SIZE_BYTES = 5 * 1024 * 1024; // 5MB — matches upload handler

// =============================================================================
// BOOTSTRAP
// =============================================================================

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db
      .prepare('SELECT name FROM migrations')
      .all()
      .map((r: any) => r.name as string),
  );

  const INITIAL = '0001_initial_schema';
  if (!applied.has(INITIAL)) {
    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    db.exec(schema);
    db.prepare('INSERT INTO migrations (name) VALUES (?)').run(INITIAL);
    console.log(`[migrate] Applied ${INITIAL}`);
  }

  const migrationsDir = join(__dirname, 'migrations');
  let files: string[] = [];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    /* no dir */
  }

  for (const file of files) {
    const name = file.replace('.sql', '');
    if (applied.has(name)) continue;
    db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
    db.prepare('INSERT INTO migrations (name) VALUES (?)').run(name);
    console.log(`[migrate] Applied ${name}`);
  }

  // 0010: drop league_id columns that SQLite can't handle via IF EXISTS
  dropRedundantLeagueIdColumns(db);
}

async function main() {
  // ── Database ───────────────────────────────────────────────────────────────
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Busy timeout — prevents "database is locked" errors under concurrent writes
  db.pragma('busy_timeout = 5000');

  // ── Migrations (run on every startup — idempotent) ──────────────────────
  runMigrations(db);

  // ── Auth config ────────────────────────────────────────────────────────────
  const authConfig = loadAuthConfig();

  // ── Job queue + worker ─────────────────────────────────────────────────────
  const queue = new SQLiteJobQueue(db);
  const worker = bootstrapWorker(db, queue);

  // Drop any pending/failed jobs that referenced removed handler types
  // *before* starting the worker, so it doesn't fail-loop them after deploy.
  db.prepare(
    `DELETE FROM jobs
     WHERE status IN ('PENDING', 'FAILED')
       AND type IN ('RESCORE_TASK', 'FREEZE_TASK_SCORES', 'REBUILD_STANDINGS',
                    'NOTIFY_PILOTS', 'REPROCESS_ALL_SUBMISSIONS')`,
  ).run();

  worker.start();

  // ── Boot-time rebuild of task_results ──────────────────────────────────────
  // rebuildTaskResults now re-scores from canonical inputs (current best
  // distance, full goal-times set), so previously-cached rows can be stale
  // under bug fixes. Run it once for every non-deleted task on boot — cheap
  // (~1ms per task) and self-heals the leaderboard. Standings is now a live
  // SQL aggregate, so no separate standings rebuild is needed.
  const tasksToRebuild = db.prepare(`SELECT id FROM tasks WHERE deleted_at IS NULL`).all() as Array<{ id: string }>;
  for (const { id } of tasksToRebuild) rebuildTaskResults(db, id);

  // ── Fastify ────────────────────────────────────────────────────────────────
  const app = Fastify({
    logger: {
      level: IS_PROD ? 'info' : 'debug',
      transport: IS_PROD
        ? undefined
        : {
            target: 'pino-pretty',
            options: { colorize: true },
          },
    },
  });

  // ── Plugins ────────────────────────────────────────────────────────────────

  // Cookies — required for HttpOnly auth cookie
  await app.register(fastifyCookie);

  // Multipart — required for IGC file upload; enforce 5MB limit here
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_IGC_SIZE_BYTES,
      files: 1, // only one file per upload request
      fieldSize: 500 * 1024, // bulk-import sends task config JSON (can be large)
    },
  });

  // CORS — only needed if frontend is on a different origin (dev without proxy)
  // In production same-origin, so this is a no-op safety net
  await app.register(fastifyCors, {
    origin: IS_PROD ? false : 'http://localhost:5173',
    credentials: true, // allow cookies cross-origin in dev
  });

  // Rate limiting — global default + stricter limits on auth/upload routes
  await app.register(fastifyRateLimit, {
    global: true,
    max: 200,
    timeWindow: '1 minute',
    // Skip rate limiting in test/dev to avoid flaky tests
    skipOnError: true,
    ...(IS_PROD ? {} : { max: 10000 }), // effectively off in dev
  });

  // HSTS — tell browsers to always use HTTPS for this origin
  if (IS_PROD) {
    app.addHook('onSend', (_request, reply, _payload, done) => {
      reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
      done();
    });
  }

  // Auth middleware — decorates every request with request.user
  await app.register(authPlugin, { config: authConfig, db });

  // ── Static file serving ────────────────────────────────────────────────────
  //
  // In production: serves the Vite build from dist/client/
  //   Vite build output: frontend/dist/ → copied to dist/client/ by build script
  //
  // The wildcard route at the bottom catches all non-API paths and returns
  // index.html, enabling React Router client-side navigation.
  //
  // In development: Vite runs on :5173 and proxies /api to :3000.
  //   The static plugin is still registered (serves nothing useful) but
  //   the wildcard route is skipped so Vite handles the frontend.
  if (IS_PROD) {
    await app.register(fastifyStatic, {
      root: join(__dirname, 'client'),
      prefix: '/',
      // Don't serve index.html automatically for unknown paths —
      // we handle that in the wildcard route below so we can
      // distinguish between API 404s and frontend route 404s
      index: false,
      // Cache static assets aggressively (Vite fingerprints filenames)
      setHeaders: (res, path) => {
        if (path.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    });
  }

  // ── API routes ─────────────────────────────────────────────────────────────
  // Register all route modules under /api/v1
  // Each module is a Fastify plugin that receives db and queue as options

  await app.register(
    async (api) => {
      // Auth routes
      const { registerAuthRoutes } = await import('./routes/auth');
      await registerAuthRoutes(api, { config: authConfig, db });

      // Admin routes
      const { registerAdminRoutes } = await import('./routes/admin');
      await registerAdminRoutes(api, { db });

      // League routes
      const { registerLeagueRoutes } = await import('./routes/leagues');
      await registerLeagueRoutes(api, { db });
    },
    { prefix: '/api/v1' },
  );

  // ── SPA fallback ───────────────────────────────────────────────────────────
  // Any non-API GET request that didn't match a static file gets index.html.
  // This enables React Router to handle client-side routes like /leagues/xyz.
  if (IS_PROD) {
    app.setNotFoundHandler((request, reply) => {
      // Only serve index.html for GET requests that aren't API calls
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html', join(__dirname, 'client'));
      }
      // Real API 404
      reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `${request.method} ${request.url} not found` },
      });
    });
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down`);
    worker.stop();
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ── Start ──────────────────────────────────────────────────────────────────
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    app.log.info(`Server listening on port ${PORT}`);
    app.log.info(`Database: ${DB_PATH}`);
    app.log.info(`Environment: ${IS_PROD ? 'production' : 'development'}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();

// =============================================================================
// BUILD NOTES
//
// package.json scripts:
//   "build:server":   "tsc -p tsconfig.server.json"
//   "build:client":   "cd frontend && vite build --outDir ../dist/client"
//   "build":          "npm run build:server && npm run build:client"
//   "dev:server":     "tsx watch src/server.ts"
//   "dev:client":     "cd frontend && vite"
//   "dev":            "concurrently \"npm run dev:server\" \"npm run dev:client\""
//   "start":          "node dist/migrate.js && node dist/server.js"
//
// Project structure:
//   /
//   ├── src/              TypeScript server source
//   │   ├── server.ts     (this file)
//   │   ├── auth.ts
//   │   ├── pipeline.ts
//   │   ├── job-queue.ts
//   │   ├── upload.ts
//   │   ├── track-replay.ts
//   │   ├── migrate.ts
//   │   ├── schema.sql
//   │   └── routes/
//   │       ├── auth.ts
//   │       └── leagues.ts
//   ├── frontend/         Vite + React source (the src/ from the frontend files)
//   │   ├── src/
//   │   ├── index.html
//   │   └── vite.config.ts
//   ├── dist/             Compiled output (gitignored)
//   │   ├── server.js
//   │   ├── migrate.js
//   │   └── client/       Built frontend (index.html + assets/)
//   ├── fly.toml
//   └── Dockerfile
// =============================================================================
