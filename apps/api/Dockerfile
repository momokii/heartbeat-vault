FROM node@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS base
WORKDIR /workspace
RUN corepack enable && apk add --no-cache tini=0.19.0-r3 2>/dev/null || apk add --no-cache tini

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @heartbeat-vault/crypto run build
RUN pnpm --filter @heartbeat-vault/db run build
RUN pnpm --filter @heartbeat-vault/api run build
RUN pnpm --filter @heartbeat-vault/api --prod deploy /deploy

FROM node@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS runtime
WORKDIR /app
RUN apk add --no-cache tini=0.19.0-r3 2>/dev/null || apk add --no-cache tini
COPY --from=build --chown=node:node /deploy ./
COPY --from=build --chown=node:node /workspace/apps/api/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod 500 ./docker-entrypoint.sh
USER node
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--", "./docker-entrypoint.sh"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "import('node:http').then(({request})=>{const r=request({hostname:'127.0.0.1',port:process.env.PORT||3000,path:'/api/health',timeout:2000},res=>process.exit(res.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end();})"
