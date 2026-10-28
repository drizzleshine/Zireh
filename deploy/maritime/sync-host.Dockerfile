# The sync host as a hosted container. It stores ciphertext only, in /data, which survives
# restarts and redeploys. Built from a staged copy of the repo (see stage.sh).
FROM node:24-slim
RUN npm install -g pnpm@12.4.1
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ENV SYNC_HOST_BIND=0.0.0.0 SYNC_DB=/data/sync/sync.db
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "legacy/sync-host/src/main.ts"]
