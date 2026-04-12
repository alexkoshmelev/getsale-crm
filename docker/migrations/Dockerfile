# Migrations Dockerfile. Build context: repo root (works on Windows and in CI).
# Build: docker build -f docker/migrations/Dockerfile .
FROM node:22-alpine

WORKDIR /app

COPY migrations/package*.json ./
RUN npm install

COPY migrations/migrations/ ./migrations/
COPY migrations/seeds/ ./seeds/
COPY migrations/knexfile.ts ./
COPY migrations/run-migrations.ts ./
COPY migrations/tsconfig.json ./

# Run migrations
CMD ["npm", "run", "run"]
