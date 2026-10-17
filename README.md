# Hisaab

Split group expenses with friends: record who paid and how it's shared, see live balances, and settle up in as few transfers as possible.

Work in progress. See [CLAUDE.md](CLAUDE.md) for the architecture, phase plan and development commands, and [docs/AUDIT.md](docs/AUDIT.md) for the design rationale.

## Quick start

Requires Node 22 and Docker.

```sh
npm ci
docker compose up -d db
cp api/.env.example api/.env
npm run db:migrate
npm run dev:api    # http://localhost:8081/api/health
npm run dev:web    # http://localhost:5174
```
