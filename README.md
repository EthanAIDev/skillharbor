# SkillHarbor

Self-hosted **AI tools & skills portal**: tool catalog, skill center integration, employee workbench (API tokens / quotas), and an admin console (review, publish, stats, users).

- Frontend: React 18 + TypeScript + Vite + Tailwind (HashRouter)
- Backend: zero-dependency Node.js (`server.cjs`, Node ≥ 18) with JSON file persistence
- Deploy: Docker (`node:20-alpine`) with a data volume for runtime state

## Quick start

```bash
npm install
node server.cjs 8900   # API + static host (seeds demo users on first run)
npm run dev            # Vite; /api is proxied to 127.0.0.1:8900
```

Production-style (serves `dist/`):

```bash
npm run build
npm start              # node server.cjs (default port 8900)
```

Copy [`.env.example`](.env.example) and set upstream URLs/tokens as needed.

### Demo accounts (first boot)

Seeded from `server-seed-users.json` when `DATA_DIR` is empty:

| User | Password | Role |
|------|----------|------|
| `admin` | `admin123` | admin |
| `alice` / `bob` | `123456` | user |

Change these passwords immediately after the first login.

## Features

- Tool library with upload → parse → review → publish / deploy
- Skill packages aligned with an optional Skill Gateway
- Workbench for per-user model tokens (via One-API or compatible gateway)
- Knowledge-base explorer (optional MxsDoc bridge)
- Admin: stats, review center, services, gateway logs, settings

## Architecture

```text
Browser (Vite / dist)
   └─ /api/*  →  server.cjs
                   ├─ JSON store under DATA_DIR
                   ├─ optional One-API proxy
                   ├─ optional Skill Gateway proxy
                   └─ optional Docker channel for service tools
```

## Docker

```bash
npm run build
docker build -t skillharbor:local .
docker run --rm -p 8900:8100 -v skillharbor-data:/app/data skillharbor:local
```

For user-upload isolation, serve uploads from a separate nginx origin using `files-nginx.conf` (see comments in that file).

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | TypeScript |
| `npm test` | Frontend Vitest suite |
| `npm run test:server` | Node test runners under `scripts/test-*.cjs` |

## Docs

User/operator guides live under [`docs/`](docs/). Skills samples under [`skills/`](skills/).

## Security

See [SECURITY.md](SECURITY.md). Do not commit `data/`, `.env`, or real credentials. Runtime secrets belong in the data volume or environment variables.

## License

[MIT](LICENSE) © SkillHarbor Contributors
