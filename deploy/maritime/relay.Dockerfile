# The relay as a hosted container. Its coins, spent-proofs and mint keys live under /data,
# which survives restarts and redeploys. Built from a staged copy of the repo (see stage.sh).
FROM node:24-slim
RUN npm install -g pnpm@12.4.1
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ENV RELAY_HOST=0.0.0.0 RELAY_DATA_DIR=/data/relay
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "legacy/relay/src/main.ts"]
