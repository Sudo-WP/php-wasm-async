# php-wasm-async

Run **real PHP in WebAssembly** that can call **asynchronous host functions** —
await a Promise, suspend, and resume with the result — inside serverless edge
runtimes like Cloudflare Workers / workerd.

> **Status: experimental / pre-production.** This is active R&D into an
> unproven capability. Kickoff and design are complete; the build has not yet
> run. Approaches, APIs, and results may change, and negative results are
> documented honestly alongside what works. See
> [`docs/HANDOFF.md`](docs/HANDOFF.md) for current state.

## The problem

PHP is synchronous. Edge data stores — Cloudflare D1, KV, R2 — are async-only.
That mismatch means PHP running in a Worker can't `await` a database query
mid-execution. The usual workaround is to eagerly load all data before PHP
runs, which breaks down the moment a query's terms aren't known until runtime
(dynamic apps, real WordPress, WooCommerce).

## What this provides

A rebuilt PHP-WASM runtime where PHP can call a host-provided async function,
yield, and continue once the Promise resolves — making live, on-demand edge
database access from PHP possible for the first time.

The primitive is deliberately generic — a general "await a host Promise"
facility:

> PHP calls a host function, the host returns a Promise, PHP suspends until
> it resolves, and PHP resumes with the resolved value as the return value
> of the call.

Specific data stores, key-value stores, object stores, and network calls are
**consumers** layered on top, not assumptions baked into the interface — D1 is
simply the first consumer.

Built on Emscripten + PHP source, based on the WordPress Playground php-wasm
build. Runtime-agnostic by design.

## Documentation

- [`docs/DESIGN.md`](docs/DESIGN.md) — the async bridge architecture and
  approach rationale
- [`docs/BUILD.md`](docs/BUILD.md) — reproducible build guide (toolchain +
  steps)
- [`docs/RESULTS.md`](docs/RESULTS.md) — benchmarks and findings, including
  negative results
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — dated log of architecture
  decisions
- [`docs/HANDOFF.md`](docs/HANDOFF.md) — current state and next action

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). The runtime is
built on a clean-derivation path from permissively-licensed prior art; see
`docs/DECISIONS.md` ADR-0001 and ADR-0003.

This project is not affiliated with or endorsed by the PHP Group. In
accordance with the PHP License naming restriction, "PHP" is not used in the
project's product name.
