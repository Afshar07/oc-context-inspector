<!-- toolkit:sha256=2f7e8ef7eb62624488c480624be2198f5701f753e6be01a15c700af065dbf49f -->
# Engineering Conventions

- Preserve public behavior and contracts unless the task explicitly changes them.
- Prefer the simplest implementation that satisfies the acceptance criteria.
- Run targeted checks for the changed boundary and report what was not verified.

## Code style in this repo

- TypeScript ESM, strict. Relative imports use the `.js` suffix (`from "./types.js"`). `import type` for type-only imports.
- Naming: interfaces `I*`, enums `E*` (string enums, values are the persisted/RPC form), classes without prefix, constants `UPPER_SNAKE`. Types live in `src/types.ts` when shared across modules.
- Prefer `readonly` fields and `readonly T[]`. Optional record fields are added with conditional spreads (`...(x !== undefined && { x })`) so absent stays absent, never `undefined`-valued.
- Collaborators are injected through constructors or function parameters (store, clock, generate, lookups); no module-level singletons or global mocks.
- Comments are short doc comments on the *why* or on a non-obvious contract; no narration of what code does. Match the surrounding density.
- Validate untrusted input (plugin options, tool input, tool result) with narrowing helpers (`asNumber`, `asString`, `stringList`); fall back rather than throw.
- Do not add dependencies for what a few lines do. Peer-dependency and bundling limits are in `opencode-v2-platform.md`.

## Docs and data

- Keep the root `README.md` accurate for user-visible behavior (options, commands, record fields). Agent-facing rationale goes in `.ai/`.
- Changing a record or RPC field is a compatibility change: read `invariants.md` first.
- `package.json`/`package-lock.json` may carry unrelated local edits (the `@afshar7/toolkit` dependency that manages `.ai/`); preserve them and do not fold them into unrelated commits.
