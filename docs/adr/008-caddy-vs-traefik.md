# ADR 008: Reverse proxy, Caddy candidate vs Traefik alternative

- Status: Accepted as direction, implementation DEFERRED (ADR only, zero runtime code)
- Date: 2026-09-20
- Deciders: Phase 0 design review
- Sources: `docs/BRIEF.md` §7, §7.1, §10, §11, `docs/DESIGN.md` §§1-2, `docs/research/2026-09-20-foundation-research.md` §3

> DEFERRED: This ADR records direction only. The Caddy service already in `docker-compose.yml` and `Caddyfile` from T1.3 is the standard profile baseline for single host deploys. No new proxy service, no Dockerfile change, no Traefik dep ships in this change. Full TLS option docs and hardened wiring land later. Lint guard for vault imports is unrelated to this ADR but ships in the same wave.

## Context

Brief §7 requires everything Docker based, and Brief §§10 and 11 require a reverse proxy with automatic TLS that offers self signed or internal CA for LAN and on premise, plus Let us Encrypt and bring your own cert, plus companion commands for upgrade, backup, and restore. Design §1 picks Caddy as that proxy. A TypeScript image runs two roles, api and scheduler worker, with N replicas, behind Caddy on a shared Compose network. Only Caddy publishes 80 and 443. `tls internal` covers LAN, LE or BYO covers public hostnames. Persisted volumes `caddy_data` and `caddy_config` avoid rate limit lockout, and a header snippet adds HSTS, CSP, and related hardening.

The project must also evaluate Traefik as the alternative, per the ADR list in Design §9 and research §3. Traefik is the strongest alternative where dynamic service discovery and middleware chains at scale matter. The decision must weigh security benefit, threat model impact, and operational cost, per Brief §7.1 §5, even though the proxy choice is relevant to both standard and hardened profiles.

Constraints shape the choice.

- Single household, single host is the v1 target, per `docs/PROGRESS.md` key decisions. Expected service count is three in the standard profile, app plus Postgres plus proxy. Config is static, not a fleet of ephemeral backends.
- TLS must work on LAN without a public domain. Many on premise deploys have no public DNS, so `tls internal` with an internal CA is a real requirement, not a nice to have.
- Operational cost must stay low. One file, one binary, zero certbot cron, and a reload that does not drop connections are worth more than a rich dashboard at this scale.

## Decision

Caddy 2.11 plus, Alpine variant, is the candidate reverse proxy for both standard and hardened profiles. Traefik is the documented alternative for deployments that outgrow static config and need dynamic routing at scale.

The direction keeps the T1.3 baseline, but this ADR makes the choice explicit and deferred.

- Standard profile stays as shipped in T1.3: `caddy:2-alpine` pinned by digest, `Caddyfile` with `tls internal` LAN default, automatic LE when a public name is set, BYO via mounted certs, security headers, `reverse_proxy api:3000` over the internal `edge` network, and healthchecks.
- Implementation beyond the baseline is deferred. Wildcard DNS 01 via Cloudflare, `xcaddy` custom image, and hardened profile TLS wiring are design only until the proxy work is explicitly unblocked. No `traefik` image, no Traefik Compose service, no extra network is added now.

## How Caddy meets the brief (deferred extensions noted)

### Automatic TLS plus `tls internal` LAN plus LE and BYO

- Automatic TLS is the core win from research §3. Caddy obtains and renews Let us Encrypt certs via HTTP 01 without a cron, keeps them in `caddy_data`, and serves them with HTTP 3 ready. Closing port 80 after setup would break renewal, and deleting `caddy_data` would hit the LE 5 per hostname per week limit, so both are documented as ops must not items.
- `tls internal` gives LAN TLS without a public CA. `Caddyfile` can default to `tls internal` for bare LAN hostnames and flip to public ACME when `ACME_EMAIL` and a public `VAULT_HOST` are set. This matches Brief §11 reverse proxy with automatic TLS and the on premise friendly rule.
- LE via HTTP 01 is the default public path, with staging CA for testing. Bring your own is a bind mount of cert and key plus a `tls /etc/caddy/certs/...` stanza. Both would be installer options, not code branches.
- Defer note: DNS 01 wildcard via Cloudflare provider would need an `xcaddy` build with `caddy-dns/cloudflare`. That is the hardened variant for wildcard certs, and it stays design only in this ADR.

