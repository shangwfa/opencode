# Connector engine source (vendored in-tree)

This package embeds the **open-connector** engine source directly instead of depending on the
`@oomol-lab/open-connector` npm package. The engine lives under `src/engine/`; our adapter layer
lives under `src/adapter/` (see its README), and the engine's runtime data lives in `../../assets/`.

## Origin

- Upstream repository: <https://github.com/oomol-lab/open-connector>
- Synced commit: `01421f77600734d740d36eb463aa3bb456d55c5e` (2026-10-09, "fix: validate action examples during fix-check (#695)")

## Layout

Engine source imported from upstream `src/` (runtime-required subset only), vendored under
`src/engine/` with the internal relative imports kept untouched:

| Path                     | Contents                                                        |
| ------------------------ | --------------------------------------------------------------- |
| `src/engine/core/`              | Shared engine primitives and shared types                       |
| `src/engine/providers/`         | Provider implementations + `registry.generated.ts` (6.3k files) |
| `src/engine/server/`            | Headless runtime (`connector-runtime.ts`), api, secrets, storage, files, actions, proxy |
| `src/engine/oauth/`, `src/engine/mail/`, `src/engine/marketplace/`, `src/engine/saas/`, `src/engine/triggers/` | Engine feature modules |
| `src/engine/catalog-store.ts`, `src/engine/catalog-index.ts`, `src/engine/catalog-lazy-schemas.ts`, `src/engine/connection-service.ts`, `src/engine/mcp.ts` | Root-level engine modules |

Excluded from the import: `web/` (frontend), build scripts, `*.test.ts` (upstream tests are not
kept; this package's own tests live in `test/`), and Cloudflare/workerd-specific code.

Runtime assets (in `packages/connector/assets/`, resolved via `import.meta.dirname` in
`src/engine/server/connector-assets.ts` — never an absolute path):

- `assets/catalog/` — generated provider catalog (1604 app JSONs + `apps-index.json`)
- `assets/migrations/` — PostgreSQL engine migrations (applied by `src/adapter/migrate.ts`)

## Why in-tree

- The engine is a core, actively-patched dependency of the SaaS offering; we need to audit,
  debug, and hotfix it without waiting for upstream npm releases.
- No private-registry dependency: the deployment build only needs this repository.
- Runtime assets (catalog JSONs, SQL migrations) must ship with the package and be locatable
  from source (`import.meta.dirname`), which an npm dependency made fragile.

## Sync / upgrade procedure

1. In a checkout of the upstream repo, note the target commit:
   `git -C ~/code/open-connector rev-parse HEAD`.
2. Diff the runtime-required paths against this package
   (`src/engine/{core,providers,server,oauth,mail,marketplace,saas,triggers}/`, the root-level
   engine files above, `catalog`, `migrations`) and port the changes; keep the exclusions
   (web/, build scripts, `*.test.ts`, cloudflare) intact.
3. Regenerate/copy `assets/catalog` and `assets/migrations` if upstream changed them.
4. Update the "Synced commit" line in this README.
5. Verify: `cd packages/connector && bun run typecheck && bun test` (baseline: 73 passing) and
   `bun packages/connector/e2e/migrate.ts <pg-url>` against a scratch schema.
