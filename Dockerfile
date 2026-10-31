# ---- 构建阶段 ----
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY . .
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm run build:worker

# ---- 运行阶段 ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

RUN apk add --no-cache ffmpeg samba-client tini util-linux

# 非 root 用户
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

COPY --from=builder /app/dist/worker.cjs ./worker.cjs
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY scripts/start-container.sh ./start-container.sh
RUN mkdir -p /data && chown nextjs:nodejs /data && chmod +x /app/start-container.sh
ENV DOWNLOAD_DATA_DIR=/data
USER nextjs

EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["/app/start-container.sh"]
