# Docker images

## v2 stack (active)

- **Backend services:** build with [`services-v2/Dockerfile.template`](../services-v2/Dockerfile.template) and `--build-arg SERVICE=<name>` (see [.github/workflows/deploy.yml](../.github/workflows/deploy.yml)).
- **Frontend:** [`frontend/Dockerfile`](frontend/Dockerfile) — context `./frontend`.
- **Migrations:** [`migrations/Dockerfile`](migrations/Dockerfile) — context **repository root** (see `docker/migrations/Dockerfile`).
- **Local dev:** [`docker-compose.v2.yml`](../docker-compose.v2.yml).
- **Production server:** [`docker-compose.server.v2.yml`](../docker-compose.server.v2.yml).

Legacy v1 multi-service `Dockerfile.service` / `docker-compose.yml` have been removed.