### Config shape and reload

- One Caddyfile block per host, snippets for security headers, `encode gzip zstd`, `reverse_proxy api:3000` via Docker DNS, never `localhost` inside the container. `admin 127.0.0.1:2019` only, no public admin.
- Directory mount `./caddy:/etc/caddy` over single file mount, so `docker compose exec -w /etc/caddy caddy caddy reload` is atomic and connection draining, not inode breaking. This is the pitfall noted in research §3.
- Single shared `edge` network. Every service that Caddy dials must join it, otherwise `dial tcp lookup api no such host`.

### Traefik alternative and when it wins

Traefik shines when routing is dynamic and discovery driven. Label based config, automatic service discovery via Docker provider, middleware chains for auth and rate limit, and a dashboard for many backends. At tens of services, canary, or per route plugin needs, Traefik is the better tool.

For Heartbeat Vault v1, Traefik adds weight without a matching need. Service count is static, middleware is a few header and TLS stanzas, and discovery is one `reverse_proxy` target. Traefik needs more config surface, its automatic TLS still needs storage and challenge wiring, and LAN `tls internal` style single line internal CA is not its sweet spot. The after picture for a household host would be more moving parts for the same outcome.

Keeping Traefik as the documented alt means a future scale decision can adopt it without revisiting the whole design. The Caddyfile would map to Traefik routers and entry points, and the `edge` network plus least privilege publish ports model would stay the same.

### Operational cost comparison

| Axis | Caddy 2.11 Alpine (candidate) | Traefik (alternative, dynamic scale) |
| --- | --- | --- |
| Idle footprint | About 15 MB, one static binary, zero cron | Larger, plus providers and dashboard to reason about |
| TLS ops | Automatic LE plus one line `tls internal`, persisted `caddy_data`, no certbot | Automatic LE as well, but needs `certificatesResolvers` plus storage config, and LAN internal CA is more manual |
| Config | One `Caddyfile` with snippets, Caddyfile first docs, easy to audit | Label or file provider plus entryPoints plus routers plus middlewares, more concepts for a static topology |
| Reload | `caddy reload` atomic, connection draining | Dynamic provider hot reload, strong for ephemeral backends, not needed for 3 services |
| When it wins | Single host, static topology, on premise LAN, fast to operate and to verify | Many services, ephemeral backends, label driven discovery, rich middleware at edge |

## Alternatives considered

### Traefik as default

This would future proof for a larger fleet and give a dashboard and access logs for routing. The cost is higher config surface and more to harden for a v1 that has one public backend. If the product ever grows to a fleet of per tenant or per channel workers with dynamic discovery, reconsider.

### Nginx plus certbot sidecar

Nginx plus certbot is battle tested and has endless examples. The downside is manual renewal plumbing, extra sidecar or cron, and more TLS footguns like HSTS and cipher config that Caddy already handles with safe defaults. Nginx still wins where raw perf tuning or Lua or `njs` at edge matters, not the case here.

### No proxy, app serves TLS directly

The app could terminate TLS with Node or Bun. That would remove a service. The gap is header hardening, rate limit at edge, and cert automation, all of which the brief pushes to the proxy. Keeping TLS in Caddy leaves the app as a plain `expose: ["3000"]` service with no host ports, which is simpler to review in `scripts/verify-security.sh`.

### Cloud LB or tunnel

A cloud load balancer or tunnel would give instant TLS, but Brief §7.1 says on premise friendly with no mandatory cloud or SaaS. Tying the dead man host to an outside tunnel adds a network dep on the trigger notification path, which fights the fail safe posture in Design §2.

## Rationale

We stayed with Caddy for three reasons that trace to the brief.

First, it meets Brief §§10 and 11 with the least operational cost. Automatic TLS, `tls internal` for LAN, LE for public, and BYO via mounts cover every TLS option the installer must offer, without a cron or custom renewal code. That keeps the single host story honest.

