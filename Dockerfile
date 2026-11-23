FROM node:24-bookworm-slim

ARG LOOKOUT_VERSION
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="Lookout" \
      org.opencontainers.image.source="https://github.com/WHNet-Org/lookout" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="$LOOKOUT_VERSION" \
      org.opencontainers.image.revision="$SOURCE_COMMIT"

WORKDIR /app
COPY package.json package-lock.json ./
RUN node -e 'const pkg = require("./package.json"); const lock = require("./package-lock.json"); if (pkg.version !== process.env.LOOKOUT_VERSION || lock.version !== pkg.version || lock.packages[""].version !== pkg.version) throw new Error("Image version must match the source manifests")' && \
    npm ci --omit=dev --engine-strict --no-audit --no-fund && \
    npm cache clean --force && \
    install -d -o node -g node /etc/lookout /var/lib/lookout
COPY src/ ./src/
COPY public/ ./public/
COPY migrations/ ./migrations/
COPY LICENSE ./

ENV NODE_ENV=production \
    LOOKOUT_HOST=0.0.0.0 \
    LOOKOUT_CONFIG=/etc/lookout/monitors.json \
    LOOKOUT_DB=/var/lib/lookout/lookout.sqlite \
    LOOKOUT_BUILD_SHA=$SOURCE_COMMIT
USER node
EXPOSE 8787
VOLUME ["/var/lib/lookout"]
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '8787') + '/healthz', { signal: AbortSignal.timeout(4000) }).then(r => { if (!r.ok) process.exitCode = 1 }).catch(() => { process.exitCode = 1 })"]
CMD ["node", "src/node.ts"]
