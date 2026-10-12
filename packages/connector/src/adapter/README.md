# Connector adapter layer

Our SaaS-side adapter around the vendored open-connector engine (`src/engine/`, see its README
for origin and sync procedure). This directory is the package's own code — everything here is
ours, everything under `src/engine/` is upstream.

## Modules

| File            | Contents                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `index.ts`      | Public entry point re-exporting the namespaces below (package export `.`)                          |
| `engine.ts`     | Effect service wrapping the headless engine runtime (lazy `import("../engine/server/connector-runtime.js")` keeps the engine graph out of the default startup path) |
| `connector.ts`  | Session-scoped connection/trigger/OAuth orchestration on top of the engine service                 |
| `migrate.ts`    | Applies the engine's bundled PostgreSQL migrations (advisory lock + `runtime_migrations` ledger)    |
| `crypto.ts`     | At-rest encryption for engine runtime tokens, wire-compatible with the upstream `enc:v1:` codec    |

The SaaS-side drizzle tables (connection/trigger/receipt/OAuth-ledger) live in
`@opencode/core` (`src/connector/sql.ts`) next to their stores, so they share core's
drizzle-orm resolution context and the core migration generator picks them up directly.

Consumers import through `@opencode/connector/adapter` or its subpaths; the package root `.`
resolves to `src/adapter/index.ts`.
