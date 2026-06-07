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

**Phase:** Session 3 complete (2026-06-07). **PROOF-OF-CONCEPT PASSED.**
The ADR-0006 hard-kill criterion is satisfied: PHP suspended on an unresolved
Promise (`setTimeout(0)` macrotask), the event loop turned, and PHP resumed with
the resolved value `42`. Host-side ordering markers confirm the sequence
unambiguously. Session 1 baseline still runs unchanged.

**What Session 3 changed (two JS-only deltas, no C recompile):**
- `source/library_fp_async.js` — upgraded from synchronous stub to
  `Asyncify.handleAsync(async () => ...)` with a deferred Promise resolved by
  `setTimeout(..., 0)`. Added `fp_async_call__async: true` Emscripten annotation.
- `source/PhpBase.mjs` `_run()` — added `{async: true}` to the `pib_run` ccall.
  This is the critical run-path fix: without it, the Asyncify stack unwinds but
  never rewinds (the synchronous ccall discards the sentinel).
Delta committed as `patches/session3-suspend.patch`. `.wasm` is identical to
Session 2 (12,183,180 B); JS glue grew +449 B raw.

(Session 1, still true: unmodified baseline builds from source and runs
synchronously in Node V8; sizes/timings in `RESULTS.md`; link audit in
`NOTICE`.)

Build artifacts (not committed; `*.wasm` gitignored) live in the scratch
checkout: `~/scratch/php-wasm-upstream/packages/php-wasm/php8.0-node.mjs.wasm`
(+ `php8.0-node.mjs` glue). The pipeline checkout is kept outside this repo.
The Session 2 source delta is committed here as
`patches/session2-fp_async_call.patch`.

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

1. **[DONE] Build environment + reproduce baseline.** Stand up the toolchain,
   build an *unmodified* PHP 8.0.30 WebAssembly binary from the permissive
   pipeline, confirm it runs synchronously in Node. Goal: a clean,
   reproducible baseline that we own. Output documented in `BUILD.md`.
2. **[DONE] Add the import and recompile (Asyncify).** `fp_async_call` added
   to ASYNCIFY_IMPORTS, exposed to PHP via the `pib` extension, host impl in
   `source/library_fp_async.js`, recompiled. No imports-list iteration was
   needed (whole-program Asyncify — ADR-0008). PHP calls it: `fp_async_call(41)`
   → `42`. Synchronous host impl; suspension is Session 3.
3. **[DONE] Prove suspend/resume in Node V8.** Promise resolves on a later
   macrotask; `after: 42` confirmed with correct ordering. Hard-kill criterion
   (ADR-0006) satisfied — PASS (2026-06-07).
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
2. **Link-time license audit — OPEN FINDING, MUST RESOLVE BEFORE SESSION 4 /
   BEFORE ANY PUBLISH OR DEPLOY (deferred by ADR-0009).** The build statically
   links **GNU libiconv 1.17 (LGPL-2.1-or-later)** — an LGPL component in the
   static link, exactly the case ADR-0001 flagged. `readline` (GPL) is correctly
   excluded. Left untouched in Sessions 2 and 3 on purpose (resolving it changes
   the binary and would contaminate the clean diffs; the async mechanism is
   orthogonal to iconv — see ADR-0009). It must be resolved before Session 4 /
   before publishing any binary: meet the LGPL obligations for a static artifact,
   or drop/replace iconv. OpenSSL here is 1.1.1x (legacy dual OpenSSL/SSLeay
   license). See `NOTICE` and `RESULTS.md` negative result #3.
3. **Exhaustive suspendable-imports list.** The most likely time-sink. Adding
   one async import can surface a chain of functions that must also be made
   suspendable, each discovered only by crashing and reading the stack trace.
4. **Runtime instantiation constraint.** The target runtime blocks
   compiling WebAssembly from runtime bytes; the binary must be statically
   bundled and instantiated through the loader's instantiation hook. The
   hand-written loader must respect this.

---

## Next action

**Immediate pre-Session-4 obligation (blocker):** resolve the **libiconv LGPL**
link-audit finding (open risk #2, deferred by ADR-0009). Decide whether to meet
the LGPL static-link obligations for the distributed binary or drop/replace iconv
before Session 4 begins. This changes the binary; resolve it first so Session 4
measures the clean binary.

**Session 4 — port the PoC into workerd.** Wire the Session 3 binary into the
Cloudflare-style loader, run under workerd locally, confirm the same
suspend/resume ordering (stdout `before:\nafter: 42\n`) with output delivered via
the host stdout callback. The ADR-0006 soft-kill criterion applies here: if
suspend/resume works in Node V8 (confirmed) but cannot be made to work inside
workerd within two focused sessions, stop pushing the workerd integration — but
retain the Node V8 result, which proves the primitive and is valuable to
PHP-on-edge consumers beyond Cloudflare.
