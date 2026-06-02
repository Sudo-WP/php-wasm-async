# Handoff

Continuity document. This captures the current state of the project so any
session — human or assistant — can pick up without re-deriving context. Keep
it current: update the "Current state" and "Next action" sections at the end
of every working session.

---

## What this project is

`php-wasm-async` rebuilds the PHP-to-WebAssembly runtime so that PHP can call
a host-provided asynchronous function that returns a Promise, suspend, and
resume with the resolved value — running inside a serverless WebAssembly
environment (initial target: Cloudflare Workers / workerd).

PHP is synchronous; many edge data stores are asynchronous only. Today, data
must be loaded eagerly before PHP runs, which cannot serve queries whose
terms are not known until PHP executes. An async host bridge removes that
limit. The bridge is deliberately **generic** — it exposes a "PHP awaits a
host Promise" capability and does not assume any specific data store. Specific
stores are simply the first consumers. See `DESIGN.md`.

---

## Current state

**Phase:** Kickoff complete. No build has run yet.

**Decided** (see `DECISIONS.md` for full reasoning):
- License: **Apache-2.0**, clean-derivation path.
- Lineage: derive from the **Apache-2.0** ancestor pipeline, not the
  GPL Playground packages.
- Suspension mechanism: **Asyncify first**, JSPI as a later optimization.
- Toolchain: **Emscripten 4.0.19**, **PHP 8.0.30**.
- PoC scope and success criteria: defined (`DECISIONS.md` ADR-0005).
- Kill criterion: defined (`DECISIONS.md` ADR-0006).

**Not yet started:** the baseline build (Session 1).

---

## Session sequence

1. **Build environment + reproduce baseline.** Stand up the toolchain, build
   an *unmodified* PHP 8.0.30 WebAssembly binary from the permissive
   pipeline, confirm it runs synchronously in Node. Goal: a clean,
   reproducible baseline that we own. Output documented in `BUILD.md`.
2. **Add the import and recompile (Asyncify).** Add `fp_async_call` to the
   suspendable-imports list, expose it to PHP, provide the host
   implementation, recompile. Resolve the iterative imports-list crashes.
   Goal: the binary builds and PHP calls the function.
3. **Prove suspend/resume in Node V8.** Make the Promise resolve on a later
   tick; confirm `after: 42` with correct ordering. **Decision point** — the
   hard kill criterion applies here.
4. **Port the PoC into workerd.** Wire the binary into the Cloudflare-style
   loader, run under workerd locally, confirm the same ordering with output
   delivered via the host stdout callback.
5. **Deployed Worker + JSPI evaluation.** Confirm in a deployed Worker; in
   parallel, attempt the JSPI variant and record whether it works in the
   target compatibility date and the size/performance delta.

A passing Session 3 is the real milestone; everything after it is
integration, which is lower risk.

---

## Open risks / verification items

Carry these forward as explicit risks rather than assumptions:

1. **JSPI production status in the target runtime.** JSPI is observed working
   in the target serverless runtime in third-party projects, but it is
   compatibility-date gated and not documented as a first-class stable
   feature. Confirm empirically before committing to it for production.
2. **Link-time license audit.** Confirm no GPL/LGPL component enters the
   static link before any binary is published. See `DECISIONS.md` ADR-0001.
3. **Exhaustive suspendable-imports list.** The most likely time-sink. Adding
   one async import can surface a chain of functions that must also be made
   suspendable, each discovered only by crashing and reading the stack trace.
4. **Runtime instantiation constraint.** The target runtime blocks
   compiling WebAssembly from runtime bytes; the binary must be statically
   bundled and instantiated through the loader's instantiation hook. The
   hand-written loader must respect this.

---

## Next action

**Draft the Session 1 build plan** (baseline build): reproduce an unmodified
PHP 8.0.30 WebAssembly binary from the permissive pipeline and confirm it
runs in Node. Implementation runs in the separate coding environment;
benchmark analysis and build planning happen in the design chat.
