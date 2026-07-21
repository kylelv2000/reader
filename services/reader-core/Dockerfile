# syntax=docker/dockerfile:1.7
FROM rust:1-bookworm AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install cargo-auditable --version 0.7.5 --locked
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY .cargo ./.cargo
COPY src ./src
COPY tests ./tests
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo auditable build --release --locked \
    && cp /src/target/release/yomu-reader-core /tmp/yomu-reader-core

FROM builder AS test
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo test --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libsqlite3-0 tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --home-dir /app reader
WORKDIR /app
COPY --from=builder /tmp/yomu-reader-core /app/yomu-reader-core
COPY --from=builder /src/src/storage/db/migrations /app/migrations
RUN mkdir -p /app/storage/assets && chown -R reader:reader /app/storage
ENV SERVER_HOST=0.0.0.0 SERVER_PORT=18080 \
    DATABASE_URL=sqlite:/app/storage/reader.db?mode=rwc \
    STORAGE_DIR=/app/storage ASSETS_DIR=/app/storage/assets \
    MIGRATIONS_DIR=/app/migrations \
    LOG_LEVEL=info REQUEST_TIMEOUT_SECS=45
EXPOSE 18080
VOLUME ["/app/storage"]
USER reader
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 CMD curl -fsS http://127.0.0.1:18080/health >/dev/null || exit 1
CMD ["/app/yomu-reader-core"]
