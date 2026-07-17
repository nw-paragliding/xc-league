# XC / Hike & Fly League Platform

A fullstack TypeScript application for paragliding and hike & fly competition scoring.

## Tech Stack

- **Backend**: Fastify + SQLite + TypeScript (CommonJS)
- **Frontend**: React + Vite + TypeScript (ESNext)
- **Database**: SQLite with WAL mode, better-sqlite3
- **Auth**: Google OAuth → JWT (RS256, HttpOnly cookies)
- **Scoring**: FAI S7F-derived GAP model, fully synchronous — shared pipeline code runs on
  both server (authoritative) and client (upload preview); see
  [src/shared/SCORING.md](./src/shared/SCORING.md)

## Quick Start

### Prerequisites

- Node.js >=22 (managed with `fnm`)
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

# Create frontend/.env for map API keys (see "Frontend map keys" below)
cp frontend/.env.example frontend/.env
```

### Frontend map keys (MapTiler, OpenAIP)

The task map uses [MapTiler](https://cloud.maptiler.com/account/keys/) for basemaps
(Outdoor terrain + Satellite hybrid) and [OpenAIP](https://www.openaip.net/) for the
airspace overlay. Both are free tiers; sign up and create a key in each dashboard.

Paste the keys into `frontend/.env`:

```
VITE_MAPTILER_KEY=...
VITE_OPENAIP_KEY=...
```

**Recommended**: in the MapTiler dashboard, restrict the key to the allowed HTTP origins
`http://localhost:5173` and your production domain — Vite embeds the key in the client
bundle, so it's publicly visible, and origin restriction prevents scraping.

Without these, the map falls back to plain OpenStreetMap tiles and the Airspace toggle is hidden.

### Google OAuth Setup

This project uses Google OAuth for authentication. The OAuth client is managed under **admin@nwparagliding.com**.

**For Local Development:**

1. Obtain the local-dev OAuth client ID and secret from admin@nwparagliding.com — never
   commit them (`.env` is gitignored; `.env.example` carries placeholders only). The
   authorized redirect URI for local dev is
   `http://localhost:3000/api/v1/auth/oauth/google/callback`.

2. Put the values in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (see `.env.example`).

3. **To test login:**
   - Start the dev server: `npm run dev`
   - Visit http://localhost:5173/
   - Click "Sign in" and authenticate with any Google account

**For Production Deployment:**

Contact admin@nwparagliding.com to:
- Add production redirect URIs to the OAuth client
- Get production environment credentials
- Configure authorized domains

**Managing OAuth Settings:**

Access the Google Cloud Console with admin@nwparagliding.com:
- Console: https://console.cloud.google.com/apis/credentials
- Project: (TBD - check with admin@nwparagliding.com)
- OAuth 2.0 Client ID: `861900491662-msd4hraiu4dqre5f3ktgpopc4j1gc8pg`

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
│   ├── server.ts          # Fastify entry point (migrations + boot rescore sweep)
│   ├── auth.ts            # JWT + OAuth middleware
│   ├── shared/            # Code shared with the frontend (preview parity)
│   │   ├── pipeline.ts    # IGC processing pipeline
│   │   ├── task-engine.ts # Geometry + GAP scoring formulas
│   │   └── SCORING.md     # The league's scoring model
│   ├── job-queue.ts       # Queue infra + rebuildTaskResults (scoring rebuild)
│   ├── upload.ts          # IGC upload handler
│   ├── reprocess.ts       # Boot-time reprocess of stale tracks (SCORER_VERSION)
│   ├── task-parsers.ts    # .xctsk / .cup import
│   ├── task-exporters.ts  # .xctsk / .cup export + QR codes
│   ├── schema.sql         # Database schema
│   ├── migrations/        # Numbered SQL migrations
│   └── routes/            # API route handlers
├── frontend/              # React frontend
│   ├── src/
│   │   ├── main.tsx       # React entry point
│   │   ├── App.tsx        # Root component
│   │   ├── api/           # API client functions
│   │   ├── lib/           # previewPipeline (client-side scoring preview)
│   │   ├── hooks/         # React hooks
│   │   └── pages/         # Page components
│   └── vite.config.ts
├── docs/                  # Architecture documentation
└── AGENTS.md              # Coding agent guidelines

```

## Features

- Multi-league / multi-season platform with Google OAuth and role-based admin
- Task management: .xctsk / .cup import, export, and QR codes (XCTrack-compatible)
- IGC upload with full GAP scoring: FAI S7F §12.2 time points, §11 goal-ratio
  distance/time split, landing detection, direction-agnostic start crossings,
  crossing-order enforcement (see [src/shared/SCORING.md](./src/shared/SCORING.md))
- Client-side upload preview running the same shared pipeline the server scores with
- Hike & fly seasons with ground-only turnpoints (`[GND]` prefix)
- Live leaderboards and season standings; scores rebuild on every submission while a
  task is open, tracks reprocess automatically when the scorer version changes

## Deployment

Production runs on Fly.io. Pushing to `main` triggers `.github/workflows/deploy.yml`,
which runs CI and then `flyctl deploy --remote-only`.

### Build-time secrets

Vite env vars (`VITE_*`) are compiled into the frontend bundle at build time, so they
must be passed as Docker build-args rather than Fly runtime secrets. The Deploy workflow
reads these as GitHub Actions secrets and forwards them:

| Secret | Purpose |
|---|---|
| `FLY_API_TOKEN` | Auth for `flyctl` |
| `VITE_MAPTILER_KEY` | MapTiler basemap key |
| `VITE_OPENAIP_KEY` | OpenAIP airspace overlay key |

Set a secret via the CLI: `gh secret set VITE_MAPTILER_KEY` (paste value when prompted),
or from the repo **Settings → Secrets and variables → Actions** page.

### Rotating a map key

1. Generate a new key in the MapTiler / OpenAIP dashboard.
2. `gh secret set VITE_MAPTILER_KEY` (or `VITE_OPENAIP_KEY`).
3. Push any commit to `main` to trigger a redeploy.
4. Revoke the old key in the dashboard.

### Manual deploy

```bash
fly deploy --remote-only \
  --build-arg VITE_MAPTILER_KEY="$VITE_MAPTILER_KEY" \
  --build-arg VITE_OPENAIP_KEY="$VITE_OPENAIP_KEY"
```

## Documentation

- [src/shared/SCORING.md](./src/shared/SCORING.md) — the league's scoring model (formulas,
  deliberate deviations from FAI S7F, rescoring lifecycle)
- [docs/backend-architecture.md](./docs/backend-architecture.md) — backend architecture
- [AGENTS.md](./AGENTS.md) — coding guidelines and architecture notes for agents
- [src/api-spec.ts](./src/api-spec.ts) — REST API specification

## License

Private / Proprietary
