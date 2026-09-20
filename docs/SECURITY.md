# Security

This doc will explain how stored data is protected, what the system does and does not defend against, and how to check a deployment. The normative threat model summary and control map are in `docs/DESIGN.md` §2, with the full STRIDE plus OWASP ASVS map planned for `docs/THREAT_MODEL.md` in Phase 12.

Scope for now follows Brief §6 and Design §2, envelope encryption with per secret DEKs, Argon2id, AEAD, and the fail safe defaults for scheduler and delivery. No new crypto detail or claim is added here before the crypto and auth phases land. Check `docs/DESIGN.md` for the current security design.
