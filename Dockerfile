# The CromDB Server image: one server, its data in the /data volume, serving
# on port 8080. docker/README.md is the guide.
#
#   docker build -t cromdb-server .
#
# The version below is @cromdb/server's; a test keeps the two the same.

ARG NODE_IMAGE=node:24-trixie-slim

# ---------------------------------------------------------------------------
# Build: every package's dependencies, then the engine, the drivers, the admin
# UI and the server.

FROM ${NODE_IMAGE} AS build
WORKDIR /cromdb

# The package files first, so this layer is reused until the lockfile or a
# package's dependencies change. No install scripts run: better-sqlite3 has
# its compiled binaries in its npm package.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/driver/package.json packages/driver/
COPY packages/driver-level-4/package.json packages/driver-level-4/
COPY packages/admin-ui/package.json packages/admin-ui/
COPY packages/server/package.json packages/server/
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY packages packages
RUN npm run build

# ---------------------------------------------------------------------------
# Run: the production dependencies only, and what the build made.

FROM ${NODE_IMAGE}
ARG VERSION=0.2.0
LABEL org.opencontainers.image.title="CromDB Server" \
      org.opencontainers.image.description="CromDB Server: serves CromDB databases to people over HTTP." \
      org.opencontainers.image.source="https://github.com/skaife/cromdb" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

ENV NODE_ENV=production
WORKDIR /opt/cromdb

COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/driver/package.json packages/driver/
COPY packages/driver-level-4/package.json packages/driver-level-4/
COPY packages/admin-ui/package.json packages/admin-ui/
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /cromdb/packages/engine/dist packages/engine/dist
COPY --from=build /cromdb/packages/driver/dist packages/driver/dist
COPY --from=build /cromdb/packages/driver-level-4/dist packages/driver-level-4/dist
COPY --from=build /cromdb/packages/admin-ui/dist packages/admin-ui/dist
COPY --from=build /cromdb/packages/server/dist packages/server/dist
COPY LICENSE ./

RUN chmod 755 packages/server/dist/cli/main.js \
 && ln -s /opt/cromdb/packages/server/dist/cli/main.js /usr/local/bin/cromdb-server \
 && mkdir /data \
 && chown node:node /data

# CROMDB_RESTART_ON_EXIT: the Restart button exits, and the container's
# restart policy starts it again (docker/README.md, "Restart").
ENV CROMDB_DATA=/data \
    CROMDB_RESTART_ON_EXIT=1

USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["cromdb-server", "health"]

# Listen is fixed here, so a listen setting saved in the admin UI can't move
# the server off the container's port.
ENTRYPOINT ["cromdb-server"]
CMD ["run", "--listen", "0.0.0.0:8080"]
