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

**Phase:** Session 13 PASS (2026-06-11) — **the WordPress extension floor is complete
on both versions** (ADR-0023): mbstring, dom/simplexml/xml/xmlreader/xmlwriter,
openssl, zip/zlib, fileinfo, gd (+exif/bcmath from before) all statically linked and
**functionally probed** in workerd on 8.4.1 and 8.2.11. GOT stayed `vp`-only through
all six batches. Pipeline finding: upstream's mbstring static mode was broken for
PHP 8.x (`--with-mbstring`/`--with-onig` silently ignored) — fixed in the session
patch. **Size: 8.4 = 8.51 MiB gz (38.5 MiB raw!), 8.2 = 7.38 MiB gz; combined
15.89 MiB gz — 66% over the 10 MiB Paid limit** (crossed at batch 2, per the ADR-0023
tripwire). Per-batch cost table in RESULTS. The fit-strategy decision is NEXT.

**Session 12 state (still true).** Session 12 PASS (2026-06-11) — **pdo_d1 Phase 1 shipped** (ADR-0022). The
clean-room Apache-2.0 D1 PDO driver builds and passes all gates on 8.4.1 AND 8.2.11:
prepare/bind/execute/fetch*, real exec() (meta.changes), real lastInsertId()
(meta.last_row_id), real rowCount(), PDOException with the D1 error text, safe
quote(), named params via PDO core's rewriter (driver calls pdo_parse_params in its
preparer — the POSITIONAL-driver pattern), typed binds. Transactions throw honestly
(Phase 2). workerd: full PDO session against miniflare D1 with an fp_async_call
interleave, both versions via header selection, 2 requests each. Driver cost: ~16 KB
raw / ~3–4 KB gz per binary. GOT still vp-only. Worker now sets
`mod.d1 = { main: env.DB }` permanently. Probe/mock deliverables:
`tests/test-pdo-d1-mock.mjs`; source as `patches/session12-pdo-d1.patch`.

**Session 11 state (still true).** Session 11 PASS (2026-06-11) — Asyncify mixed-packaging coexistence proven
(ADR-0021). A throwaway `EM_ASYNC_JS` suspender (`fp_async_probe`) ran interleaved
with the JS-library `fp_async_call` in one PHP execution in workerd: four suspensions,
two mechanisms, alternating, correct values, two consecutive requests. No trampoline/
GOT changes (still only `vp`); size delta noise (+2,333 B raw / −7 B gz). The
architecture decision is made: **option (a) — clean-room Apache-2.0 D1 PDO driver on
our own primitive**; vrzno/pdo_cfd1 are out entirely. Probe captured as
`patches/session11-coexistence-probe.patch` and reverted — canonical source is clean.

**Session 10 state (still true)** — networking investigation, report-only
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
- Session 13 PASS: full WP extension floor static on both versions, functionally
  probed; floor costs +4.56 MiB gz (8.4); combined bundle 15.89 MiB gz — over the
  Paid limit; per-version Workers fit today (8.51 / 7.38 MiB each); JSPI is the
  structural lever; trimming alone cannot fit (ADR-0023, RESULTS S13).
- Session 12 PASS: pdo_d1 Phase 1 — clean-room Apache-2.0 D1 PDO driver, all surfaces
  real (the pdo_cfd1 stub list), both PHP versions, ~16 KB raw cost. `new PDO('d1:main')`
  works in workerd against miniflare D1, interleaved with fp_async_call (ADR-0022).
- Session 11 PASS: EM_ASYNC_JS + JS-library Asyncify imports coexist in one binary in
  workerd, interleaved (4 suspensions/run). Clears the clean-room D1 PDO driver
  (ADR-0021, option a). GOT still `vp`-only; EM_ASYNC_JS overhead negligible.
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

11. **[DONE] Asyncify coexistence proof.** Throwaway EM_ASYNC_JS probe beside
    fp_async_call: interleaved 4-suspension run PASS in workerd ×2 requests; Node
    PASS; GOT unchanged (`vp` only); size delta noise. Probe recorded as
    `patches/session11-coexistence-probe.patch`, then reverted (ADR-0021) —
    PASS (2026-06-11).

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

**Session 13 PASS — and the fit-strategy decision is now forced.** The floor is
complete and functional, but the combined bundle (15.89 MiB gz) exceeds the 10 MiB
Paid limit. **Next session's FIRST step is ADR-0024: choose the fit strategy** on the
measured numbers (RESULTS Session 13):

- **(i) Per-version Workers — fits today** (8.4 = 8.51 MiB gz, 8.2 = 7.38 MiB gz,
  each under 10 MiB with headroom). Cheapest path to deployable; loses
  single-deployment header selection (router Worker or DNS/route split instead).
- **(ii) JSPI port — the structural lever.** Asyncify instrumentation multiplies
  every extension's code cost (see batch 2); JSPI removes it and helps the
  38.5 MiB-raw cold-start concern too. Worth measuring soon regardless of (i).
- **(iii) Trim — only as a complement**; cannot reach 10 MiB combined alone.

A pragmatic sequencing: adopt (i) now (unblocks everything downstream), schedule (ii)
as the optimization session, keep (iii) in reserve.

**Then (unchanged order):**
1. **WP-side shims** — db.php drop-in targeting pdo_d1 + Requests transport on
   fp_async_call. All runtime surfaces now exist (pdo_d1 + the full extension floor).
2. **pdo_d1 Phase 2** — transactions strategy, attributes, production-D1 meta
   re-verification.
3. **WordPress bootstrap** — now genuinely unblocked: DB path + extension floor done.
4. R2/DO consumers; PHP patch-version bump.
