# Contributing to SkillHarbor

Thanks for helping improve SkillHarbor.

## Development

1. Use Node.js 18+.
2. `npm install`
3. Start API: `node server.cjs 8900`
4. Start UI: `npm run dev`
5. Before a PR: `npm run typecheck && npm test && npm run test:server`

Keep runtime data in `DATA_DIR` (default `./data`). It is gitignored.

## Pull requests

- Prefer small, focused changes with a clear problem statement.
- Do not add real employee data, production IPs, tokens, or webhooks.
- Demo seeds must stay anonymous (`server-seed-*.json`).
- Match existing TypeScript / React patterns; avoid drive-by refactors.

## Reporting security issues

Please follow [SECURITY.md](SECURITY.md) instead of opening a public issue for vulnerabilities.
