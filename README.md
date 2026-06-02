<p align="center">
  <img src="assets/trunk-classic-lockup.svg" alt="trunk" width="400" />
</p>

# PGlite Durable Object Template

Run PGlite inside a Cloudflare Durable Object with Durable Object storage as the backing filesystem. This is a starter template for experimenting with per-ID embedded Postgres databases at the edge.

## Security: Build WASM Locally

This template intentionally does not commit `src/vendor/pglite/pglite.wasm`. `bun run setup` builds the runtime artifact locally from the PGlite source submodule, applies this template's lower-memory patch, verifies the generated WASM initial memory, and copies the artifact into `src/vendor/pglite/`.

Treat compiled WASM like executable native code. Do not replace this local build with an arbitrary third-party `pglite.wasm` download unless you trust its source, build process, and supply chain.

## Requirements

- Bun for dependency installation and project scripts.
- Node.js 22+ for Wrangler. The project invokes Wrangler through Bun scripts, but Wrangler's CLI still runs on Node and the installed Wrangler package requires Node 22 or newer.
- Git with submodule support; `bun run setup` initializes `vendor/pglite` recursively.
- Docker for the upstream PGlite WASM build.
- pnpm for the upstream PGlite workspace build invoked by `scripts/build-pglite-low-memory.sh`.
- PGlite's upstream WASM build toolchain as required by `pnpm --dir vendor/pglite wasm:build`; the upstream build currently relies on its repository scripts and Docker-based build environment.

## Quick Start

```sh
bun install
bun run setup
bun run check
bun run dev
```

`bun run setup` initializes the PGlite submodule recursively, regenerates WASM function wrapper artifacts, builds the low-memory PGlite WASM artifact, and verifies the artifact before local development or deployment.

## Development Commands

- `bun run setup`: initialize submodules and build local generated WASM artifacts.
- `bun run artifacts:check`: verify required generated artifacts exist and the PGlite WASM memory setting is correct.
- `bun run check`: run artifact checks, TypeScript, Worker tests, Node tests, and a Wrangler dry-run deploy.
- `bun run dev`: start local Wrangler development.
- `bun run deploy`: deploy with Wrangler.
- `bun run cf-typegen`: regenerate Cloudflare Worker types.

## API

### `GET /health`

Returns a simple health response:

```json
{ "ok": true }
```

### `GET /query/:id`

Runs the smoke-test query for the Durable Object named by `:id`:

```sql
select 1 as ok
```

This route is kept as a quick connectivity smoke test.

### `POST /query/:id`

Runs SQL against the Durable Object database named by `:id`.

```sh
curl -X POST http://localhost:8787/query/demo \
  -H 'content-type: application/json' \
  -d '{ "sql": "select 1", "params": [] }'
```

Request body:

```json
{ "sql": "select 1", "params": [] }
```

`params` is optional, but when present it must be an array.

Warning: the SQL endpoint is intentionally unauthenticated for experimentation. Do not publicly expose it without adding authentication, ACLs, removing the route, or replacing it with application-specific routes that only execute safe operations.

## Cloudflare Limits

Cloudflare's current Workers limits documentation lists `128 MB` memory per isolate. The memory section says each isolate can consume up to 128 MB including the JavaScript heap and WebAssembly allocations, and that the limit is per isolate rather than per invocation.

That is why this template builds a lower-memory PGlite runtime artifact and starts Postgres with constrained shared buffers:

- `scripts/build-pglite-low-memory.sh` applies the `64MB` initial-memory patch before building `pglite.wasm`.
- `PGlite.create()` uses `initialMemory: 64 * 1024 * 1024`.
- Postgres starts with `shared_buffers=4MB` instead of the much larger upstream default.

These settings are intended to leave room for WebAssembly memory, JavaScript heap, Worker runtime overhead, request handling, and Durable Object filesystem bookkeeping inside the 128 MB isolate budget.

## Customization

- Replace the sample SQL API with application-specific endpoints before production use.
- Use stable Durable Object names in `/query/:id` to map tenants, projects, users, or databases to separate PGlite instances.
- Adjust `ChunkedDurableObjectFS` only after testing read/write behavior and storage size tradeoffs.
- If you change PGlite memory settings, update the patch under `patches/`, rebuild with `bun run setup`, and keep `bun run artifacts:check` passing.
- After changing Worker bindings, run `bun run cf-typegen`.

## Deployment

Build and verify local artifacts before deploying:

Authenticate Wrangler before deploying with `bunx wrangler login` for interactive auth, or set `CLOUDFLARE_API_TOKEN` for CI and other non-interactive environments.

```sh
bun run setup
bun run check
bun run deploy
```

`bun run check` fails fast when generated artifacts are missing and points back to `bun run setup`.

## Production Safety Warning

The `/query/:id` SQL endpoint accepts arbitrary SQL and is deliberately unauthenticated for starter-template experimentation. It must not be exposed to the public Internet as-is. Add authentication and authorization, restrict access with network ACLs, remove the endpoint, or replace it with narrowly scoped application routes before production deployment.
