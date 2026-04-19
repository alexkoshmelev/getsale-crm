# Docker images

## Backend stack (active)

- **Backend services:** build with [`services/Dockerfile.template`](../services/Dockerfile.template) and `--build-arg SERVICE=<name>` (see [.github/workflows/deploy.yml](../.github/workflows/deploy.yml)).
- **Frontend:** [`docker/frontend/Dockerfile`](frontend/Dockerfile) — context `./frontend`.
- **Migrations:** [`docker/migrations/Dockerfile`](migrations/Dockerfile) — context **repository root** (see `docker/migrations/Dockerfile`).
- **Local dev:** [`docker-compose.yml`](../docker-compose.yml).
- **Production server:** [`docker-compose.server.yml`](../docker-compose.server.yml) — log rotation (`x-logging`), Postgres on loopback only (`127.0.0.1:5435`), pinned PgBouncer image; remote DB access: [DEPLOYMENT.md](../docs/operations/DEPLOYMENT.md) (SSH tunnel / firewall).

Legacy v1 multi-service `Dockerfile.service` / `docker-compose.yml` have been removed.
