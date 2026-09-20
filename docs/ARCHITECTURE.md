# Architecture

This doc will describe the system as built, how the pieces fit, and how to run them. The full Phase 0 design lives in `docs/DESIGN.md` §§1-10. That file is the source for stack, data model, and deployment choices until this doc is filled in Phase 12.

Scope for now is the standard profile from Brief §§7 and 7.1 and Design §1, a TypeScript monorepo with Postgres as the source of truth and Postgres as the queue. No new detail is added here before the owning ADRs and implementation land.
