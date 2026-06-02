This directory is for locally generated PGlite runtime artifacts used by the Worker runtime.

`pglite.wasm` is intentionally not committed. Build it from the PGlite source submodule by running:

```sh
bun run setup
```

`bun run setup` initializes `vendor/pglite` recursively, applies this template's lower-memory PGlite patch, builds the upstream WASM artifact, verifies its initial memory, and copies it here.

The app intentionally still imports `pglite.data` from `@electric-sql/pglite` because the installed PGlite JavaScript glue validates that data bundle's exact byte size.

The Worker also starts Postgres with `shared_buffers=4MB`; the upstream default is 128MiB and exceeds Cloudflare's 128 MB isolate budget once WebAssembly allocations, JavaScript heap, and runtime overhead are included.

Treat compiled WASM like executable native code. Do not trust arbitrary third-party compiled PGlite WASM artifacts unless you trust their source, build process, and supply chain; build locally from the reviewed submodule instead.
