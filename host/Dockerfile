# Self-hosted Monid test host (M1-M3): stock CLI wire + /v1/feedback + the
# feedback reranker, fixture/fake transports by default (no vendor calls).
#
#   docker build -f host/Dockerfile -t monid-host .
#   docker run --rm -p 8080:8080 -e MONID_HOST_API_KEY=monid_local_<secret> monid-host
#
# Build context = repo root (see host/.dockerignore notes in host/README.md).
FROM denoland/deno:2.9.7

WORKDIR /app
COPY . .
RUN rm -rf .output node_modules \
    && deno install --frozen=false \
    && deno cache host/main.ts \
    && mkdir -p /app/baked /data \
    && deno run --allow-read --allow-write --allow-env --allow-run=git host/bake.ts /app/baked/catalog.json \
    && chown -R deno:deno /data

ENV MONID_HOST_CATALOG=/app/baked/catalog.json \
    MONID_HOST_DB=/data/host.db \
    MONID_HOST_PORT=8080 \
    MONID_HOST_TRANSPORT=fixture

USER deno
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
    CMD deno eval "const r = await fetch('http://127.0.0.1:8080/healthz'); Deno.exit(r.ok ? 0 : 1)"
CMD ["run", "--allow-read", "--allow-write", "--allow-env", "--allow-net", "host/main.ts"]
