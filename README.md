# php-wasm-async

A rebuild of the PHP-to-WebAssembly runtime that lets PHP call a
host-provided **asynchronous** function, suspend, and resume with the
resolved value — running inside serverless WebAssembly environments
(initial target: Cloudflare Workers / workerd).

> **Status: early.** Kickoff and design are complete; the build has not yet
> run. See [`docs/HANDOFF.md`](docs/HANDOFF.md) for current state.

## Why

PHP executes synchronously. Many edge data stores are asynchronous only, so
today data must be loaded eagerly before PHP runs — which cannot serve
queries whose terms are not known until PHP executes. This runtime provides
a single generic primitive that removes that limit:

> PHP calls a host function, the host returns a Promise, PHP suspends until
> it resolves, and PHP resumes with the resolved value as the return value
> of the call.

The primitive is deliberately generic — a general "await a host Promise"
facility. Specific data stores, key-value stores, object stores, and network
calls are **consumers** layered on top, not assumptions baked into the
interface.

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
