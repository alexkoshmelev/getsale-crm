# Migrations Dockerfile. Build context: repo root.
# Build: docker build -f docker/migrations/Dockerfile -t getsale-crm-migrations .
FROM node:18-alpine

WORKDIR /app

# Copy migrations package and config from repo root context
COPY migrations/package*.json ./
RUN npm install

COPY migrations/migrations/ ./migrations/
COPY migrations/seeds/ ./seeds/
COPY migrations/knexfile.ts ./
COPY migrations/run-migrations.ts ./
COPY migrations/tsconfig.json ./

# Clean up any old node-pg-migrate files (if they exist)
RUN find ./migrations -name "001_*.ts" -type f -delete 2>/dev/null || true
RUN find ./migrations -name "*_initial_schema.ts" ! -name "20241225*" -type f -delete 2>/dev/null || true

# Run migrations
CMD ["npm", "run", "run"]
