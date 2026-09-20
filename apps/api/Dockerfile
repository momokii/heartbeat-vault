# syntax=docker/dockerfile:1.7
# Heartbeat Vault — API placeholder image (Phase T1.3)
# Multi-stage, non-root, pinned digests. No app code yet — placeholder
# HTTP server on :3000 satisfies healthcheck and reverse-proxy wiring.
# TODO(Phase 3+): replace stub server with real build (pnpm workspace, tsc,
# drizzle migrations) and a proper health endpoint + graceful shutdown.

# ── Stage 1: base ───────────────────────────────────────────────────────────
FROM node@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS base
# Use least-privilege user from the official image (node, uid 1000).
# Do not run as root — enforced by USER directive below.
WORKDIR /app
# Install OS deps minimal; keep image lean. No additional packages.
RUN apk add --no-cache tini=0.19.0-r3 2>/dev/null || apk add --no-cache tini
# Placeholder stub server — intentionally tiny, no workspace build yet.
# Will be replaced with `COPY package.json` + `pnpm install` + `tsc` in Phase 3+.
COPY --chown=node:node <<'EOS' /app/server.mjs
// Placeholder API server — T1.3 only. Replace in Phase 3+.
// Serves GET /health (200) and GET / (200) for Caddy reverse_proxy wiring.
import { createServer } from "node:http";
const PORT = Number(process.env.PORT ?? 3000);
const server = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", placeholder: true }));
    return;
  }
  if (req.url === "/" || req.url === "/api") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "heartbeat-vault", status: "placeholder", todo: "Phase 3+ real API" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[placeholder] listening on :${PORT}`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
EOS

# ── Stage 2: runtime ───────────────────────────────────────────────────────
FROM base AS runtime
USER node
EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.mjs"]

# Healthcheck — lightweight, no curl dependency (uses Node itself).
# Interval/start-period tuned so `docker compose up --wait` succeeds quickly.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "import('node:http').then(({request})=>{const r=request({hostname:'127.0.0.1',port:process.env.PORT||3000,path:'/health',timeout:2000},res=>process.exit(res.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end();})"
