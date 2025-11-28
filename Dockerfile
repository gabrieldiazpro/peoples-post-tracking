# ==========================================
# Routz v4.0 - Dockerfile
# Production-ready multi-stage build
# ==========================================

# Stage 1: Dependencies
FROM node:20-alpine AS deps
WORKDIR /app

# Install dependencies for native modules
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Stage 2: Builder
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Build TypeScript if applicable
# RUN npm run build

# Stage 3: Runner
FROM node:20-alpine AS runner
WORKDIR /app

# Security: Non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 routz

# Copy necessary files
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/api ./api
COPY --from=builder /app/connectors ./connectors
COPY --from=builder /app/services ./services
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Change ownership
RUN chown -R routz:nodejs /app
USER routz

# Start application
CMD ["node", "api/server.js"]
