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

**Phase:** Session 10 done (2026-06-10) — networking investigation, report-only
(ADR-0020, `docs/RESEARCH-networking.md`). Key outcomes: the upstream companion
extensions (`pdo_cfd1` for D1, `vrzno` for fetch/JS-bridge) use the **same Asyncify
suspension mechanism** as `fp_async_call`; `pdo_cfd1` hard-depends on vrzno and has
WordPress-breaking stubs (`lastInsertId()`→0, no `exec()`, no transactions, unescaped
`quote()`); **all three companion repos are unlicensed** (GitHub `license: null`) —
adoption blocked under ADR-0001/0003 until upstream licenses them. mysqli/curl are
absent from the pipeline by design (DB = PDO drivers, HTTP = fetch). WP's Requests
library needs a small WP-side transport shim under ANY architecture — and it can
target `fp_async_call` today. **`fp_async_call` is not superseded** (ADR-0020); the
(a)-vs-(b) architecture choice is deferred to a prototype-to-measure session.

**Session 9 state (still true).** Binary size reduction via extension stripping
(ADR-0019): `WITH_TIDY=0` (+libtidy.a out), `WITH_CALENDAR=0`, `WITH_PDO_PGLITE=0` on
both versions. Final `gzip -9` sizes: **8.2 = 3,977,584 B (3.79 MiB)**, **8.4 =
4,139,775 B (3.95 MiB)**; combined **7.74 MiB — the two-binary single-Worker deployment
fits the 10 MB Paid limit with ~2.3 MiB headroom** (Free-plan 3 MB is out of reach per
binary). The ≤3.5 MiB/binary target was not met: the remaining mass is PHP core under
whole-program Asyncify + libxml2 — the strippable surface is exhausted; the big lever
left is JSPI.

**Session 9 key finding (static/dynamic split).** The pipeline is dynamic-by-default:
`WITH_X=1` builds a *side module* workerd cannot load. The worker binary only ever
contained the small `--enable-*` static set + libxml (+tidy until now). Consequences:
(a) **intl costs 0 B in the binary** — it was never in it (the "strip intl?" question is
moot until something *adds* it); (b) **the WordPress MUST-KEEP extension floor (mysqli,
curl, gd, mbstring, openssl, dom, sqlite, zip, fileinfo) is NOT met and never was** —
the demo now prints a live sanity line `ext: - - - - - bc` showing it. Making those
static is a dedicated future session and will grow the binary; mysqli/curl additionally
need `WITH_NETWORKING` or shims. See RESULTS Session 9 for the full decision table.

**Session 8 state (still true).** PHP **8.2.11** and **8.4.1** both built from the
same patched pipeline (ADR-0018; pipeline-pinned versions, not latest patch). Both pass
Node V8 regression + suspend/resume and both serve the two-query D1 demo in workerd. The
Worker serves **both versions from a single deployment**, selected per request via the
`X-PHP-Version` header (default 8.4, unknown values fall back to 8.4).

**Session 8 result.** Zero source-patch deltas between 8.0 and 8.2/8.4: `pib.c`,
`library_fp_async.js`, the Makefile changes, and all four workerd glue patches applied
unchanged. The async primitive is version-agnostic in practice. Binary sizes:
8.2 worker wasm 17,050,329 B; 8.4 worker wasm 17,580,702 B (8.0 was 15.8 MB).
`curl` default → `php: 8.4.1`; `curl -H "X-PHP-Version: 8.2"` → `php: 8.2.11`; both
return the full D1 two-query output.

**Session 8 changes:**
- `.circleci/.env_8.2.ci` / `.env_8.4.ci` (upstream files, in scratch checkout): same
  mods as 8.0 (`WITH_LIBXML=static`, `WITH_ICONV=0`, `WITH_TIDY=static`) plus
  `WITH_VRZNO=0` — committed as `patches/session8-multiversion.patch`.
- `worker/index.mjs`: multi-version loader — both runtimes imported statically,
  header-based selection, PHP echoes `PHP_VERSION`, `X-PHP-Version-Served` response header.
- `worker/apply-workerd-patches.py`: patches every `php*-worker.mjs` in `worker/build/`.
- `test-regression.mjs` / `test-session3.mjs` (scratch): take `PHP_VERSION` env var.
- `.gitignore`: generalized to `worker/build/php*-worker.mjs*`.

