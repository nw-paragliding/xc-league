# XC League - Agent Guidelines

This document provides coding agents with essential information about this codebase's structure, commands, and style conventions.

## Project Overview

XC / Hike & Fly League Platform - a fullstack TypeScript application for paragliding competition scoring.

**Architecture:**
- Backend: Fastify + SQLite + TypeScript (CommonJS)
- Frontend: React + Vite + TypeScript (ESNext)
- Database: SQLite with WAL mode, better-sqlite3
- Auth: Google OAuth → JWT (RS256, HttpOnly cookies)
- Job Queue: SQLite-backed queue with single-process worker

**Directory Structure:**
```
/
├── src/                    # Backend TypeScript source (server-side)
│   ├── server.ts          # Fastify entry point
│   ├── auth.ts            # JWT + OAuth middleware
│   ├── pipeline.ts        # IGC processing pipeline
│   ├── job-queue.ts       # Background job system
│   ├── schema.sql         # Database schema
│   └── routes/            # API route handlers
├── frontend/              # React frontend (client-side)
│   ├── src/
│   │   ├── main.tsx       # React entry point
│   │   ├── App.tsx        # Root component
│   │   ├── api/           # API client functions
│   │   ├── hooks/         # React hooks
│   │   └── pages/         # Page components
│   ├── vite.config.ts
│   └── package.json       # Frontend dependencies
├── dist/                  # Compiled output (gitignored)
│   ├── server.js          # Built backend
│   └── client/            # Built frontend (Vite output)
├── package.json           # Root package.json (backend deps + scripts)
└── tsconfig.server.json   # Backend TypeScript config
```

---

## Environment Setup

### Node.js Version Management
This project requires Node.js >=20. Use `fnm` (Fast Node Manager) to manage Node versions:

```bash
# Activate fnm environment (add to your shell rc file)
eval "$(fnm env)"

# The project uses Node v22.18.0
fnm use
```

### Python for Native Modules
The `better-sqlite3` dependency requires Python 3.8+ for compilation. This project uses `uv` to manage Python:

```bash
# Install uv (if not already installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install Python 3.12
uv python install 3.12

# Create .npmrc from template
cp .npmrc.example .npmrc
# Edit .npmrc and set python path: uv python find 3.12
```

### First-time Setup
```bash
# 1. Ensure fnm and uv are configured
eval "$(fnm env)"
source ~/.local/bin/env  # for uv

# 2. Install dependencies
npm install

# 3. Copy environment file
cp .env.example .env
# Edit .env with your credentials
```

---

## Build, Lint, and Test Commands

### Development
```bash
# Start both frontend and backend in watch mode (recommended)
npm run dev

# Start backend only (port 3000, with auto-reload)
npm run dev:server

# Start frontend only (port 5173, Vite dev server)
npm run dev:client
```

### Type Checking
```bash
# Check both frontend and backend types
npm run typecheck

# Check backend types only
tsc --noEmit

# Check frontend types only
cd frontend && tsc --noEmit
```

### Building
```bash
# Build both frontend and backend for production
npm run build

# Build backend only (outputs to dist/)
npm run build:server

# Build frontend only (outputs to dist/client/)
npm run build:client
```

### Running Production Build
```bash
# Run migrations then start server (reads from dist/)
npm start
```

### Testing
**Currently no test framework is configured.** If adding tests:
- Backend: Use Vitest or Node's built-in test runner
- Frontend: Use Vitest with @testing-library/react
- Run single test: `vitest run path/to/test.ts` (after setup)

---

## Code Style Guidelines

### File Headers
All non-trivial files include a header comment block with:
- Title/purpose (one line)
- Key architectural decisions or constraints
- Dependencies and patterns used

Example:
```typescript
// =============================================================================
// XC / Hike & Fly League Platform — Job Queue Architecture
//
// Design:
//   - Single Node.js process: Fastify API + worker loop run together
//   - Jobs stored in SQLite `jobs` table
// =============================================================================
```

