# kd-learn server image: the Nitro build of apps/web (UI, guest API, accounts) on Node.
# Node is pinned: the server driver is node:sqlite, still a release candidate in Node 26 (risk 28).
# ACP agents are not in the image (plan C3): run the server outside Docker to use them.
ARG NODE_IMAGE=node:26.13.1-slim

FROM ${NODE_IMAGE} AS build
ENV CI=1
RUN npm install --global pnpm@12.18.0 && npm cache clean --force
WORKDIR /repo
# Fetch packages from the lockfile alone, so a source change does not download them again.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm exec turbo build --filter=@kd-learn/web
# The server reads PDFs with pdfjs-dist's legacy build only (phase 4 A4): drop the rest (~20 MB).
RUN cd apps/web/.output/server/node_modules/pdfjs-dist \
    && rm -rf build web image_decoders types \
    && find . -name '*.map' -delete

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3000 \
    KD_LEARN_DB_PATH=/data/kd-learn.db
WORKDIR /app
# The build is self-contained: no node_modules at run time.
COPY --from=build --chown=node:node /repo/apps/web/.output ./.output
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
# GET /api/config also opens the DB and creates the first admin (plan step 8 notes).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/config').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", ".output/server/index.mjs"]
