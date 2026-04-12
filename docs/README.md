# Documentation

Most documents under `docs/` were written for the older service layout (`services/*`, Express). They may reference removed paths — use the codebase under `services-v2/` and [`README.md`](../README.md) as the source of truth.

**Current stack**

- API: `services-v2/gateway` (proxies to other v2 services).
- Deploy: [`docker-compose.server.v2.yml`](../docker-compose.server.v2.yml); env template: [`.env.example`](../.env.example) (раздел production server).
- CI: [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

**Still useful**

- [`operations/`](operations/) — getting started and deployment notes (verify paths against v2).
- [`architecture/`](architecture/) — high-level concepts.
