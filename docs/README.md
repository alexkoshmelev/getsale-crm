# Documentation

Most documents under `docs/` were written for the older service layout (`services/*`, Express). They may reference removed paths — use the codebase under `services/` and [`README.md`](../README.md) as the source of truth.

**Current stack**

- API: `services/gateway` (proxies to backend services).
- Deploy: [`docker-compose.server.yml`](../docker-compose.server.yml); env template: [`.env.example`](../.env.example) (раздел production server).
- CI: [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

**Still useful**

- [`operations/`](operations/) — getting started and deployment notes (verify paths against the repo).
- [`architecture/`](architecture/) — high-level concepts.
