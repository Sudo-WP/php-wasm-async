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

**Phase:** Session 1 complete (2026-06-03). The unmodified PHP **8.0.30**
WebAssembly baseline is **built from source and runs synchronously in Node V8**
(`<?php echo "hello\n";` → `hello`, exit 0; `PHP_VERSION` → `8.0.30`). Sizes
and timings recorded in `RESULTS.md`; link-time license audit started in
`NOTICE`.

Build artifacts (not committed; `*.wasm` gitignored) live in the scratch
checkout: `~/scratch/php-wasm-upstream/packages/php-wasm/php8.0-node.mjs.wasm`
(+ `php8.0-node.mjs` glue). The pipeline checkout is kept outside this repo.

**Decided** (see `DECISIONS.md` for full reasoning):
- License: **Apache-2.0**, clean-derivation path.
- Lineage: derive from the **Apache-2.0** ancestor pipeline, not the
  GPL Playground packages.
- Suspension mechanism: **Asyncify first**, JSPI as a later optimization.
  (Asyncify is already on in the baseline by upstream default.)
- Toolchain: **PHP 8.0.30**; Emscripten = **seanmorris fork 3.1.68
  (`sm-updates`)**, not stock 4.0.19 — corrected in **ADR-0007**, which
  supersedes ADR-0004's Emscripten pin.
- Baseline config: full extension set (`.circleci/.env_8.0.ci`), chosen so
  Session 2 diffs against a canonical, comparable build.
- PoC scope and success criteria: defined (`DECISIONS.md` ADR-0005).
- Kill criterion: defined (`DECISIONS.md` ADR-0006).

**Build prerequisite (learned in Session 1):** run `npm install` in the
pipeline checkout before `make`, or the build recurses infinitely. See
`RESULTS.md` negative result #1 and `BUILD.md`.

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
2. **Link-time license audit — OPEN FINDING.** The Session 1 build statically
   links **GNU libiconv 1.17 (LGPL-2.1-or-later)** — an LGPL component in the
   static link, exactly the case ADR-0001 flagged. `readline` (GPL) is
   correctly excluded. This must be resolved before publishing any binary:
   meet the LGPL obligations for a static artifact, or drop/replace iconv.
   OpenSSL here is 1.1.1x (legacy dual OpenSSL/SSLeay license). See `NOTICE`
   and `RESULTS.md` negative result #3.
3. **Exhaustive suspendable-imports list.** The most likely time-sink. Adding
   one async import can surface a chain of functions that must also be made
   suspendable, each discovered only by crashing and reading the stack trace.
4. **Runtime instantiation constraint.** The target runtime blocks
   compiling WebAssembly from runtime bytes; the binary must be statically
   bundled and instantiated through the loader's instantiation hook. The
   hand-written loader must respect this.

---

## Next action

**Session 2 — add the async import and recompile (Asyncify).** Add
`fp_async_call` to the suspendable-imports list, expose it to PHP, provide the
host implementation, and recompile from the same baseline config so the binary
diffs cleanly against Session 1. Expect to iterate on the suspendable-functions
list (a missing function surfaces as a runtime crash naming the omission).
Goal: the binary builds and PHP can call the function. Reuse the validated
build flow in `BUILD.md` (remember the `npm install` prerequisite).

Carried-over cleanup (not blocking Session 2, but before any binary is
published): resolve the **libiconv LGPL** link-audit finding (risk #2 above).
