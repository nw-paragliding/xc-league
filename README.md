# XC / Hike & Fly League Platform

A fullstack TypeScript application for paragliding and hike & fly competition scoring.

## Tech Stack

- **Backend**: Fastify + SQLite + TypeScript (CommonJS)
- **Frontend**: React + Vite + TypeScript (ESNext)
- **Database**: SQLite with WAL mode, better-sqlite3
- **Auth**: Google OAuth → JWT (RS256, HttpOnly cookies)
- **Job Queue**: SQLite-backed queue with single-process worker

## Quick Start

### Prerequisites

- Node.js >=20 (managed with `fnm`)
- Python 3.8+ (managed with `uv` for native module compilation)

### Setup

```bash
# Install fnm (Fast Node Manager)
# See: https://github.com/Schniz/fnm

# Install uv (Python package manager)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install Python 3.12
uv python install 3.12

# Activate environment
eval "$(fnm env)"
source ~/.local/bin/env

# Install dependencies
npm install

# Create .npmrc from template and configure Python path
cp .npmrc.example .npmrc
# Edit .npmrc: python=$(uv python find 3.12)

# Create .env from template and add credentials
cp .env.example .env
# Edit .env with your OAuth credentials and JWT keys
```

### Development

```bash
npm run dev
```

- Backend: http://localhost:3000
- Frontend: http://localhost:5173

### Building

```bash
npm run build        # Build both frontend and backend
npm run typecheck    # Type check both projects
```

## Project Structure

```
/
├── src/                    # Backend TypeScript source
│   ├── server.ts          # Fastify entry point
│   ├── auth.ts            # JWT + OAuth middleware
│   ├── pipeline.ts        # IGC processing pipeline
│   ├── job-queue.ts       # Background job system
│   ├── schema.sql         # Database schema
│   └── routes/            # API route handlers
├── frontend/              # React frontend
│   ├── src/
│   │   ├── main.tsx       # React entry point
│   │   ├── App.tsx        # Root component
│   │   ├── api/           # API client functions
│   │   ├── hooks/         # React hooks
│   │   └── pages/         # Page components
│   └── vite.config.ts
└── AGENTS.md              # Coding agent guidelines

```

## Current Status

🚧 **Early Development** 🚧

- ✅ Database schema and migrations ready
- ✅ Authentication architecture implemented
- ✅ Frontend UI components complete
- ✅ IGC processing pipeline designed
- 🚧 API route handlers (not yet implemented)
- 🚧 Job worker (disabled until TaskRepository implemented)
- 🚧 OAuth integration (requires credentials)

## Documentation

- See [AGENTS.md](./AGENTS.md) for detailed coding guidelines and architecture notes
- See [src/api-spec.ts](./src/api-spec.ts) for REST API specification

## License

Private / Proprietary
