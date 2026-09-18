## Decisions Log

> No decisions logged yet. This file must be updated by the agent whenever a
> significant decision is made during a working session.

### Template Format

---

**Decision:** [What was decided]
**Date:** [YYYY-MM-DD]
**Context:** [Why this decision was needed]
**Rationale:** [Why this option was chosen]
**Alternatives Rejected:** [Other options considered and why they were not chosen]
**Security Implications:** [Any security impact of this decision]
**Impact:** [What this decision affects downstream]

---

### Entries

- 2026-09-18 — **Decision:** Adopt general-first `.claude/` agent infrastructure.
  **Context:** Blank repository, stack unknown.
  **Rationale:** A stack-agnostic scaffold lets any agent orient and contribute
  immediately, then self-update files as real knowledge emerges.
  **Alternatives Rejected:** Stack-specific scaffold (premature — stack unknown).
  **Security Implications:** None yet; security standards will gate the first commit.
  **Impact:** All future sessions follow `HOW_TO_RESUME.md` + `AGENT_RULES.md`.

- 2026-09-18 — **Decision:** Enforce Conventional Commits for all commit messages.
  **Context:** User requested a proper, enforced commit message structure.
  **Rationale:** Conventional Commits is tooling-friendly (changelogs, semver,
  searchability) and stack-agnostic, fitting the general-first setup.
  **Alternatives Rejected:** Custom/free-form format (inconsistent, not machine-readable).
  **Security Implications:** None; commit subjects must still never contain secrets.
  **Impact:** `CODING_STANDARDS.md` defines the format; `AGENT_RULES.md` enforces it;
  `new_feature` / `new_endpoint` / `bug_fix` templates check it at completion.
