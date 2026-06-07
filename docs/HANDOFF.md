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

**Phase:** Session 4 BLOCKED (2026-06-08). The Asyncify binary cannot initialize
inside workerd. Session 3 PoC PASS (Node V8) stands and is the permanent evidence
that the Asyncify primitive works. Session 5 will target workerd via JSPI with a
new binary.

**Session 4 summary.** Attempted to wire the Session 3 `php8.0-worker.mjs` binary
into a Cloudflare Worker via `wrangler dev`. Three glue patches required:

1. `self.location.href` guard — required for workerd ESM format; WORKS.
2. `addEventListener useCapture=false` — required (workerd forbids `true`); WORKS.
3. `addFunction/convertJsFunctionToWasm` — **HARD BLOCKER** (ADR-0012). workerd
   blocks `new WebAssembly.Module(bytes)` at runtime and lacks `WebAssembly.Function`.
   The four undefined libxml2 symbols (`xmlStrdup`, `xmlStrncmp`, `xmlURIUnescapeString`,
   `xmlUnlinkNode`) needed for `xmlInitParser()` during `php_embed_init` cannot be
   stubbed. No JS-level fix exists; a build change is required.

**JSPI confirmed in workerd (ADR-0013, 2026-06-08).** Probe confirmed:
`WebAssembly.Suspending`, `WebAssembly.promising`, `WebAssembly.SuspendError` are
present in workerd (wrangler 4.96.0, compatibility date 2024-09-23).
`WebAssembly.Function` is NOT present.

**Session 4 committed files:**
- `worker/index.mjs` — workerd loader entry (blocked, status in file comment)
- `wrangler.toml` — wrangler config
- `patches/session4-workerd-analysis.patch` — full three-patch analysis with evidence

**What all prior sessions established (still true):**
- Session 3 PASS: PHP suspends on an unresolved Promise and resumes with `42`.
  Ordering markers confirm the Asyncify suspend/resume cycle. ADR-0006 satisfied.
- Session 2: `fp_async_call` import added; PHP calls it; binary size delta +1,257 B raw.
- Session 1: unmodified PHP 8.0.30 from source; runs synchronously in Node V8.
- iconv-resolution: GNU libiconv dropped (`WITH_ICONV=0`); binary byte-identical;
  no LGPL in binary or distribution (ADR-0011).

**Decided** (see `DECISIONS.md` for full reasoning):
- License: **Apache-2.0**, clean-derivation path.
- Lineage: derive from the **Apache-2.0** ancestor pipeline, not GPL Playground packages.
- Suspension mechanism: **Asyncify first** (proven in Node V8); **JSPI** for workerd
  integration (accelerated from planned Session 5 optimization — ADR-0013).
- Toolchain: **PHP 8.0.30**; Emscripten = **seanmorris fork 3.1.68 (`sm-updates`)**,
  not stock 4.0.19 (ADR-0007 supersedes ADR-0004).
- PoC scope and success criteria: ADR-0005. Kill criterion: ADR-0006.

Build artifacts (not committed; `*.wasm` and `worker/build/` gitignored) live in the
scratch checkout: `~/scratch/php-wasm-upstream/packages/php-wasm/`.
Source deltas for Sessions 2–3 are committed as patches.

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
4. **[BLOCKED] Port the PoC into workerd (Asyncify).** The Asyncify binary cannot
   initialize in workerd — `addFunction/convertJsFunctionToWasm` hits an embedder
   restriction (ADR-0012). The `instantiateWasm` hook works; glue patches 1 and 2
   work; patch 3 has no JS-level fix. Artifacts committed.
5. **[NEXT] JSPI rebuild + workerd PoC.** Rebuild with JSPI (drop MAIN_MODULE or
   libxml), confirm suspend/resume in workerd. JSPI availability confirmed (ADR-0013).
   See BUILD.md Session 5 outline and DECISIONS.md ADR-0012/0013 for the plan.

A passing Session 3 is the real milestone; everything after it is
integration, which is lower risk.

---

## Open risks / verification items

1. **JSPI build: unknown undefined-symbol count without MAIN_MODULE.** When
   rebuilding without dynamic linking (`MAIN_MODULE=0`) or with `--disable-libxml`,
   the link step may surface additional undefined symbols. On the seanmorris pipeline,
   `MAIN_MODULE=1` is the default; rebuilding without it is untested for this config.
   Expect one or two link-time iterations to resolve any remaining symbol gaps.

2. **Link-time license audit — RESOLVED (ADR-0011, 2026-06-07).** GNU libiconv was
   an optional WASM side module (not statically linked). Dropped via `WITH_ICONV=0`;
   no LGPL component remains in the binary or distribution. OpenSSL 1.1.1x is
   permissive. See `NOTICE` and `RESULTS.md`.

3. **Exhaustive suspendable-frames list (JSPI).** Under JSPI, only explicitly
   declared suspending imports can suspend — there is no whole-program instrumentation.
   The JSPI binary must correctly wrap `fp_async_call` as a `WebAssembly.Suspending`
   function. If there are intermediate C frames that prevent suspension (e.g. due to
   non-suspendable callbacks), they must be resolved. Less likely to be a problem for
   a leaf import, but untested.

4. **JSPI production status.** JSPI is confirmed available in workerd (ADR-0013)
   at compatibility date 2024-09-23. Its long-term stability/documentation status
   in Cloudflare Workers production is not separately verified.

---

## Next action

**Session 4 BLOCKED.** The Asyncify path hits a hard incompatibility in workerd
(ADR-0012). Session 4 artifacts committed. JSPI confirmed available (ADR-0013).

**Next: Session 5 — JSPI rebuild for workerd.** The plan:

1. **Build change** — in the seanmorris pipeline checkout, modify the Session 3
   patches to rebuild with JSPI instead of Asyncify:
   - Replace `-sASYNCIFY=1` with `-sJSPI=1` in `EXTRA_FLAGS`.
   - Replace `-s ASYNCIFY_IMPORTS=fp_async_call` with `-sJSPI_IMPORTS=fp_async_call`
     (or the Emscripten 3.1.68 equivalent).
   - Drop `MAIN_MODULE=1` or pass `--disable-libxml` to resolve undefined libxml2
     symbols without needing `addFunction` stubs.
   - In `library_fp_async.js`, remove the `Asyncify.handleAsync` wrapper; make the
     function an `async` JS function returning a Promise directly (JSPI handles the
     suspend/resume at the binary level via `fp_async_call__async: true` or the JSPI
     import declaration).

2. **New worker entry** — replace `ccall({async: true})` with JSPI primitives:
   ```js
   const suspendingFpAsync = new WebAssembly.Suspending(async (payload) => {
       return payload + 1;  // or a real async host call
   });
   // Provide under env.fp_async_call in the imports map
   const promisingRun = WebAssembly.promising(instance.exports.pib_run);
   await promisingRun('?>' + PHP_CODE);
   ```

3. **Verify** — `wrangler dev`, `curl localhost:8787/` → `before:\nafter: 42\n`.

**Success criterion:** same as ADR-0005 but delivered via workerd HTTP response:
`before:\n` then `after: 42\n`, with `[worker] before:` / `[worker] after:` console
ordering confirming the suspend/resume cycle ran inside workerd.