Second, it fits the architecture already in Design §1 and research §3. Two roles behind one proxy, one shared network, one `Caddyfile`, persisted cert data. The T1.3 Compose wiring already validates, `docker compose config` passes for base and prod, and `caddy_data` persistence plus port 80 staying open are the only ops items that need docs.

Third, Traefik does not pay for itself at this scale. Its strength is dynamic scale and label driven discovery, but v1 is static. Documenting Traefik as the alt for that future scale keeps the door open without paying the cost now. The hardened profile does not change this choice, OpenBao sits behind the app, not behind the proxy, and the proxy spec stays the same.

## Impacts

### Positive

- One `Caddyfile` to audit for TLS, headers, and routing, with `verify-security.sh` able to check HSTS, CSP, `X-Frame-Options`, and that only Caddy publishes host ports.
- Zero cron, zero certbot, same image for LAN and public, flipped by one stanza. Installer can generate a LAN CA or use LE without a second code path.
- `docker compose exec caddy caddy reload` stays atomic via directory mount, so config changes do not drop existing connections.

### Negative and mitigations

- Caddy 2 Alpine is still a single image to pin and scan. Mitigation is digest pinned image in `docker-compose.yml` plus Trivy or Grype in CI.
- Wildcard DNS 01 needs a custom `xcaddy` build. Mitigation is defer, most household LAN deploys do not need it, and the staging CA can validate LE before prod.
- If the deploy grows to many ephemeral backends, Caddy snippets will start to repeat. Mitigation is the Traefik alt, which can be adopted with the same `edge` network and least privilege port model.

### Follow on work (all deferred, none in this change)

- Installer TLS choice plumbing for `self signed or internal CA` vs `LE` vs `BYO`, writing `Caddyfile` from a template and persisting `caddy_data`.
- Hardened profile docs for TLS at the OpenBao service, still behind Caddy.
- Verification script checks for TLS and headers for both `tls internal` and public ACME, plus that no host port beyond Caddy is published.
- Optional `xcaddy` image for DNS 01 Cloudflare provider if wildcard is needed.

## Security implications

- Threat model per `docs/DESIGN.md` §2. Caddy is the only public edge. Hardening there covers Information disclosure and Elevation of privilege at the boundary. Headers like `Strict-Transport-Security` with `preload`, `X-Content-Type-Options nosniff`, `X-Frame-Options DENY`, `Referrer-Policy`, and stripped `Server` are the STRIDE controls at the proxy layer.
- Non root, capability minimal Caddy container, read only filesystem where possible, and `CAP_ADD NET_ADMIN` only as needed for HTTP 3 UDP sizing, verified by `scripts/verify-security.sh`.
- Persisting `caddy_data` and keeping port 80 open are availability controls. Losing certs or blocking HTTP 01 would cause renewal failure and downtime, which the fail safe posture in Design §2 wants to avoid.

## References

- `docs/BRIEF.md` §7 monorepo, Postgres, Docker, plus default TypeScript stack
- `docs/BRIEF.md` §7.1 optional hardening services, standard vs hardened, on premise friendly, no new SPOF on release path
- `docs/BRIEF.md` §10 TLS, headers, container hardening, DB not externally exposed
- `docs/BRIEF.md` §11 deployment, installer, reverse proxy with automatic TLS, BYO
- `docs/DESIGN.md` §1 standard profile with Caddy, `tls internal` for LAN plus LE or BYO for public, header snippet, `reverse_proxy api:3000`, Compose profiles
- `docs/DESIGN.md` §2 spoofing, tampering, information disclosure, denial of service controls that depend on TLS and headers at the edge
- `docs/research/2026-09-20-foundation-research.md` §3 Caddy 2.11 Alpine, automatic HTTPS, directory vs file mount, reload, `caddy_data` persistence, port 80 renewal, header snippet

---

*Implementation status: DEFERRED. This file records direction for the proxy choice. The T1.3 Caddy baseline remains the only runtime proxy in this wave. Full TLS option wiring lands later.*