### Imports

**Backend (src/):**
```typescript
// Standard library / external packages first
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { join } from 'path';

// Local imports second, grouped by type
import { loadAuthConfig, authPlugin } from './auth';
import { SQLiteJobQueue } from './job-queue';
import type { TaskDefinition, Fix } from './pipeline';
```

**Frontend (frontend/src/):**
```typescript
// React imports first
import { useState } from 'react';

// Local hooks/utilities
import { useAuth } from './hooks/useAuth';
import { LeagueProvider } from './hooks/useLeague';

// Page/component imports
import UploadPage from './pages/UploadPage';
```

- No trailing slashes in import paths
- Prefer named imports over default where available
- Import types with `import type` when importing only types

### Formatting

**Indentation:** 2 spaces (no tabs)

**Line Length:** Soft limit ~100 chars; hard limit ~120 chars

**Alignment:** Use consistent alignment for readability:
```typescript
const PORT        = parseInt(process.env['PORT'] ?? '3000', 10);
const DB_PATH     = process.env['DB_PATH'] ?? './league.db';
const IS_PROD     = process.env['NODE_ENV'] === 'production';
const STATIC_DIR  = join(__dirname, IS_PROD ? '../client' : '../public');
```

**Trailing Commas:** Use in multiline objects/arrays for cleaner diffs

**Semicolons:** Always use semicolons

**Quotes:** Single quotes for strings; backticks for templates

### TypeScript

**Strict Mode:** `strict: true` is enabled in both tsconfig files

**Types:**
- Always declare return types for exported functions
- Use `interface` for object shapes; `type` for unions/intersections
- Prefer explicit types over `any`; use `unknown` when type is truly unknown
- Use type guards (`typeof`, `instanceof`) before narrowing

**Naming Conventions:**
- **Files:** kebab-case (`job-queue.ts`, `api-spec.ts`)
- **Components:** PascalCase files (`UploadPage.tsx`, `App.tsx`)
- **Variables/functions:** camelCase (`processUpload`, `userId`)
- **Types/Interfaces:** PascalCase (`TaskDefinition`, `UserRecord`)
- **Constants:** UPPER_SNAKE_CASE (`MAX_IGC_SIZE_BYTES`, `JWT_ALGORITHM`)
- **Private class fields:** prefix with underscore (`_listeners`)

**Nullability:**
```typescript
// Prefer explicit null over undefined for "no value"
interface UserRecord {
  avatarUrl: string | null;  // not string | undefined
}

// Use ?? for defaults, not ||
const port = process.env['PORT'] ?? '3000';
```

### Error Handling

**Backend:**
- Use Result types for pipeline stages: `Result<T, E>`
- Throw errors only for unrecoverable failures
- Always log errors before sending response:
  ```typescript
  try {
    // ...
  } catch (err) {
    request.log.error(err, 'OAuth callback error');
    reply.status(500).send({ error: 'Internal server error' });
  }
  ```

**Structured Errors:**
```typescript
// API error responses
reply.status(404).send({
  error: { code: 'NOT_FOUND', message: 'Resource not found' }
});
```

### Database

**Query Style:**
- Use prepared statements for all queries (never string interpolation)
- Use template literals for multi-line SQL (improves readability)
- Wrap multi-step mutations in transactions
- Use `db.transaction()` for atomicity

```typescript
const user = db.get<UserRecord>(
  `SELECT id, email, display_name as displayName
   FROM users WHERE id = ?`,
  [userId]
);

db.transaction(() => {
  db.run(`INSERT INTO users (...) VALUES (?, ?)`, [id, name]);
  db.run(`INSERT INTO oauth_identities (...) VALUES (?, ?)`, [id, provider]);
})();
```

### React

**Hooks:**
- Use functional components only (no class components)
- Declare hooks at top level, never conditionally
- Custom hooks: prefix with `use` (`useAuth`, `useLeague`)

