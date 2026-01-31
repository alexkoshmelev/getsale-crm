# Production Dockerfile for frontend (Next.js).
# Build: docker build -f docker/frontend/Dockerfile ./frontend -t getsale-crm-frontend .
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Build-time env (NEXT_PUBLIC_* must be set at build for client bundle)
ARG NEXT_PUBLIC_API_URL=https://api.getsale.example
ARG NEXT_PUBLIC_WS_URL=wss://ws.getsale.example
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}
RUN npm run build

FROM node:18-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/next.config.js ./
EXPOSE 3000
CMD ["npm", "start", "--", "-p", "3000", "-H", "0.0.0.0"]
