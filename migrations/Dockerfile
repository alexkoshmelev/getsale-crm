FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy migration files and necessary config files
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
