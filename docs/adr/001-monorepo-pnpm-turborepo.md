# ADR 001: TypeScript monorepo with pnpm workspaces and Turborepo

- Status: Accepted
- Date: 2026-09-20
- Deciders: Phase 0 design review
- Sources: `docs/BRIEF.md` §7, `docs/DESIGN.md` §1

## Context

Brief §7 sets three hard requirements. Postgres is the primary database. The repo is a monorepo unless a better approach can be justified. Everything runs in Docker.

Brief §7 also gives a default to beat. Unless research justifies something else, use a TypeScript end to end monorepo with pnpm workspaces plus Turborepo, a typed API backend, React with Tailwind and shadcn/ui, a type safe ORM with migrations, and a Postgres backed job queue. Every significant choice gets an ADR.

Design §1 proposes exactly that default. A single TypeScript image runs two roles, api and scheduler-worker, with N replicas. Packages are `web`, `api` and `worker`, `db` for migrations, `crypto`, `channels`, and `e2e`. The hardened profile stays deferred, so the monorepo must keep the standard profile simple. The question is whether pnpm plus Turborepo is the right way to wire the monorepo at this scale.

Single household, single host is the v1 target. The repo will have fewer than ten packages in v1 and fewer than fifty even after growth. Build speed matters, but not at the cost of added ops or a second language.

## Decision

We will use pnpm workspaces with Turborepo 2.x at the repo root.

- `pnpm-workspace.yaml` defines workspaces. `apps/*` holds deployables, `packages/*` holds shared libraries.
- Internal deps use `workspace:*`. The root `package.json` is `private: true` and declares `packageManager: pnpm@10.x`. Corepack pins the version in CI and on dev machines.
- Catalogs provide a single version source for shared deps. `catalogMode: strict` means every package must pull shared deps through the catalog, so no drift.
- `turbo.json` uses `tasks`, not the deprecated `pipeline` key. Build tasks depend on `^build` so upstream packages build first. Lint and typecheck can depend on `^build` or run without it if they import source directly, that choice is left to each package.
- Shared TS and lint config lives in `packages/config/*` and is consumed with `extends`.

This matches Design §1 and satisfies Brief §7 without adding new infra.

## Alternatives considered

### Nx

Nx offers a rich plugin graph, affected analysis, and generators. It shines in large polyglot repos with many apps and custom executors. For fewer than ten TypeScript packages, the plugin system and daemon add weight we do not need. Nx also nudges teams toward its generator style for scaffolding, which would fight the plain Turborepo task model Design §1 assumes. We did not need its extra features to meet the single host v1 goal.

### Lerna (with or without Nx)

Lerna now runs in maintenance mode. Most teams that still list Lerna pair it with Nx or Turborepo and keep Lerna only for versioning. We have no publish step in v1, and when we do, `changesets` covers it. Lerna would add a tool for a job we do not have yet.

### npm workspaces or Yarn Classic

npm workspaces are simple and well known. They lack pnpm's content addressed store and strict isolation, so installs are slower and phantom deps are easier to miss. There is no catalog equivalent, so version drift across packages needs manual care. Yarn Classic has similar gaps and no built in task graph.

### Yarn Berry with PnP

Berry PnP is fast and strict, but PnP breaks some Node native addons. Argon2id hashing and other audited crypto bindings compile native code. Patching those for PnP adds toil with no clear win over pnpm's isolated `node_modules`.

### Rush

Rush targets very large enterprise monorepos with strict policy and phasing. It brings its own install and build orchestration that overlaps Turborepo. For a small team and a single host product, Rush is more process than we need.

## Rationale

We picked the lightest tool that still gives us three things we need.

First, correctness. pnpm's isolated `node_modules` means a package cannot import a dep it did not declare. That catches missing deps in CI instead of in prod. `workspace:*` links are symlinks at install time, so local changes are visible without a registry round trip.

Second, reproducibility. Catalogs plus `catalogMode: strict` give one line per shared dep version. `pnpm-lock.yaml` pins the tree. `packageManager` plus Corepack means CI uses the same pnpm as devs.

Third, speed without extra daemons. Turborepo caches task outputs on `outputs` and restores them on cache hit. That is enough for the v1 package count. We avoid a second build daemon and keep the mental model to one file, `turbo.json`.

Design §1 expects `db` migrations, `crypto` primitives, and `channels` to be importable as `@repo/*`. pnpm plus Turborepo does that with no extra publish step.

## Impacts

### Positive

- One install for the whole repo. Adding a package is a new entry in `pnpm-workspace.yaml` and a `workspace:*` dep, no registry publish.
- Cross package typechecking works out of the box. `web` can import `@repo/db` types, `api` can import `@repo/crypto`.
- Turborepo remote cache can be added later without changing the task graph.
- Small surface area for sibling tasks. T1.2 owns lint and typecheck config, T1.3 owns Docker, T2.2 owns crypto, none of them need to touch the workspace wiring.

### Negative and mitigations

- Teams must use pnpm, not npm or yarn, or the lockfile drifts. Mitigation is `packageManager` plus `corepack enable` in the install guide and CI.
- pnpm 10 and 11 block postinstall scripts by default. Some deps like `esbuild` need `allowBuilds`. That approval list lives in `pnpm-workspace.yaml`.
- Turborepo cache is only as good as `inputs` and `outputs`. Missing an output means a cache hit restores an empty `dist`. We declare outputs explicitly and exclude `! .next/cache/**` and `!**/*.md` as Design §1 notes.

### Follow on work

- T1.2 will land `turbo.json`, root `package.json` scripts that delegate to `turbo run`, and shared `tsconfig.base.json`.
- Later ADRs cover the ORM choice, Caddy as reverse proxy, the crypto suite, and the hardened profile. This ADR does not decide them.

## Security implications

- Strict isolation lowers the chance of pulling an undeclared transitive dep into a security sensitive package like `crypto`.
- `allowBuilds` makes postinstall code execution explicit and reviewable.
- Catalog strict mode prevents one package from pinning a newer but unvetted version of a shared dep while the rest stay on the audited version.
- Fewer tools in the path means less supply chain to audit. pnpm and Turborepo are both pinned and scanned by the same dependency and container scans Brief §9 requires.

## References

- `docs/BRIEF.md` §7 hard requirements and default stack
- `docs/BRIEF.md` §7.1 optional hardening services, standard profile must work with only app plus Postgres plus proxy
- `docs/DESIGN.md` §1 monorepo layout and package list
- `docs/DESIGN.md` §2 STRIDE control for supply chain, pinned deps and lockfiles
- `docs/research/2026-09-20-foundation-research.md` §1 pnpm plus Turborepo patterns and pitfalls
