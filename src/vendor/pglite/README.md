This directory contains the PGlite WASM artifact used by the Worker runtime.

`pglite.wasm` is rebuilt from `vendor/pglite` with `-sINITIAL_MEMORY=64MB` by running:

```sh
pnpm pglite:build-low-memory
```

The app intentionally still imports `pglite.data` from `@electric-sql/pglite` because the installed PGlite JavaScript glue validates that data bundle's exact byte size.

The Worker also starts Postgres with `shared_buffers=4MB`; the upstream default is 128MiB and exceeds Cloudflare's isolate budget once WASM and JavaScript heap overhead are included.
