<p align="center">
  <img src="assets/trunk-classic-lockup.svg" alt="trunk" width="400" />
</p>

# trunk

Postgres databases your agents can't hurt you with. Each database is real Postgres 17 (PGlite) running in its own Cloudflare Durable Object, with 30 days of point-in-time history.

- **Agents get their own databases** through an MCP server, with a token scoped to that agent. They can do anything inside them, and nothing outside them.
- **Every change can be undone.** Checkpoint before risky work, or restore to any moment in the last 30 days. Every restore can itself be undone.
- **Normal Postgres clients still work.** `trunk proxy` runs on your Mac, so `psql`, TablePlus, Prisma or your app connect to `postgres://localhost:5433/<db>`.

## Quick start

```sh
bun install
bun run setup                              # builds the low-memory PGlite WASM (needs Docker)
bunx wrangler secret put TRUNK_ADMIN_TOKEN # pick a long random string, e.g. `openssl rand -hex 32`
bun run deploy

bun link                                   # puts `trunk` on your PATH
trunk login https://<your-worker>.workers.dev <admin-token>
trunk proxy                                # keep this running
psql postgres://localhost:5433/myapp       # a new name creates the database
```

Give an agent its own databases:

```sh
trunk agent add claude                     # prints the token, the `claude mcp add ...` line and a Postgres URL
```

An agent can also use a normal Postgres client through the proxy, scoped to its own databases, by logging in as user `agent` with its token as the password: `postgres://agent:<token>@localhost:5433/<db>`.

The agent gets these MCP tools: `list_databases`, `create_database`, `query`, `describe`, `fork`, `checkpoint`, `list_checkpoints` and `restore`. To let an agent work on a copy of your data, fork it into a database the agent owns:

```sh
trunk fork myapp myapp-sandbox --owner claude
```

## CLI

```text
trunk login <url> <admin-token>     save the Worker URL and admin token (~/.config/trunk/config.json)
trunk proxy [--port 5433]           let local clients connect: psql postgres://localhost:5433/<db>
trunk ls | new <db> | fork <db> <new> | rm <db>
trunk checkpoint <db> <label> | checkpoints <db>
trunk restore <db> <label | 15m | 2h | ISO time>
trunk agent add <name> | ls | rm <name>
```

Without `bun link`, use `bun run trunk <command>`. For local development, run `bun run dev` with the token from `.dev.vars` (copy `.dev.vars.example`) and `trunk login http://localhost:8787 dev-admin-token`.

## Safety model

- **You** (the admin token) can use every database.
- **Agents** only see databases they created or that you gave them with `--owner`. Other names return "not found". Agents can't delete databases, mint tokens or exceed 25 databases. `trunk agent rm <name>` revokes an agent's tokens and closes its open connections. Its databases are kept, and `trunk agent add` with the same name gives access back.
- **The proxy** only listens on localhost. Any other user name connects as you (admin), so any program on your Mac can reach every database through it. Only user `agent` with an agent token is scoped. trunk can't contain an agent that has a shell on your Mac: it could also read the admin token from `~/.config/trunk/config.json`. Give such agents only their token, and run them in a sandbox or on another machine.
- **History:** Cloudflare keeps 30 days of point-in-time history for every Durable Object. Checkpoint labels are stored outside the database, so restoring never loses later checkpoints. Every restore records a `before-restore-…` checkpoint that undoes it. `trunk rm` is the only permanent operation, and it asks for confirmation. Reusing a deleted name gives a new, empty database.

## Limits

