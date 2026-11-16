FROM aquasec/trivy:0.76.2 AS trivy

FROM node:26-alpine

RUN apk add --no-cache git

# Helm from the official release (Alpine's package lags a major version behind). Checksums are
# pinned here, not fetched next to the tarball, so a tampered download server can't swap both.
ARG HELM_VERSION=4.3.2
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) sha=d1c0278d46beab79582d7e50f5b3dc206944ba8e577cde618513fd07daa53983 ;; \
      arm64) sha=df31cb61680ef728f82c770e5280dd565617bee6b039d37e85c677288be4bbb0 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && wget -qO /tmp/helm.tgz "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" \
 && echo "$sha  /tmp/helm.tgz" | sha256sum -c - \
 && tar -xzf /tmp/helm.tgz -C /usr/local/bin --strip-components=1 "linux-${TARGETARCH}/helm" \
 && rm /tmp/helm.tgz
# Pinned to the same version as the `trivy` compose service — client/server versions must match.
COPY --from=trivy /usr/local/bin/trivy /usr/local/bin/trivy

# Same version as `packageManager` in package.json
RUN npm install -g pnpm@11.28.12

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @chart-monitor/shared run build
# The backend serves the built UI from packages/frontend/dist (same origin as the API)
RUN pnpm --filter @chart-monitor/frontend run build

ENV DATABASE_URL=file:/data/chart-monitor.db
VOLUME /data
RUN pnpm --filter @chart-monitor/backend run db:generate
RUN pnpm --filter @chart-monitor/backend run build

EXPOSE 3000
ENTRYPOINT ["sh", "/app/packages/backend/docker-entrypoint.sh"]
CMD ["sh", "-c", "pnpm --filter @chart-monitor/backend run db:deploy && exec node packages/backend/dist/index.js"]
