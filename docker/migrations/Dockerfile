# Migrations Dockerfile. Build context: ./migrations (see deploy.yml).
# Build: docker build -f docker/migrations/Dockerfile ./migrations
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY migrations/ ./migrations/
COPY seeds/ ./seeds/
COPY knexfile.ts ./
COPY run-migrations.ts ./
COPY tsconfig.json ./

# Clean up any old node-pg-migrate files (if they exist)
RUN find ./migrations -name "001_*.ts" -type f -delete 2>/dev/null || true
RUN find ./migrations -name "*_initial_schema.ts" ! -name "20241225*" -type f -delete 2>/dev/null || true

# Run migrations
CMD ["npm", "run", "run"]
