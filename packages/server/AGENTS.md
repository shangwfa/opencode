# Server Package Guide

`@opencode/server` wires the HTTP API: routes, middleware, handlers, and `ServerFetch`. Contracts come from `@opencode/protocol`; runtime services from `@opencode/core`.

## Handlers And Location Services

- Resolve Location-scoped services with `yield* X.Service` **inside the `handle` body**, where `sessionLocationMiddleware` provides the resolved Location graph. Resolving at group-build time reads the global application layer and fails for Location services.
- `routes.ts` `applicationServiceNodes` is global-only. Add Location-scoped nodes to `packages/core/src/instance.ts`, not there.

## Tests

- Server API tests use `ServerFetch.make({ database: { path: ":memory:" }, ... })` and drive the full route + middleware stack, so a handler that cannot resolve a Location service fails here; PostgreSQL-specific behavior needs a separate `OPENCODE_DATABASE_URL` test.
- The full suite has environment/order-dependent failures unrelated to code changes — OpenAI OAuth callback port cases and `routes pending requests through the Session's instance` in `test/fetch.test.ts`, plus canonical-plugin cases in `test/worktree.test.ts`. Confirm a baseline with `git stash -u` before attributing a failure to your change.