**Props:**
- Define interfaces for component props
- Destructure props in function signature

**State:**
```typescript
const [page, setPage] = useState<Page>('leaderboard');
```

---

## Key Patterns

### Authentication Flow
1. User clicks "Sign in" → redirects to `/api/v1/auth/oauth/google`
2. Backend generates signed state, redirects to Google
3. Google redirects to `/api/v1/auth/oauth/google/callback`
4. Backend verifies state, exchanges code, finds/creates user, signs JWT
5. JWT set as HttpOnly cookie + returned in body
6. Frontend calls `/api/v1/auth/me` to hydrate user state

### Authorization Guards
```typescript
// In route handlers
requireAuth(request, reply);        // 401 if not logged in
requireSuperAdmin(request, reply);  // 403 if not admin
requireLeagueAdmin(request, reply); // 403 if not league admin
```

### Job Queue Pattern
```typescript
// Enqueue job
queue.enqueue('RESCORE_TASK', { taskId, leagueId, triggeredBySubmissionId });

// Worker picks up job, calls handler
async function handleRescoreTask(payload: RescoreTaskPayload, db: Database) {
  // Process...
}
```

### API Response Format
```typescript
// Success
reply.send({ user: { id, email, displayName } });

// Error
reply.status(404).send({
  error: { code: 'NOT_FOUND', message: 'User not found' }
});
```

---

## Environment Variables

See `.env.example` for all required variables. Key ones:
- `PORT` - Server port (default: 3000)
- `DB_PATH` - SQLite database path
- `NODE_ENV` - `production` or `development`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` - OAuth credentials
- `JWT_PRIVATE_KEY_PEM`, `JWT_PUBLIC_KEY_PEM` - RS256 key pair

---

## Development Workflow

### Running Locally

1. **Environment setup** (one-time):
   ```bash
   # Ensure Node.js 22 is active
   eval "$(fnm env)"
   
   # Create .env file
   cp .env.example .env
   # The .env file needs JWT keys - generate with:
   # openssl genrsa 2048  # for JWT_PRIVATE_KEY_PEM
   # openssl rsa -in <private_key> -pubout  # for JWT_PUBLIC_KEY_PEM
   ```

2. **Start development servers**:
   ```bash
   npm run dev
   # Backend:  http://localhost:3000
   # Frontend: http://localhost:5173 (Vite dev server)
   ```

3. **Access the site**: Open http://localhost:5173/ in your browser

### Important Environment Details

- **dotenv is required**: The project uses `dotenv` to load `.env` files. Both `server.ts` and `migrate.ts` have `import 'dotenv/config'` at the top.
- **Multi-line env vars**: JWT keys in `.env` must be quoted strings with literal newlines preserved
- **fnm must be active**: Run `eval "$(fnm env)"` in your shell before any npm commands
- **uv-managed Python**: The `.npmrc` file points to uv's Python installation for native module compilation

### Current State / Known Issues

- **Routes not implemented**: The `src/routes/` directory is empty. Route handlers are currently commented out in `server.ts`
- **Job worker disabled**: `bootstrapWorker()` is commented out because `TaskRepository` is not yet implemented
- **OAuth not configured**: Google OAuth requires real credentials; placeholder values in `.env` will not work for login
- **No health endpoint**: The API doesn't have a `/health` route yet

---

## Notes for Agents

- **Never commit `.env` or `.npmrc` files** - they contain secrets and local paths
- **Always use prepared statements** - never interpolate SQL
- **Run typechecks before committing** - use `npm run typecheck`
- **Backend uses CommonJS** (`module: "commonjs"`) - Frontend uses ESNext
- **No linter configured yet** - follow existing code style closely
- **No tests yet** - if adding features, consider adding Vitest
- **Cookie-first auth** - frontend relies on HttpOnly cookies, not localStorage
- **dotenv must be imported first** - Add `import 'dotenv/config';` as the first import in any new entry point files
