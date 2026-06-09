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

**Phase:** Session 5 PASS (2026-06-09). Asyncify suspend/resume confirmed inside
workerd. The ADR-0005 success criterion is satisfied end-to-end (Node V8 + workerd).
ADR-0006 fully satisfied. The Asyncify PoC is complete.

**Session 5 result.** `curl http://localhost:8791/` returns `before:\nafter: 42\n`.
The Asyncify suspend/resume ordering markers confirm the full cycle ran inside workerd.
Two consecutive requests both succeeded.

**Session 5 approach (ADR-0014 + ADR-0015).**
- `WITH_LIBXML=static` + `WITH_TIDY=static` in `.circleci/.env_8.0.ci` — switches
  libxml2 and libtidy from dynamic WASM side modules to static archives. Eliminates
  the 4 libxml2 GOT symbols that triggered the Session 4 blocker.
- Pre-compiled `vp` trampoline (`worker/build/trampoline-vp.wasm`, 31 bytes, committed
  and bundled by wrangler) — resolves 6 Emscripten console/output GOT.func symbols
  that ALSO trigger `addFunction → convertJsFunctionToWasm`. workerd blocks ALL runtime
  wasm compilation (sync and async); only wrangler-bundled (AOT-compiled) modules work.
- `apply-workerd-patches.py` Patch 3 — patches `convertJsFunctionToWasm` to use the
  pre-compiled cache rather than `new WebAssembly.Module(bytes)`.

**Session 5 committed files (on top of Session 4):**
- `worker/index.mjs` — updated: imports `trampoline-vp.wasm`, sets
  `globalThis.__phpWasmTrampolines` in `instantiateWasm`
- `worker/build/trampoline-vp.wasm` — 31-byte bundled vp-signature trampoline
- `worker/apply-workerd-patches.py` — Patch 3 added
- `patches/session5-static-libxml.patch` — env + Makefile changes for static build
- `docs/DECISIONS.md` — ADR-0014 (pre-session) + ADR-0015 (result)

**What all sessions established (all true):**
- Session 5 PASS: Asyncify suspend/resume in workerd — `before:\nafter: 42\n`.
- Session 3 PASS: Asyncify suspend/resume in Node V8 — `before:\nafter: 42\n`.
- Session 2: `fp_async_call` import added; PHP calls it; binary size delta +1,257 B raw.
- Session 1: unmodified PHP 8.0.30 from source; runs synchronously in Node V8.
- iconv-resolution: GNU libiconv dropped (`WITH_ICONV=0`); no LGPL in binary (ADR-0011).

**Decided** (see `DECISIONS.md` for full reasoning):
- License: **Apache-2.0**, clean-derivation path.
- Lineage: derive from the **Apache-2.0** ancestor pipeline, not GPL Playground packages.
- Suspension mechanism: **Asyncify** (proven in Node V8 AND workerd). ADR-0002 complete.
- Toolchain: **PHP 8.0.30**; Emscripten = **seanmorris fork 3.1.68 (`sm-updates`)**,
  not stock 4.0.19 (ADR-0007 supersedes ADR-0004).
- PoC scope and success criteria: ADR-0005. Kill criterion: ADR-0006.

Build artifacts (not committed; `*.wasm` and `worker/build/*.mjs*` gitignored) live in the
scratch checkout: `~/scratch/php-wasm-upstream/packages/php-wasm/`.
`worker/build/trampoline-vp.wasm` IS committed (31 bytes, not gitignored).
Source deltas for Sessions 2–5 are committed as patches.

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
4. **[DONE] Port the PoC into workerd (Asyncify).** Three glue patches identified;
   init blocker hit (`addFunction/convertJsFunctionToWasm → new WebAssembly.Module`
   blocked by workerd). Artifacts committed. JSPI confirmed available in workerd.
5. **[DONE] Fix init blocker + confirm Asyncify in workerd.** `WITH_LIBXML=static`
   eliminates dynamic libxml2 GOT symbols. Pre-compiled `vp` trampoline (31 bytes,
   bundled by wrangler) resolves the 6 Emscripten console GOT.func symbols.
   `curl http://localhost:8791/` → `before:\nafter: 42\n` — PASS (2026-06-09).

**The PoC is complete.** The ADR-0005 success criterion is satisfied in workerd.
ADR-0006 is fully satisfied. The Asyncify suspend/resume primitive is proven in
both Node V8 and Cloudflare Workers / workerd.

---

## Open risks / verification items

1. **Link-time license audit — RESOLVED (ADR-0011, 2026-06-07).** GNU libiconv was
   an optional WASM side module (not statically linked). Dropped via `WITH_ICONV=0`;
   no LGPL component remains in the binary or distribution. OpenSSL 1.1.1x is
   permissive. See `NOTICE` and `RESULTS.md`.

2. **libtidy license — RESOLVED (2026-06-09).** `WITH_TIDY=static` links libtidy
   (HTML Tidy) statically. HTML Tidy uses a permissive zlib-like license — no copyleft.
   tidy-html5 (libtidy) attribution confirmed (2026-06-09): W3C Software License
   (SPDX: HTMLTIDY), permissive, no copyleft. NOTICE updated. Pre-emptive risk closed.

3. **trampoline-vp.wasm signature coverage.** Only the `vp` (void, i32) signature is
   pre-compiled. If any future PHP wasm build introduces new GOT.func JS-function
   symbols with different signatures (e.g. `vi`, `iii`), additional trampoline wasm
   files would be needed. For the current Session 5 binary, 6 symbols all use `vp`
   and no others were observed (confirmed by debug logging).

4. **JSPI as optimization path.** JSPI is confirmed available in workerd (ADR-0013).
   It would reduce binary size (no whole-program Asyncify instrumentation) and
   per-call overhead. If either matters for production use, Session 6 can pursue JSPI
   independently — the ADR-0002 sequence is now complete.

---

## Next action

**Session 5 PASS.** The Asyncify PoC is complete. `before:\nafter: 42\n` from
workerd (2026-06-09).

**Potential next sessions (optional — the PoC objective is met):**

1. **JSPI port (optimization).** Rebuild with JSPI + `WITH_LIBXML=static` to get a
   smaller binary (drops Asyncify instrumentation) and lower per-call overhead. The
   trampoline fix applies equally to JSPI since MAIN_MODULE=1 remains. Compare binary
   sizes and latency in RESULTS.md. Use `WebAssembly.Suspending`/`WebAssembly.promising`
   in `worker/index.mjs` instead of `ccall({async: true})`.

2. **Real async host call.** Replace the `setTimeout(0)` stub with an actual async
   operation (KV read, D1 query, R2 fetch) to demonstrate the real-world pattern.

3. **PHP version bump.** Port to PHP 8.3 or 8.4 (end-of-life 8.0 replaced with a
   supported branch). The build structure is the same; only the version string and
   source tarball change.

4. **Binary size reduction.** Strip unused extensions from `.env_8.0.ci` to shrink
   the wasm below 10 MB raw, improving cold-start latency.
