# Production Dockerfile for frontend (Next.js).
# Uses standalone output for minimal image (no full node_modules in final stage).
# Build: docker build -f docker/frontend/Dockerfile ./frontend -t getsale-crm-frontend .
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Build-time env (NEXT_PUBLIC_* must be set at build for client bundle)
ARG NEXT_PUBLIC_API_URL=https://api-crm.getsale.ai
ARG NEXT_PUBLIC_WS_URL=wss://ws-crm.getsale.ai
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}
RUN npm run build

# Final stage: only standalone server + static + public (no full node_modules)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