**Session 7 result (still valid).** `curl http://localhost:8791/` returns
`before:\nafter: {"value":"hello from D1"} / {"value":"goodbye from D1"}\n`.
Ordering markers confirm two complete suspend/resume cycles in sequence — the Asyncify stack
unwind/rewind is stateless across calls. Node V8 regression: PASS (stub fallback, no rebuild).

**Session 7 changes (on top of Session 6, no rebuild):**
- `wrangler.toml`: `[[d1_databases]] binding="DB"` added.
- `worker/index.mjs`: D1 handler registered per request; parses JSON payload, runs
  `env.DB.prepare(sql).bind(...params).first()`, returns `JSON.stringify(row)`.
  KV handler from Session 6 kept as comment.
- `PHP_CODE`: two sequential `fp_async_call` invocations with JSON payloads.
- Local D1 seed: `wrangler d1 execute DB --local --command "INSERT OR REPLACE INTO config..."`.

**Session 6 changes (on top of Session 5):**
- `fp_async_call` is now `string → string` (was `int → int`). Payload: UTF-8 key string.
  Return: `stringToNewUTF8`-allocated value, copied to PHP heap and freed by `pib.c`.
- `Module.hostAsyncCall` dispatch: if the property is a function, `fp_async_call` delegates
  and returns the handler's resolved string. Fallback: old stub (parseInt(payload)+1 as string)
  keeps all prior Node V8 tests passing.
- `wrangler.toml` KV binding (`KV`); `worker/index.mjs` registers the KV handler per request.

**Session 5 approach (ADR-0014 + ADR-0015, unchanged in Session 6).**
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
- `worker/index.mjs` — trampoline import + cache setup
- `worker/build/trampoline-vp.wasm` — 31-byte bundled vp-signature trampoline
- `worker/apply-workerd-patches.py` — Patch 3 added
- `patches/session5-static-libxml.patch` — env + Makefile changes for static build
- `docs/DECISIONS.md` — ADR-0014 (pre-session) + ADR-0015 (result)

**Session 6 committed files (on top of Session 5):**
- `worker/index.mjs` — KV handler registration, `env` parameter, string PHP script
- `wrangler.toml` — KV namespace binding
- `patches/session6-real-async.patch` — pib.c string ABI + library_fp_async.js handler
- `docs/DECISIONS.md` — ADR-0016

**Session 7 committed files (on top of Session 6, no rebuild):**
- `worker/index.mjs` — D1 handler, two-call PHP script, KV handler as comment
- `wrangler.toml` — D1 database binding added
- `docs/DECISIONS.md` — ADR-0017

**What all sessions established (all true):**
- Session 10: networking investigated (report-only). Companion exts use the same
  Asyncify mechanism; pdo_cfd1 is vrzno-coupled + stub-ridden; all three unlicensed —
  adoption blocked; fp_async_call stands (ADR-0020).
- Session 9 PASS: tidy/calendar/pdo_pglite stripped; 8.2 = 3.79 MiB gz, 8.4 = 3.95 MiB gz,
  combined 7.74 MiB — fits the 10 MB Paid limit. Static/dynamic split documented; WP
  extension floor finding recorded; intl in-binary cost = 0 B.
- Session 8 PASS: PHP 8.2.11 + 8.4.1 dual build; multi-version Worker serves either per
  request (`X-PHP-Version` header). Zero source-patch deltas vs the 8.0 stack.
- Session 7 PASS: D1 SQL consumer — two sequential queries from PHP mid-request, both PASS.
- Session 6 PASS: real async host call — PHP suspends on `env.KV.get()`, resumes with stored value.
- Session 5 PASS: Asyncify suspend/resume in workerd — `before:\nafter: 42\n`.
- Session 3 PASS: Asyncify suspend/resume in Node V8 — `before:\nafter: 42\n`.
- Session 2: `fp_async_call` import added; PHP calls it; binary size delta +1,257 B raw.
- Session 1: unmodified PHP 8.0.30 from source; runs synchronously in Node V8.
- iconv-resolution: GNU libiconv dropped (`WITH_ICONV=0`); no LGPL in binary (ADR-0011).

**Decided** (see `DECISIONS.md` for full reasoning):
- License: **Apache-2.0**, clean-derivation path.
- Lineage: derive from the **Apache-2.0** ancestor pipeline, not GPL Playground packages.
- Suspension mechanism: **Asyncify** (proven in Node V8 AND workerd). ADR-0002 complete.
- Toolchain: **PHP 8.2.11 + 8.4.1 dual build** (ADR-0018 supersedes the 8.0.30
  baseline; pipeline-pinned patch versions, not latest); Emscripten = **seanmorris
  fork 3.1.68 (`sm-updates`)**, not stock 4.0.19 (ADR-0007 supersedes ADR-0004).
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

