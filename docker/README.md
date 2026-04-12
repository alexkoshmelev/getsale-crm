# Docker images

## Backend stack (active)

- **Backend services:** build with [`services/Dockerfile.template`](../services/Dockerfile.template) and `--build-arg SERVICE=<name>` (see [.github/workflows/deploy.yml](../.github/workflows/deploy.yml)).
- **Frontend:** [`frontend/Dockerfile`](frontend/Dockerfile) — context `./frontend`.
- **Migrations:** [`migrations/Dockerfile`](migrations/Dockerfile) — context **repository root** (see `docker/migrations/Dockerfile`).
- **Local dev:** [`docker-compose.yml`](../docker-compose.yml).
- **Production server:** [`docker-compose.server.yml`](../docker-compose.server.yml).

Legacy v1 multi-service `Dockerfile.service` / `docker-compose.yml` have been removed.
