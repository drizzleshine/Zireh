# The Rust host as a hosted container. Its database lives under /data, which survives
# restarts and redeploys. Built from a staged copy of host/ (see stage.sh).
FROM rust:1.97-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY tests ./tests
RUN cargo build --release --locked

FROM debian:bookworm-slim
COPY --from=build /src/target/release/zireh-host /usr/local/bin/zireh-host
ENV HOST=0.0.0.0 PORT=8080 SYNC_DB=/data/sync/sync.db
EXPOSE 8080
CMD ["zireh-host"]