- **One Postgres session per database.** All clients of the same database share one PGlite session. Statements run one at a time, and while one connection is inside a transaction the others wait. Protocol-level prepared statements (what drivers use) are kept apart per connection, so pooled drivers work, and `DEALLOCATE ALL` / `DISCARD ALL` sent as their own query only drop the sending connection's statements (the HTTP API and MCP refuse them). Session settings (`SET`), temp tables and SQL `PREPARE` names are shared. Different databases run fully in parallel.
- **Restore only works on the deployed Worker.** Point-in-time recovery doesn't exist in `wrangler dev` or tests, so locally checkpoints are saved but restore returns an error.
- **Size.** Each database has a 128 MB memory budget, fine for app and agent workloads but not for large analytical queries. A fork copies all data, so it takes longer as the database grows. Until it finishes, `trunk ls` shows the new name as forking and connections to it are refused.
- **COPY.** `COPY ... FROM STDIN` (psql `\copy`, `pg_dump | psql`) works through the proxy, up to 16 MB per COPY. The HTTP API and MCP reject it; use `INSERT` there.
- **Crashes.** A fatal Postgres error ends the PGlite instance. trunk then restarts that database: open connections drop, committed data is kept.
- **Not supported:** query cancel requests, `LISTEN/NOTIFY` across connections, and TLS on the local hop (the hop to Cloudflare is TLS).

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

## Development Commands

- `bun run setup`: initialize the PGlite submodule, regenerate WASM function wrappers, and build and verify the low-memory PGlite WASM artifact.
- `bun run artifacts:check`: verify required generated artifacts exist and the PGlite WASM memory setting is correct.
- `bun run check`: run artifact checks, TypeScript, Worker tests, Node tests, and a Wrangler dry-run deploy.
- `bun run dev`: start local Wrangler development.
- `bun run trunk <command>`: run the CLI without `bun link`.
- `bun run deploy`: deploy with Wrangler.
- `bun run cf-typegen`: regenerate Cloudflare Worker types.

## HTTP API

All routes except `/health` take `Authorization: Bearer <token>` (admin or agent).

| Route | Purpose |
| --- | --- |
| `GET /v1/databases`, `POST /v1/databases {name, owner?}`, `DELETE /v1/databases/:name` | list, create, delete (admin) |
| `POST /v1/databases/:name/query {sql, params?}` | run SQL; without params several statements are allowed |
| `POST /v1/databases/:name/fork {name, owner?}` | copy into a new database |
| `GET` / `POST /v1/databases/:name/checkpoints {label}` | list or save checkpoints |
| `POST /v1/databases/:name/restore {to}` | restore to a label, `15m`, or an ISO time |
| `GET /v1/databases/:name/connect` | Postgres wire protocol over WebSocket (used by `trunk proxy`) |
| `GET` / `POST /v1/agents {name}`, `DELETE /v1/agents/:name` | list agents, create a token, revoke (admin) |
| `/mcp` | MCP server (streamable HTTP) |

## Cloudflare Limits

Cloudflare's current Workers limits documentation lists `128 MB` memory per isolate. The memory section says each isolate can consume up to 128 MB including the JavaScript heap and WebAssembly allocations, and that the limit is per isolate rather than per invocation.

That is why this template builds a lower-memory PGlite runtime artifact and starts Postgres with constrained shared buffers:

- `scripts/build-pglite-low-memory.sh` applies the `64MB` initial-memory patch before building `pglite.wasm`.
- `PGlite.create()` uses `initialMemory: 64 * 1024 * 1024`.
- Postgres starts with `shared_buffers=4MB` instead of the much larger upstream default.

These settings are intended to leave room for WebAssembly memory, JavaScript heap, Worker runtime overhead, request handling, and Durable Object filesystem bookkeeping inside the 128 MB isolate budget.

## Deployment

Build and verify local artifacts before deploying:

Authenticate Wrangler before deploying with `bunx wrangler login` for interactive auth, or set `CLOUDFLARE_API_TOKEN` for CI and other non-interactive environments.

```sh
bun run setup
bun run check
bunx wrangler secret put TRUNK_ADMIN_TOKEN   # once
bun run deploy
```

`bun run check` fails fast when generated artifacts are missing and points back to `bun run setup`.
