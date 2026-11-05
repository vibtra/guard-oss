# Guard's server image: the registry, the web dashboard and the Guard contract, built from this checkout.
# Self-hosting recipe: docs/self-host.md. Base images are pinned by digest.
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @vibtra/guard-console build \
 && pnpm --filter @vibtra/landing build \
 && pnpm --filter @vibtra/registry typecheck \
 && test -f apps/guard-console/dist/index.html \
 && test -f packages/guard-contract/src/index.ts \
# The free core runs without the commercial ee/ directory; it is not shipped in this image.
 && rm -rf ee

FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
WORKDIR /app/apps/registry
RUN mkdir /data && chown node:node /data
COPY --from=build --chown=node:node /app /app
COPY --chown=node:node --chmod=755 apps/registry/docker-entrypoint.sh /usr/local/bin/guard-entrypoint
USER node
ENV NODE_ENV=production REGISTRY_MODE=hosted HOST=0.0.0.0 PORT=4700 VIBTRA_REGISTRY_DATA_DIR=/data
EXPOSE 4700
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4700)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["guard-entrypoint"]
CMD ["node_modules/.bin/tsx", "src/main.ts"]
