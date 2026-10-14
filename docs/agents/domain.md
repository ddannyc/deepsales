# Domain Docs

This repository has a single domain context despite its pnpm packages. Preserve the existing documentation layout.

## Before exploring

- Use `docs/architecture/CONTEXT.md`, especially its Domain Language section, for canonical domain vocabulary.
- Read relevant decisions in `docs/adr/` and the established `docs/architecture/TECHNICAL_DECISIONS.md`.
- Follow the authoritative document order in `AGENTS.md` before major implementation. New ADRs or next-version specifications do not silently replace the frozen Lean V1 baseline.
- If context or ADR documents are absent in another checkout, proceed silently. Create definitions or decisions lazily through domain modeling when a real term or decision is resolved.

## Layout

- Shared context: `docs/architecture/CONTEXT.md`.
- Individual ADRs: `docs/adr/<number>-<slug>.md`.
- Existing technical decision record: `docs/architecture/TECHNICAL_DECISIONS.md`.
- No root `CONTEXT-MAP.md` or per-package contexts are needed for this layout. Do not create a competing glossary or move the existing context as part of setup.

## Vocabulary and decisions

- Use the glossary's terms in specifications, issue titles, tests, and implementation discussions.
- If a term is missing, reconsider whether it belongs to the domain before adding it. Record resolved definitions in the existing Domain Language section; do not use the glossary as a specification or scratchpad.
- Add ADRs only for meaningful, hard-to-reverse trade-offs. Use sequential numbers and preserve existing decisions.
- Surface an ADR conflict explicitly, identify the conflicting decision, and resolve it rather than silently overriding it.