6. **[DONE] Real async host call.** `fp_async_call` generalized to registered handler
   with string payload/return. First real consumer: `env.KV.get("greeting")`. Worker
   registers handler per request (`mod.hostAsyncCall = async key => env.KV.get(key)`);
   primitive stays store-agnostic. `curl http://localhost:8791/` → `before:\nafter: hello from KV\n`
   — PASS (2026-06-09). Node V8: regression + stub fallback + handler — all PASS.

7. **[DONE] D1 SQL consumer.** D1 wired as second consumer via JSON payload convention.
   Two sequential queries per request — both suspend/resume independently, proving Asyncify
   stack is stateless across calls. No rebuild. `curl http://localhost:8791/` →
   `before:\nafter: {"value":"hello from D1"} / {"value":"goodbye from D1"}\n` — PASS (2026-06-09).

8. **[DONE] PHP 8.2 + 8.4 dual build; multi-version Worker.** Both versions built from
   the same patched pipeline with zero source-patch deltas; both pass Node V8 + workerd
   D1 verification. Single deployment serves either version via `X-PHP-Version` header
   (default 8.4). Pipeline-pinned 8.2.11/8.4.1 (ADR-0018) — PASS (2026-06-10).

9. **[DONE] Binary size reduction.** Strippable static surface exhausted (tidy+libtidy,
   calendar, pdo_pglite): −6.2% gz per binary; combined 7.74 MiB gz fits the Paid limit.
   Static/dynamic split finding: most WITH_X=1 extensions are side modules, never in the
   binary — WP extension floor not met (named finding); intl in-binary cost 0 B
   (ADR-0019) — PASS (2026-06-10).

10. **[DONE] Networking investigation (report-only).** pdo_cfd1/vrzno/pdo_pglite read
    from source: same Asyncify mechanism as fp_async_call; pdo_cfd1 vrzno-coupled with
    WP-breaking stubs; all three unlicensed (adoption blocked); mysqli/curl absent by
    design; WP needs a Requests-transport shim under any architecture. fp_async_call
    NOT superseded; (a)-vs-(b) deferred to prototype-to-measure (ADR-0020,
    `docs/RESEARCH-networking.md`) — DONE (2026-06-10).

**The PoC is complete.** The ADR-0005 success criterion is satisfied in workerd.
ADR-0006 is fully satisfied. The Asyncify suspend/resume primitive is proven in
both Node V8 and Cloudflare Workers / workerd, against real async host operations (KV and D1).

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

**Session 10 done.** Networking architecture mapped (ADR-0020,
`docs/RESEARCH-networking.md`). `fp_async_call` stands as the foundation; the
DB-driver architecture choice ((a) all-through-fp_async_call vs (b) pdo_cfd1 for the
DB hot path) is deferred pending data. Two zero/low-cost follow-ups identified:
file upstream license-inquiry issues on vrzno/pdo-cfd1, and a prototype-to-measure
build.

**Potential next sessions (updated by Session 10):**

1. **Prototype-to-measure: vrzno (+pdo_cfd1) throwaway build.** `WITH_VRZNO=1`
   (+`WITH_PDO_CFD1=1`) on 8.4: gz size delta, workerd init (trampoline/GOT set),
   empirical EM_ASYNC_JS + fp_async_call Asyncify coexistence, one PDO-driven D1
   query. Output: the data ADR-0020 needs to settle (a) vs (b). Throwaway —
   nothing merges without the license question resolving.

2. **WordPress extension floor (static link).** Unchanged from Session 9: bring
   mbstring(+oniguruma), openssl, dom/xml/simplexml, sqlite3/pdo_sqlite, zip,
   gd(+image libs), fileinfo into the static link. mysqli is now settled — NOT
   needed (DB goes through PDO/fp_async_call per ADR-0020); curl likewise (HTTP
   goes through fetch + a WP Requests-transport shim).

3. **WP-side shims (architecture-invariant, can start anytime).** A Requests
   transport on `fp_async_call` (`{action:"fetch",…}`) and a `db.php`-style DB
   shim (Playground pattern, GPL-side). Both work regardless of the (a)/(b)
   outcome.

4. **JSPI port (the big size lever).** Unchanged from Session 9.

5. **R2 / Durable Objects consumers; PHP patch-version bump.** Unchanged.
