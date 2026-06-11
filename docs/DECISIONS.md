# Decisions

A dated log of architecture and project decisions for `php-wasm-async`.
Newest entries at the top. Each entry records the decision, the reasoning,
the alternatives considered, and any follow-up obligations.

Format is loosely [ADR](https://adr.github.io/)-style. Decisions are not
immutable; a later entry may supersede an earlier one, in which case the
earlier one is marked **Superseded** with a pointer.

---

## ADR-0021 — Session 11: option (a) chosen — clean-room D1 PDO driver on our primitive; coexistence proven with our own probe instead of a vrzno prototype
**Date:** 2026-06-11 · **Status:** Accepted · **Resolves:** ADR-0020's deferred (a)-vs-(b) choice

**Decision (made before this session's build work, recorded first per protocol).**
The DB architecture is **option (a)**: a clean-room, Apache-2.0 **D1 PDO driver of our
own**, built as a second suspending extension beside `pib`/`fp_async_call`. The
unlicensed vrzno/pdo_cfd1 extensions are out entirely — not built, not measured, not
adopted. This supersedes ADR-0020's plan to prototype `WITH_VRZNO=1 + WITH_PDO_CFD1=1`
for measurement: that prototype would have compiled unlicensed code to answer a
question we can answer with ~20 lines of our own. The licensing inquiry to upstream
becomes moot for our path (the ADR-0020 findings about those extensions remain valid
as findings).

**The one assumption to verify before writing the driver.** Can a second
Asyncify-suspending extension function — packaged the `EM_ASYNC_JS` way, which is how
the driver will likely be written — coexist with the JS-library-packaged
`fp_async_call` in one binary in workerd, with both suspending and resuming correctly,
interleaved, in a single PHP execution? RESEARCH-networking §1 predicts yes
(Asyncify is a runtime facility; whole-program instrumentation per ADR-0008; PHP
single-threaded; Session 7 proved sequential suspensions stateless). Predicted-yes is
not measured-yes when ~700 lines of C depend on the answer.

**Method.** Throwaway probe in `pib.c` (8.4 only, Session 9 flag set):
`fp_async_probe(string): string` implemented as `EM_ASYNC_JS` resolving on a
`setTimeout(0)` macrotask (Session 3 rigor — genuinely unresolved at suspend time).
workerd test interleaves the two mechanisms: JS-lib suspend (D1 query) →
EM_ASYNC_JS suspend → JS-lib suspend → EM_ASYNC_JS suspend, four suspensions in one
PHP run, two consecutive requests. The probe is captured as
`patches/session11-coexistence-probe.patch` (our Apache-2.0 code, documents the proof)
and then reverted — it does not ship.

**Result (2026-06-11): PASS — coexistence confirmed.**
- **workerd, interleaved:** one PHP execution performed four suspensions alternating
  between the two packagings — JS-library D1 query → EM_ASYNC_JS probe → JS-library
  D1 query → EM_ASYNC_JS probe — all values correct
  (`hello from D1`, `probe:alpha`, `goodbye from D1`, `probe:beta`), identical on two
  consecutive requests. No state corruption, no hangs, no stack errors.
- **Node V8:** regression + Session 3 suspend/resume unchanged PASS; the same
  interleaved script PASS.
- **EM_ASYNC_JS compiles cleanly** under the sm-updates 3.1.68 fork (no special
  handling; `emscripten.h` already included in pib.c; `stringToNewUTF8` available).
- **Trampoline/GOT (open risk #3):** workerd init clean; zero
  `convertJsFunctionToWasm`/code-generation errors — no GOT.func signature beyond
  `vp` appeared; the single bundled trampoline still suffices.
- **Size:** probe build vs Session 9 final 8.4: raw +2,333 B, gz −7 B (noise). The
  fixed overhead of "one more EM_ASYNC_JS import" is negligible; the future driver's
  cost will be its own logic, not the import mechanism.

**What this clears.** The clean-room D1 PDO driver can be written as a second
suspending extension using `EM_ASYNC_JS` beside `pib`/`fp_async_call` with no
architectural risk identified. The probe is recorded as
`patches/session11-coexistence-probe.patch` and reverted from the tree — it does not
ship. First task for the driver session: confirm from Cloudflare's D1 docs that
`meta.last_row_id`/`meta.changes` suffice for `lastInsertId()`/affected-rows
(RESEARCH-networking open question #4).

---

## ADR-0020 — Session 10: networking-architecture findings; fp_async_call stands; vrzno/pdo_cfd1 adoption blocked on licensing, deferred to a measured prototype
**Date:** 2026-06-10 · **Status:** Accepted (findings final; the (a)-vs-(b) architecture choice is **decision-pending** a measured prototype)

**Context.** Session 9 found the WordPress extension floor unmet and mysqli/curl absent
from the pipeline. Session 10 investigated (report-only — `docs/RESEARCH-networking.md`)
how the upstream ecosystem intends DB/HTTP to work on Workers: the companion extensions
`pdo_cfd1` (D1 PDO driver), `vrzno` (JS bridge + fetch), `pdo_pglite`.

**Findings (recorded as binding facts, with source citations in the research doc).**
1. `pdo_cfd1` and `vrzno` suspend PHP via `EM_ASYNC_JS` — the **same Asyncify
   mechanism** as `fp_async_call`. No second mechanism; no suspension-ownership
   conflict; coexistence in one binary is expected safe (empirical verification
   pending).
2. `pdo_cfd1` hard-depends on vrzno (header include + zval↔JS proxy runtime); it is
   not standalone despite the repo split.
3. `pdo_cfd1` implements only prepare→execute→fetch. `PDO::exec()`, transactions,
   `lastInsertId()` (returns 0), `quote()` (no escaping), attributes, and error
   propagation are stubs — several are WordPress-breakers (`$wpdb->insert_id`).
4. **vrzno, pdo-cfd1, and pdo-pglite carry no license** (no LICENSE file; GitHub
   `license: null`). All-rights-reserved by default. The Apache-2.0 pipeline clones
   them from unpinned `master` at build time; its license does not cover them. Under
   ADR-0001/0003 we can neither ship nor fork them until upstream licenses them.
5. mysqli/curl are absent **by design**: `WITH_NETWORKING=1` only links Emscripten's
   WebSocket socket emulation. Intended architecture: DB via PDO companion drivers,
   HTTP via JS `fetch()`.
6. WordPress HTTP is not free under either candidate: WP's Requests library ships only
   cURL and fsockopen transports. A small WP-side transport shim is required
   regardless, and it can target `fp_async_call` today (no rebuild).
7. No WordPress integration exists anywhere in this ecosystem. The Playground
   `db.php`/SQLite-translation pattern (GPL) transfers conceptually to D1 and lives on
   the WordPress (GPL) side of the ADR-0003 boundary — it does not contaminate this
   repo regardless of what it targets.

**Decision.**
- **`fp_async_call` is NOT superseded.** It remains the project's async foundation
  (ADR-0016 invariant unchanged): proven in workerd, Apache-2.0-clean, already
  demonstrated against D1/KV, and sufficient to back both the DB and HTTP shims
  WordPress needs.
- **vrzno/pdo_cfd1 are not adopted in this decision.** Adoption is blocked on
  licensing (finding 4) and on the stub gaps (finding 3); the architecture choice
  between (a) everything-through-`fp_async_call` (incl. possibly our own thin PDO
  driver) and (b) pdo_cfd1-for-DB + `fp_async_call`-for-the-rest is **deferred to a
  prototype-to-measure session**: throwaway 8.4 build with `WITH_VRZNO=1`
  (+`WITH_PDO_CFD1=1`), measuring gz size delta, workerd init compatibility
  (trampoline/GOT), empirical Asyncify coexistence, and a PDO-driven D1 query.
- **Option (c) (adopt wholesale, retire `fp_async_call`) is rejected** — it maximizes
  unlicensed surface and discards the one licensed, proven primitive.
- File upstream license-inquiry issues on vrzno/pdo-cfd1 (zero cost; unblocks (b)).

**Consequences.** `WITH_VRZNO=0` stays in our env files (Session 8 decision
reaffirmed — now grounded: enabling it adds unlicensed code and unmeasured size, not
just an unused extension). Next-session candidates reordered in HANDOFF: the
prototype-to-measure session and the WP-side shims (which are architecture-invariant)
can proceed in either order; the WP extension floor session (Session 9 finding)
remains on the list independently.

---

## ADR-0019 — Session 9: binary size reduction by extension stripping; the static/dynamic split finding; gzip as the governing metric
**Date:** 2026-06-10 · **Status:** Accepted

**Goal.** Shrink each worker wasm for Cloudflare's Worker size limit, which is measured
in **compressed (gzipped) bytes**: 3 MB Free plan, 10 MB Paid plan. Session 8 baseline,
`gzip -9`: 8.2 = 4,250,384 B; 8.4 = 4,414,500 B; combined ≈ 8.27 MiB — under the Paid
limit but uncomfortably close. Gzipped size is the governing metric; raw size is recorded
as secondary (cold-start instantiation time).

**Pre-decision finding that reframes the session (the static/dynamic split).**
The pipeline is **dynamic-by-default**: for most packages, `WITH_X=1` means
`WITH_X=dynamic` — the extension is built as a WASM **side module** (`.so`), exactly as
ADR-0011 found for iconv. The main worker binary statically contains only:

- PHP core (Core, date, pcre, json, hash, SPL, standard, random, Reflection) plus the
  `--enable-*` static set: **bcmath, calendar, ctype, exif, filter, session, tokenizer,
  pdo, pdo_pglite, pib**, and **libxml + tidy** (the only two `=static` flags), and
- exactly two non-PHP archives in the final link: `libxml2.a` and `libtidy.a`
  (confirmed from the Session 8 link command).

Everything else flagged `=1` (mbstring, openssl, gd, dom, xml, simplexml, intl, sqlite,
zip, zlib, yaml, phar, …) ships as side modules — which workerd **cannot load** (runtime
wasm compilation is blocked, ADR-0015; no side module is bundled or loaded by the
Worker). Two consequences:

1. **The WordPress MUST-KEEP extension floor is not met by the current binaries and
   never was.** mysqli/curl don't exist in this pipeline at all (`WITH_NETWORKING=0`);
   mbstring, openssl, gd, dom, sqlite, zip, fileinfo are side modules invisible to
   workerd. This is a named finding, not a Session 9 regression. Bringing the WP floor
   into the static link is a **separate future session** and will *grow* the binary —
   the sizes achieved here are the floor of the *current* capability set.
2. **intl is already absent from the worker binary.** Its measured in-binary cost is
   **0 bytes** (evidence: `get_loaded_extensions()` lacks intl; the final link contains
   no ICU archive; `SKIP_LIBS` excludes `-licu*`). The conditional Phase 3
   strip-or-keep decision is moot; no throwaway build is needed — per the ADR-0011
   precedent, side-module flags do not change the main binary. `WITH_INTL=1` is left
   as-is (it only affects unused side-module artifacts).

**Decision — what is stripped from the static set (8.4 first, then replicated to 8.2):**

| Flag change | Drops | Why safe for WordPress |
|---|---|---|
| `WITH_CALENDAR=0` | ext/calendar | Julian/Jewish/French-Revolutionary calendar conversions; WP does not use it |
| `WITH_PDO_PGLITE=0` | ext/pdo_pglite | Postgres-in-wasm PDO driver (pipeline default `=1` crept back in Session 8; the 8.0 env had it 0). D1 path does not use it |
| `WITH_TIDY=0` | ext/tidy + `libtidy.a` | WP does not use tidy. Session 5 chose `static` only because `WITH_TIDY=1`(=dynamic) conflicted with `WITH_LIBXML=static`; tidy's `static.mak` imposes **no constraint at `WITH_TIDY=0`** — verified. Also simplifies NOTICE (libtidy attribution no longer load-bearing) |

**What is kept, deliberately:**
- `WITH_LIBXML=static` — required to avoid the GOT/addFunction init blocker
  (ADR-0014/0015). ext/libxml + libxml2.a stay.
- bcmath, ctype, exif, filter, session, tokenizer, pdo — all on the WP required/
  recommended floor (or its dependencies) and individually small.
- All `=1` side-module flags — they cost the worker binary nothing; setting them to 0
  would only skip building unused `.so` artifacts while adding diff noise against
  upstream env files.

**Method.** Phased and measured per the working protocol: Phase 1 (calendar + pglite),
Phase 2 (tidy), each with rebuild → `gzip -9` measurement → Node V8 regression +
suspend/resume → workerd D1 two-query smoke; Phase 4 replicates the final validated set
to 8.2 and re-verifies the multi-version Worker. An extension sanity line is added to
the demo PHP (`extension_loaded()` checks over the WP MUST-KEEP list) — expected to show
most MUST-KEEP entries absent (consequence 1), with bcmath present.

**Size expectation, stated honestly in advance.** The strippable static surface is
small (tidy + calendar + pglite). The bulk of the binary is PHP core ×
whole-program-Asyncify instrumentation (ADR-0008) + libxml2. The ≤3.5 MB-gzipped
per-binary target is likely unreachable by stripping alone; if so, the result to record
is the floor and its composition — the levers that remain are JSPI (drops Asyncify
instrumentation, HANDOFF option) and one-Worker-per-version deployment.

**Alternatives considered.**
- Strip intl preemptively: moot — not in the binary (see finding above).
- `OPTIMIZE=z` / link-flag tuning: out of scope by session definition (extension
  stripping only); a future size session may try it.
- Stripping session/exif/filter to chase the target: rejected — WP floor violation for
  marginal bytes.
- Setting all side-module flags to 0 for "cleanliness": rejected — zero effect on the
  deliverable binary, large diff against upstream env files.

---

## ADR-0018 — Session 8: dual PHP 8.2 + 8.4 build; multi-version Worker loader with header-based selection
**Date:** 2026-06-10 · **Status:** Accepted · **Supersedes:** ADR-0004's PHP 8.0.30 baseline (the 8.0.30 *historical* results stand; 8.0.30 is no longer the build target)

**Decision.** Build PHP **8.2** and **8.4** WebAssembly binaries from the same patched
pipeline that produced the Session 1–6 PHP 8.0.30 binaries, validate both (Node V8
regression + workerd D1 smoke test), and update the Worker to serve **both versions from
a single deployment**, selecting the binary per request via the `X-PHP-Version` header
(default: `8.4`).

**Why both versions.**
- **8.2** — broadest compatibility floor for existing PHP applications and plugins that
  lag on 8.3+/8.4 support; still in security-support upstream.
- **8.4** — current stable branch; future-proofs the runtime and is the sensible default
  for new deployments.
- 8.0.30 (EOL since 2023) was only ever a continuity baseline (ADR-0004 said so
  explicitly); with the PoC complete it has served its purpose.

**Exact patch versions: pipeline-pinned, not "latest".** The seanmorris pipeline pins
`PHP_VERSION_FULL` per branch in its Makefile: **8.2 → 8.2.11** and **8.4 → 8.4.1**.
These — not the latest upstream patch releases — are what `PHP_VERSION=8.2/8.4` builds,
because the pipeline's per-version source patches (`third_party/php*-src/patched`) are
validated against those tags. Consistent with ADR-0007's principle (build what the
reference pipeline validates; don't float), Session 8 builds the pinned versions.
Bumping `PHP_VERSION_FULL` to a newer patch release is a separate, later decision with
its own validation pass.

**Env files.** Upstream ships `.circleci/.env_8.2.ci` and `.env_8.4.ci`; they differ
from `.env_8.0.ci` only in the version string and `WITH_VRZNO=1`. Session 8 applies the
same three modifications validated in Sessions 5–6 to both files — `WITH_ICONV=0`
(ADR-0011), `WITH_LIBXML=static` + `WITH_TIDY=static` (ADR-0014/0015) — and sets
`WITH_VRZNO=0` for parity with the validated 8.0 extension set (vrzno is a
browser-oriented JS-interop extension; not needed for the workerd target and would add
an unvalidated variable).

**Multi-version Worker loader.** `worker/index.mjs` imports both wasm binaries and both
Emscripten glue modules **statically** (wrangler bundles and AOT-compiles all `.wasm`
imports at deploy time — the same property the trampoline fix relies on, ADR-0015;
dynamic `import()` of glue at request time is not part of wrangler's supported bundling
model). Version selection happens at request time by choosing which already-imported
module factory + wasm module to instantiate:

```js
const v = request.headers.get('X-PHP-Version') ?? '8.4';
```

Unknown/absent header values fall back to the default (`8.4`) rather than erroring —
the Worker always serves a supported runtime.

**Invariants carried forward.** `fp_async_call`, `pib.c`, and `library_fp_async.js` are
expected to be version-agnostic; no changes to the async primitive are part of this
decision. If a PHP-internals API change in 8.2/8.4 forces a `pib.c` delta, it is
documented as a named finding in BUILD.md/RESULTS.md, kept minimal, and must not
introduce store-specific code (ADR-0016 invariant).

**Alternatives considered.**
- Single version (8.4 only): simpler, but loses the 8.2 compatibility floor that
  real-world PHP applications need; serving both from one deployment is the actual
  capability being proven (per-site PHP version selection).
- 8.3 instead of 8.2: 8.3 is neither the compatibility floor nor the current branch;
  it adds a third build for no additional coverage.
- Latest patch releases (8.2.28+/8.4.x-latest) via `PHP_VERSION_FULL` override:
  rejected for this session — floats the source against unvalidated pipeline patches
  (ADR-0007 principle). Revisit as its own decision if a security fix demands it.
- Version selection via URL path or query parameter: a header keeps the URL space
  untouched for the eventual application (WordPress routes own the path space).

---

## ADR-0017 — Session 7: D1 (SQL) as second consumer; JSON as the consumer-owned payload encoding
**Date:** 2026-06-09 · **Status:** Accepted

**Decision.** Wire Cloudflare D1 (serverless SQLite) as the second consumer of `fp_async_call`,
demonstrating PHP executing a SQL query mid-request by suspending on a real D1 async call and
resuming with the query result. **No rebuild is required** — the `fp_async_call` ABI
(`string → string`) established in ADR-0016 is already sufficient.

**The generic-primitive invariant (from ADR-0016, restated for emphasis).**
`library_fp_async.js` and `pib.c` must not change in this session and must not reference D1.
The primitive passes a string payload from PHP and returns a string result to PHP. All
encoding, dispatch, and store-access logic belongs to the Worker's `mod.hostAsyncCall` handler.

**Payload encoding decision — JSON, owned by the consumer.**
KV (Session 6) used a flat string as the payload (the key name). D1 needs to pass structured
data: an action discriminant, a SQL string, and query parameters. The encoding choice — JSON
— is made by this consumer and is not baked into `fp_async_call`. Document this as a convention:
consumers may use any serialization they choose; `fp_async_call` is transport-agnostic.

For this consumer, the convention is:
- **PHP sends:** `JSON.stringify({action, sql, params})`, e.g.
  `'{"action":"query","sql":"SELECT value FROM config WHERE key=?","params":["greeting"]}'`
- **Handler returns:** `JSON.stringify(firstRow)`, e.g. `'{"value":"hello from D1"}'`
- PHP receives the JSON string and can decode it with `json_decode()`.

This is not a framework — it is the minimal convention for one consumer. Future consumers
may use different encodings; the primitive does not impose one.

**What changes in Session 7.**

1. **`wrangler.toml`** — adds a `[[d1_databases]]` binding (`binding = "DB"`). The `database_id`
   is a placeholder for local development; `wrangler dev --local` creates the SQLite file
   automatically in `.wrangler/state/d1/`.

2. **`worker/index.mjs`** — the `mod.hostAsyncCall` handler is replaced with a D1 dispatcher:
   ```js
   mod.hostAsyncCall = async (payload) => {
       const req = JSON.parse(payload);
       if (req.action === 'query') {
           const row = await env.DB.prepare(req.sql).bind(...(req.params ?? [])).first();
           return JSON.stringify(row ?? null);
       }
       return JSON.stringify({error: 'unknown action'});
   };
   ```
   The KV handler from Session 6 is kept as a comment for reference.

3. **`PHP_CODE`** — updated to use the JSON convention:
   ```php
   $result = fp_async_call('{"action":"query","sql":"SELECT value FROM config WHERE key=?","params":["greeting"]}');
   echo "after: " . $result . "\n";
   ```

4. **Local D1 setup** — schema and seed applied once via `wrangler d1 execute`:
   ```bash
   wrangler d1 execute DB --local --command \
     "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);"
   wrangler d1 execute DB --local --command \
     "INSERT OR REPLACE INTO config VALUES ('greeting','hello from D1'),('farewell','goodbye from D1');"
   ```

**Stretch goal: sequential suspension.** Two `fp_async_call` invocations in sequence —
each suspends and resumes independently. This directly validates that the Asyncify stack
unwind/rewind is stateless across calls (critical for WordPress, which makes many DB calls
per request). Seeding a second key (`farewell`) and running the two-call PHP script proves this.

**No rebuild required.** The wasm binary is unchanged. The trampoline fix, all glue patches,
and the Session 6 artifacts are reused without modification.

**Alternatives considered.**
- Binary payload (e.g. msgpack): more efficient but harder to read and not justified for a PoC.
- Separate host functions per store (`fp_d1_query`, `fp_kv_get`): requires a new C function,
  new arginfo, and a recompile per store. Rejected — the whole point of the generic primitive
  is that the Worker handles dispatch; the wasm binary stays unchanged across stores.
- Protocol buffer or CBOR encoding: over-engineered for a PoC; JSON is readable and builtin.

---

## ADR-0016 — Session 6: generalize fp_async_call to a registered string handler; KV as first real consumer
**Date:** 2026-06-09 · **Status:** Accepted

**Decision.** Generalize `fp_async_call` from a hardcoded `int → int` stub to a generic
registered-handler mechanism with `string → string` payload and return type. The first
real consumer is a Cloudflare KV read — demonstrating PHP suspending on a genuine async
host operation and resuming with the actual stored value.

**The generic-primitive rule (invariant — must not be violated by this or future sessions).**
`fp_async_call` must remain **store-agnostic**. It does not know what KV, D1, or R2 are.
The host-side handler is registered per-request by the Worker; `fp_async_call`/`pib.c`
contain no store-specific code. KV is the first *consumer* of the generic primitive, not
a dependency baked into it. This principle is stated in `DESIGN.md` and must be enforced
at every session boundary.

**Changes in this decision.**

1. **String payload and return (`pib.c`, `library_fp_async.js`).** The `int` payload/return
   of Sessions 1–5 was a minimal PoC convenience. Real host operations pass keys (strings)
   and return values (strings). This session changes the C extern declaration, the PHP
   function arginfo, and the JS library to use `char*` (UTF-8 string pointers in the wasm
   heap):
   - `extern char* fp_async_call(const char* payload)` — the JS library allocates the
     return string via `stringToNewUTF8`; C calls `free()` after copying to PHP's heap.
   - `PHP_FUNCTION(fp_async_call)` — accepts `IS_STRING`, returns `IS_STRING`. PHP type
     coercion (non-strict mode) means passing an integer literal still works; existing
     tests pass without modification.

2. **Registered handler (`Module.hostAsyncCall`).** The JS library reads
   `Module.hostAsyncCall` at call time. If set, it delegates to it and awaits the result.
   If unset, it falls back to the old `setTimeout(0)` stub returning `String(parseInt(payload)+1)` — identical behavior for all prior Node V8 tests. The Worker registers
   the handler on the module instance before running PHP:
   ```js
   mod.hostAsyncCall = async (key) => (await env.KV.get(key)) ?? '';
   ```
   `Module` inside the JS library refers to the Emscripten module instance (`mod`), so
   the property is set on the same object.

3. **KV binding (`wrangler.toml`, `worker/index.mjs`).** A `[[kv_namespaces]]` entry with
   `binding = "KV"` is added to `wrangler.toml`. For `wrangler dev --local`, miniflare
   provides the KV store with no Cloudflare credentials. The seed key
   `greeting → hello from KV` is put via the wrangler CLI once; it is not hardcoded in
   the worker. The PHP script changes to `fp_async_call("greeting")`.

**Rebuild required.** Changing `pib.c` forces the ext re-copy, reconfigure, recompile, and
relink — same shape as Session 2. The rebuild uses the same toolchain and
`WITH_LIBXML=static`/`WITH_TIDY=static` config as Session 5. No new binary-level changes are
expected beyond the `fp_async_call` ABI change (int → pointer pair).

**Success criterion.** PHP suspends on a genuine `env.KV.get("greeting")` (a real Promise,
unresolved at call time) and resumes with the actual stored value, in workerd, producing
`before:\nafter: hello from KV\n`. The primitive remains store-agnostic.

**Alternatives considered.**
- Keep `int` payload and encode keys/values as integers: rejected — not a real demo and
  adds an encoding layer that obscures the KV usage.
- Pass raw opaque bytes (`void*`/ArrayBuffer): more general but over-engineered for the PoC;
  UTF-8 strings are the natural type for KV keys and string values.
- Hardcode KV calls in `library_fp_async.js`: explicitly rejected — violates the generic-
  primitive rule in `DESIGN.md`.

---

## ADR-0015 — Session 5 PASS: Asyncify works in workerd with static libxml + pre-compiled trampoline
**Date:** 2026-06-09 · **Status:** Accepted · **Supersedes:** ADR-0012, ADR-0013 (prescription); **Corrects (in part):** ADR-0014

**Result.** The ADR-0005 success criterion is satisfied in workerd:
`curl http://localhost:8791/` returns `before:\nafter: 42\n`.
The Asyncify suspend/resume cycle completes inside workerd:

```
[fp_async_call] invoked payload=41
[fp_async_call] promise registered, returning control to host
[fp_async_call] timer fired, resolving promise -> 42
[fp_async_call] wasm resumed, returning 42
```

`before:` is printed before the timer fires; `after: 42` is printed after — the ordering proof is identical to Session 3 (Node V8). ADR-0002's "Asyncify first" path is complete. ADR-0006's hard-kill criterion is satisfied in workerd as well as Node V8.

**Correction to ADR-0014's root-cause analysis.** ADR-0014 identified the blocker as
"four libxml2 GOT symbols (`xmlStrdup`, `xmlStrncmp`, `xmlURIUnescapeString`, `xmlUnlinkNode`)
leave `addFunction` firing during `xmlInitParser()`." That was accurate but incomplete.

After `WITH_LIBXML=static` (which statically links `lib/lib/libxml2.a` and eliminates
those four symbols), the worker still hit the SAME stack trace. Debug instrumentation
identified 6 different symbols:

| GOT.func symbol | JS function name | sig |
|---|---|---|
| `emscripten_console_log` | `_emscripten_console_log` | `vp` |
| `emscripten_console_error` | `_emscripten_console_error` | `vp` |
| `emscripten_console_warn` | `_emscripten_console_warn` | `vp` |
| `emscripten_console_trace` | `_emscripten_console_trace` | `vp` |
| `emscripten_out` | `_emscripten_out` | `vp` |
| `emscripten_err` | `_emscripten_err` | `vp` |

All six are Emscripten's console/output functions. They appear in the main wasm's
`GOT.func` section because C code (in PHP, libxml2, libtidy, or Emscripten runtime)
holds function pointers to them. `resolveGlobalSymbol` finds them as JS functions in
`wasmImports` (not as wasm exports), so `addFunction` → `convertJsFunctionToWasm` fires.

**General root cause (correcting ADR-0014's narrow reading).**
Emscripten MAIN_MODULE=1 always runs `reportUndefinedSymbols` after instantiation —
even with no dynamic libs. For every GOT.func entry whose value is still 0 and whose
symbol resolves to a JS function in `wasmImports`, `addFunction` tries to:
1. `setWasmTableEntry(slot, jsFunc)` → fails (TypeError: funcref tables reject plain JS functions).
2. `convertJsFunctionToWasm(jsFunc, sig)` → tries `new WebAssembly.Module(bytes)` → BLOCKED.

Switching libxml2 to static resolves the libxml2 GOT entries but not the 6 Emscripten
console entries. The underlying incompatibility is: MAIN_MODULE=1 requires runtime wasm
compilation for GOT.func JS-function trampolines; workerd blocks ALL runtime wasm
compilation (synchronous AND asynchronous via `WebAssembly.compile`).

**Fix: wrangler-bundled trampoline module.**
Wrangler compiles `.wasm` imports at bundle time (pre-AOT) and makes them available as
`WebAssembly.Module` objects. The only path that works in workerd is:
`new WebAssembly.Instance(pre_bundled_module, {e: {f: jsFunc}})`.

All 6 symbols use the same signature `vp` (void, i32). A single 31-byte trampoline wasm
encapsulates the type signature and re-exports the import:

```
[wasm magic + version]  0,97,115,109,1,0,0,0
[type section]          1,5,1,96,1,127,0       // (i32)->void
[import "e"."f"]        2,7,1,1,101,1,102,0,0
[export "f"]            7,5,1,1,102,0,0
```

`trampoline-vp.wasm` (31 bytes) is committed to `worker/build/trampoline-vp.wasm`.
`worker/index.mjs` imports it (`import trampolineVP from './build/trampoline-vp.wasm'`)
and sets `globalThis.__phpWasmTrampolines = new Map([['vp', trampolineVP]])` in the
`instantiateWasm` hook before PHP module instantiation.
`apply-workerd-patches.py` Patch 3 replaces `new WebAssembly.Module(bytes)` in
`convertJsFunctionToWasm` with a cache lookup:
```js
var module = globalThis.__phpWasmTrampolines && globalThis.__phpWasmTrampolines.has(sig)
    ? globalThis.__phpWasmTrampolines.get(sig)
    : new WebAssembly.Module(new Uint8Array(bytes));  // fallback for non-workerd
```

**What this supersedes.**
- ADR-0012: the Asyncify+MAIN_MODULE binary IS compatible with workerd when the
  GOT.func trampolines are pre-compiled at bundle time. The "hard stop" is resolved.
- ADR-0013: JSPI is not required for the PoC. ADR-0002's "Asyncify first" completes.
  JSPI remains a valid optimization path (smaller binary, less overhead) for Session 6.
- ADR-0014: the root cause is the full MAIN_MODULE GOT.func trampoline requirement, not
  specifically the four libxml2 symbols. `WITH_LIBXML=static` is a prerequisite (it
  eliminates the dynamic libxml2 side module and the libxml2 GOT entries) but is not
  sufficient on its own — the 6 Emscripten console trampolines must also be resolved.

**Binary sizes (Session 5).**

| Artifact | Session 4 (WITH_LIBXML=dynamic) | Session 5 (WITH_LIBXML=static) |
|---|---|---|
| `php8.0-worker.mjs.wasm` raw | 12,183,180 B | 15,831,979 B |
| `php8.0-worker.mjs` glue raw | 309,714 B | 309,714 B |
| `trampoline-vp.wasm` | — | 31 B |

The +3.6 MB wasm increase is libxml2.a (~7.5 MB raw, ~3.6 MB of effective code after linking) plus libtidy.a (required when `WITH_TIDY=static`, forced by the tidy/libxml dependency constraint).

---

## ADR-0014 — Session 5 reframing: the blocker is dynamic linking, not Asyncify; change one variable
**Date:** 2026-06-09 · **Status:** Accepted (the approach stands); **Partially corrected by ADR-0015** (root cause was more general than libxml2 alone) · **Supersedes (in part):** ADR-0012, ADR-0013

**Reframing.** ADR-0012 concluded "Asyncify+MAIN_MODULE binary incompatible with workerd" and
ADR-0013 concluded "switch to JSPI." This was premature: the Session 4 failure happened in the
*init path* (`xmlInitParser()` → `loadDylibs` → `reportUndefinedSymbols`), before Asyncify
suspension machinery was ever reached. Asyncify-in-workerd was never tested — only the
dynamic-linking init path was tested. The two issues are independent:

1. **Dynamic-linking init blocker** — `MAIN_MODULE=1 → loadDylibs → reportUndefinedSymbols →
   addFunction → convertJsFunctionToWasm → new WebAssembly.Module(bytes)` is blocked by workerd.
   This fires because four libxml2 symbols (`xmlStrdup`, `xmlStrncmp`, `xmlURIUnescapeString`,
   `xmlUnlinkNode`) are undefined in the main wasm binary under `WITH_LIBXML=dynamic`.
2. **Asyncify suspension in workerd** — completely untested. May work fine.

Combining both changes (linking fix + JSPI switch) in one session conflates two independent
variables. Good experimental practice requires changing one at a time.

**Decision.** Session 5 changes **one variable**: fix the linking blocker by switching
`WITH_LIBXML=static` (detailed below), keeping Asyncify. If Asyncify suspension then
works in workerd, the PoC is complete. Only if Asyncify suspension genuinely fails in
workerd does Session 6 address JSPI.

ADR-0013's finding (JSPI is confirmed available in workerd) remains valid and useful;
only its prescription ("use JSPI for workerd") is premature pending the Session 5 result.

**The surgical fix: `WITH_LIBXML=static`.**

The pipeline's `packages/libxml/static.mak` has three relevant modes:
- `dynamic` (current, `WITH_LIBXML=1`): libxml2 is a dynamic side module (`DYNAMIC_LIBS_GROUPED+= xml-libs`). libxml2.a is NOT in `ARCHIVES`. GOT entries for libxml2 symbols are zero (undefined) → `reportUndefinedSymbols` → `addFunction` → BLOCKED.
- `static` (chosen): `ARCHIVES+= lib/lib/libxml2.a`, `DYNAMIC_LIBS_GROUPED` NOT updated. All libxml2 symbols statically linked; GOT entries non-zero → `reportUndefinedSymbols` finds nothing → `addFunction` never fires → no WebAssembly.Module(bytes) call → unblocked.
- `0` (`--disable-libxml`): drops ext/libxml, ext/dom, ext/simplexml, ext/xml, ext/xmlreader, ext/xmlwriter, ext/soap — unacceptable capability loss for a PoC targeting WordPress-like workloads.

`WITH_LIBXML=static` keeps `MAIN_MODULE=1`, keeps Asyncify, keeps full PHP XML capabilities,
and eliminates exactly the four undefined symbols causing the init blocker. Binary size
increases by approximately the size of libxml2.a (~1–2 MB raw); functional behavior is identical.

**What this supersedes in ADR-0012.**
The framing "Asyncify+MAIN_MODULE binary incompatible with workerd" is overstated. The correct
framing is "Asyncify+MAIN_MODULE+WITH_LIBXML=dynamic binary incompatible with workerd because
LIBXML_DYNAMIC_LOAD=1 leaves four libxml2 symbols undefined in the GOT." MAIN_MODULE=1 is not
the direct cause; the undefined symbols are.

**What this supersedes in ADR-0013.**
The prescription "JSPI is the designated path for the workerd integration" is deferred pending
the Session 5 result. If Asyncify suspension works in workerd after the linking fix, ADR-0002
(Asyncify first, JSPI as optimization) stands unchanged. If Asyncify suspension fails in workerd
for a genuine mechanism reason (not a linking issue), that is the trigger for JSPI (Session 6).

**Alternatives considered (linking fix).**
- `MAIN_MODULE=0` — drops the dynamic linking infrastructure entirely; loadDylibs/reportUndefinedSymbols never run. More comprehensive but breaks side-module loading (other extensions use it). Rejected as over-broad; WITH_LIBXML=static is more surgical.
- `--disable-libxml` — removes ext/libxml and the four symbols. Works, but drops capabilities needed for the eventual WordPress target. Acceptable only as a last resort.

---

## ADR-0013 — JSPI confirmed available in workerd; designated path for workerd integration
**Date:** 2026-06-08 · **Status:** Accepted (JSPI availability finding stands); prescription ("JSPI required for workerd") superseded by ADR-0015 (Asyncify works in workerd) · **Depends on:** ADR-0012

**Decision.** JSPI (JavaScript-Promise Integration) is the designated mechanism for
the workerd integration. Session 4 probe confirmed that workerd (wrangler 4.96.0,
compatibility date 2024-09-23) natively provides `WebAssembly.Suspending`,
`WebAssembly.promising`, and `WebAssembly.SuspendError`. Asyncify is NOT the right
approach for workerd (see ADR-0012 for why). JSPI avoids Asyncify instrumentation
entirely and uses the runtime's native suspension mechanism.

**What was probed.** A minimal worker (`export default { fetch() { return new Response(Object.getOwnPropertyNames(WebAssembly).join(', ')); } }`) returned:
```
WebAssembly.Function: undefined
WebAssembly keys: compile, validate, instantiate, Module, Instance, Table, Memory, Global, Tag, JSTag, Exception, CompileError, LinkError, RuntimeError, Suspending, promising, SuspendError
```

Key findings:
- `WebAssembly.Suspending` and `WebAssembly.promising` are available — JSPI works.
- `WebAssembly.Function` (type reflections proposal) is NOT available — needed by
  Emscripten's `addFunction` for dynamic-linking stubs (ADR-0012 blocker).
- `new WebAssembly.Module(bytes)` is blocked at runtime — same ADR-0012 blocker.

**JSPI approach for Session 5.** The correct workerd build will:
1. Rebuild PHP wasm with `-sJSPI=1` (Emscripten JSPI) and `JSPI_IMPORTS=fp_async_call`.
2. Resolve the dynamic-linking blocker (ADR-0012) — either by rebuilding without
   MAIN_MODULE (static-only) or with `--disable-libxml` to eliminate undefined symbols.
3. Use `WebAssembly.Suspending` to wrap `fp_async_call` as a suspending import.
4. Use `WebAssembly.promising` to wrap `pib_run` as a Promise-returning export.
5. The `await pib_run(...)` call then suspends/resumes without any Asyncify
   instrumentation in the wasm binary.

JSPI was always the planned Session 5 optimization; the Session 4 finding
accelerates that plan to replace Asyncify entirely for the workerd target.

---

## ADR-0012 — workerd hard stop: Asyncify+MAIN_MODULE binary incompatible with workerd
**Date:** 2026-06-08 · **Status:** Superseded by ADR-0015 (the binary IS compatible once GOT.func trampolines are pre-compiled at bundle time) · **Per:** ADR-0006 hard-stop criterion

**Decision.** Session 4 encountered a hard blocker: the Asyncify binary built by the
seanmorris pipeline with `MAIN_MODULE=1` (dynamic linking) cannot initialize in
workerd. The project stops the Asyncify workerd path and records the blocker.
The Node V8 result (Session 3 PASS) stands and is the permanent evidence that the
Asyncify primitive works. Session 5 will target workerd via JSPI with a new binary.

**Root cause (three-level failure chain).**
```
receiveInstance → loadDylibs → reportUndefinedSymbols → addFunction
→ convertJsFunctionToWasm → new WebAssembly.Module(bytes) → BLOCKED
```
1. The seanmorris pipeline links the main wasm with `MAIN_MODULE=1`, enabling
   dynamic side-module loading. The GOT (Global Offset Table) is part of the
   binary's dynamic-linking infrastructure.
2. Four libxml2 symbols (`xmlStrdup`, `xmlStrncmp`, `xmlURIUnescapeString`,
   `xmlUnlinkNode`) are referenced by root C code but unresolved in the static
   archives. The dynamic-linking runtime (`reportUndefinedSymbols`) tries to
   create JS stub functions and add them to the wasm function table.
3. Adding JS stubs to the wasm function table requires creating wasm-typed
   functions. Emscripten does this via:
   - `WebAssembly.Function` (type reflections) — NOT in workerd.
   - `new WebAssembly.Module(bytes)` — BLOCKED in workerd ("Wasm code generation
     disallowed by embedder"). `WebAssembly.Table.set()` rejects plain JS functions.
4. The stubs ARE needed at startup (not just when XML functions are called):
   ext/libxml is a statically-compiled PHP extension; its MINIT function calls
   `xmlInitParser()` during `php_module_startup()` → `php_embed_init()` → our
   `pib_init('embed')`. This fires before any PHP code runs.

**What worked (up to the blocker).**
- Three glue patches discovered and validated:
  1. `self.location.href` guard — required for workerd ESM module format (vs.
     service worker format where `self.location` is always defined).
  2. `addEventListener(..., true)` → `false` — required (workerd forbids capture).
  3. `instantiateWasm` hook — WORKS: WebAssembly.instantiate(precompiledModule,
     imports) succeeds; wasm instantiates; receiveInstance is called.
- wrangler 4.96.0 bundles and serves the 12 MB wasm correctly.
- The wasm instantiation itself (WebAssembly.instantiate from a pre-compiled
  WebAssembly.Module) is completely unblocked.

**Workarounds attempted and why they fail.**
- Make `reportUndefinedSymbols` a no-op: GOT entries remain 0; wasm calls via
  those entries hit index 0 (`unreachable` trap) during `xmlInitParser`.
- Return raw JS function from `convertJsFunctionToWasm`: `WebAssembly.Table.set()`
  rejects it — "function-typed object must be null or a Wasm function object".
- Dummy table index in GOT: wrong function called with wrong signature → type
  mismatch or corruption during `xmlInitParser`.

**Path forward (Session 5).**
- ADR-0013: use JSPI (natively available in workerd).
- Build change required: rebuild without MAIN_MODULE (or with `--disable-libxml`
  to drop ext/libxml and its libxml2 undefined symbols), plus `-sJSPI=1`.
- This is a targeted rebuild of the link step (no PHP recompile if only link
  flags change). Estimated: 5–15 minutes (link-only, no C recompile).

---

## ADR-0011 — Libiconv LGPL resolution: drop `WITH_ICONV=0`; corrects NOTICE analysis error
**Date:** 2026-06-07 · **Status:** Accepted · **Resolves:** ADR-0009 deferred obligation

**Decision.** Set `WITH_ICONV=0` in the build configuration (`.circleci/.env_8.0.ci`),
dropping GNU libiconv and `ext/iconv` entirely from the build. The main wasm binary
is unchanged by this; only the iconv side-module artifacts are removed.

**Critical finding (corrects NOTICE and RESULTS.md Session 1 analysis).** GNU
libiconv 1.17 was **never** statically linked into the main wasm binary. The build
config `WITH_ICONV=1` translates to `WITH_ICONV=dynamic` in `packages/iconv/static.mak`.
In `dynamic` mode:
- GNU libiconv is compiled as a WASM side module (`packages/iconv/libiconv.so`), not
  added to `ARCHIVES` (confirmed: `make -n -p` shows `ARCHIVES =` empty).
- PHP's ext/iconv is also compiled as a side module (`packages/iconv/php8.0-iconv.so`).
- PHP's core `php_config.h` has `HAVE_ICONV` and `HAVE_LIBICONV` both `#undef` —
  zero iconv code is compiled into the main wasm binary.
- The NOTICE's "Action required" statement ("statically linked libiconv.a + libcharset.a")
  was an analysis error: it identified the intermediate build artifact (`lib/lib/libiconv.a`,
  built as a step to produce the side module `.so`) as a direct static link, which it is
  not. The `ARCHIVES` variable (which controls what is statically linked) is empty.

Despite this correction, GNU libiconv (LGPL) IS present in the full runtime distribution
as a side-module file. Even with its lighter LGPL dynamic-linking obligations (users can
replace the `.so`), the cleanest Apache-2.0 outcome is to drop it entirely.

**Why drop rather than keep-and-document.** Setting `WITH_ICONV=0`:
- Removes GNU libiconv in any form from the build and distribution.
- Eliminates all LGPL-related obligations — no relinking, no source availability notice.
- Has zero impact on the main wasm binary (same binary, same session proofs remain valid).
- Does not affect `ext/mbstring` (uses Oniguruma + PHP's libmbfl, both permissive) or
  libxml2 (uses musl/Emscripten libc's built-in iconv, not GNU libiconv).
- `ext/iconv` functions (`iconv()`, `iconv_strlen()`, etc.) become unavailable in PHP,
  but these are not needed for the generic async host-call bridge this project provides.

**Alternatives considered.**
- Keep dynamic libiconv and document LGPL obligations: rejected — unnecessary LGPL
  friction for downstream redistributors when the capability is not needed.
- Swap to musl iconv only: not needed because musl iconv is already what both libxml2
  and the Emscripten toolchain use; dropping `WITH_ICONV=0` removes only the GNU extension.

---

## ADR-0010 — PoC result: Asyncify suspend/resume confirmed in Node V8 (Session 3 PASS)
**Date:** 2026-06-07 · **Status:** Accepted

**Decision.** The proof-of-concept primitive is **confirmed**. Session 3 satisfies
the ADR-0006 hard-kill criterion; the project proceeds to Session 4 (workerd port).

**Evidence.** The canonical PoC PHP script:
```php
<?php echo "before:\n"; $r = fp_async_call(41); echo "after: " . $r . "\n";
```
produces `before:\nafter: 42\n` in Node V8, and host-side ordering markers confirm:
1. `[fp_async_call] invoked payload=41`
2. `[fp_async_call] promise registered, returning control to host`
3. `[fp_async_call] timer fired, resolving promise -> 42`   ← after the event loop turned
4. `[fp_async_call] wasm resumed, returning 42`

The `42` originated from a `setTimeout(0)` macrotask that had **not** resolved when
`fp_async_call` was invoked. The ordering is unambiguous: steps 3–4 cannot occur
before step 2, and a `setTimeout(0)` callback cannot fire synchronously.

**What the session proved.** Two JS-only source changes suffice; no C recompile
is needed. `library_fp_async.js` uses `Asyncify.handleAsync` with a deferred
Promise; `PhpBase.mjs` `_run()` passes `{async: true}` to the `pib_run` ccall.
The `{async: true}` run-path fix is the critical new finding of this session:
without it, Emscripten's ccall wrapper discards the Asyncify sentinel on a
synchronous return and the stack never rewinds.

**Forward implications.** Proceed to Session 4. Resolve the libiconv LGPL finding
(ADR-0009 deferred item) before Session 4 begins, as that changes the binary.

---

## ADR-0009 — Defer libiconv LGPL resolution from "before Session 3" to "before Session 4 / before any publish or deploy"
**Date:** 2026-06-07 · **Status:** Accepted

**Decision.** The libiconv LGPL open risk — originally marked "must resolve before
Session 3 / before any publish" in HANDOFF.md — is deferred to **before Session 4
and before any publish or deploy**. It is not a Session 3 blocker.

**Reasoning.** libiconv is a charset/encoding library; its LGPL status is a
license-compliance issue, not a correctness issue. Resolving it (by meeting LGPL
static-link obligations, or by dropping/replacing iconv in the build) changes the
binary. Session 3's goal is to prove correctness and ordering of the Asyncify
suspend/resume primitive — a result that is independent of the charset library
included. A Session 3 pass is equally valid regardless of whether iconv is present
or replaced in the subsequent binary, because:
- The async host-call mechanism (`fp_async_call`, `Asyncify.handleAsync`, the run-path
  `{async: true}` ccall) is orthogonal to iconv.
- The Session 3 binary is never published or deployed; it is a local test artifact.
Deferring keeps the Session 3 binary byte-for-byte identical to the Session 2 binary
(same build flags, same library set), which is the clean "+1 mechanism" diff.

**iconv remains a publish/deploy blocker.** It must be resolved before Session 4
artifacts are published or before any deployment. The risk stays open in HANDOFF.md,
re-marked accordingly.

**Alternatives considered.** Resolve iconv before Session 3 as originally required
(rejected: changes the binary under test, contaminates the clean diff; the compliance
obligation is orthogonal to the suspend/resume proof and can be satisfied later without
any fundamental rework).

---

## ADR-0008 — Rely on whole-program Asyncify; no curated `ASYNCIFY_ONLY` list
**Date:** 2026-06-03 · **Status:** Accepted

**Decision.** Keep the seanmorris pipeline's default of **whole-program
Asyncify** (`-sASYNCIFY=1` with **no `ASYNCIFY_ONLY` allowlist**). Adding a new
suspendable host import therefore requires only listing it in
`ASYNCIFY_IMPORTS` — no per-function suspendable-list curation. We do **not**
introduce a curated allowlist for the proof-of-concept.

**Context / evidence (Session 2).** Adding the single import `fp_async_call`
built and ran on the first attempt, with no "missing suspendable function"
crashes. Confirmed by grep that no `ASYNCIFY_ONLY` / allowlist exists in the
Makefile, `source/`, or the env file, so the whole `pib_run → zend_eval_string
→ … → fp_async_call` stack is already instrumented to unwind/rewind.

**Reasoning.** The PoC's goal is to learn cheaply whether the primitive works.
Whole-program Asyncify removes the single most-feared time-sink (the
iterative, crash-driven suspendable-imports list that the WordPress Playground
build manages via a curated `ASYNCIFY_ONLY` allowlist). The cost is binary
size and per-call overhead from instrumenting every function — but that cost is
**already in the Session 1 baseline** and is the same cost the project decided
to accept under ADR-0002 (Asyncify first). Trading a smaller binary for a
fragile, iterative build is the wrong trade during a proof.

**Consequences / forward implications.**
- The ADR-0006 effort estimate improves: the imports-list balloon does not
  occur on this pipeline.
- **JSPI caveat (Session 5).** JSPI constrains which frames may suspend and
  does not have an equivalent "instrument everything" switch; the comfortable
  Asyncify situation here does **not** transfer automatically to JSPI. The
  suspendable-frame question must be re-examined when porting to JSPI.
- If binary size later needs to shrink, revisit with a curated `ASYNCIFY_ONLY`
  list — a new decision to record here, with the iteration cost it reintroduces.

**Alternatives considered.** Curate an `ASYNCIFY_ONLY` allowlist now (rejected:
smaller binary but reintroduces the iterative crash-driven list the PoC is
trying to avoid; premature optimization before the primitive is proven).

---

## ADR-0007 — Emscripten is the seanmorris fork (3.1.68), not stock 4.0.19
**Date:** 2026-06-03 · **Status:** Accepted · **Supersedes:** ADR-0004 (the
Emscripten pin and its rationale; ADR-0004's PHP 8.0.30 decision stands)

**Decision.** Build with the Emscripten that the reference `seanmorris/php-wasm`
pipeline actually ships and validates: the **seanmorris/emscripten fork, branch
`sm-updates`** (effective `emcc 3.1.68-git`, commit d8c09a1, 2024-10-08), which
its Dockerfile clones over an `emscripten/emsdk:3.1.67` base, replacing stock
Emscripten entirely. We do **not** force stock Emscripten 4.0.19.

**Why this supersedes ADR-0004.** ADR-0004 pinned 4.0.19 and justified it as
"matching the version the upstream reference pipeline validates its PHP builds
against." Session 1 investigation showed that premise is factually wrong: the
pipeline does not use 4.0.19 (or any stock Emscripten) — it uses the fork. The
fork exists for Cloudflare-Workers compatibility (the Dockerfile documents a
bisection: emsdk 3.1.43–3.1.44 work on Cloudflare, 3.1.45+ regressed, and
`sm-updates` restores it). Forcing stock 4.0.19 would (a) diverge from the
lineage ADR-0003 tells us to derive from, (b) drop the fork's
Cloudflare-targeted fixes — the very runtime we are aiming at — and (c)
introduce an unvalidated toolchain into an already fragile build, which is the
exact risk ADR-0004 set out to avoid. The JSPI rationale is unaffected: 3.1.68
satisfies JSPI ≥ 3.1.61.

**Consequences.** BUILD.md records the fork as the pinned toolchain. The host
`~/emsdk` 4.0.19 is incidental (handy for ad-hoc `emcc` checks); the build runs
entirely inside the Docker builder image. If a future need to move off the fork
arises (e.g. JSPI optimization in Session 5), that is a new decision to record
here, with its own Cloudflare-compatibility verification.

**Alternatives considered.** Force stock 4.0.19 (rejected: see (a)–(c) above).
Rebase the fork's changes onto a 4.0.19 base (rejected for the baseline:
high effort, fragile, no payoff for an unmodified-PHP baseline).

---

## ADR-0006 — Kill criterion for the proof-of-concept
**Date:** 2026-06-02 · **Status:** Accepted

**Decision.** Bound the proof-of-concept effort explicitly:

- **Hard kill:** if PHP cannot suspend on a new async import and resume with
  the resolved value **in Node V8** by the end of the third focused build
  session, stop and reassess. Node V8 is the easiest environment with the
  most proven mechanism; failure there indicates the primitive itself is the
  problem, not the platform.
- **Soft kill:** if suspend/resume works in Node V8 but cannot be made to
  work inside workerd within two further focused sessions, stop pushing the
  Cloudflare-specific integration and fall back — but retain the Node result,
  which proves the primitive and remains useful to other PHP-on-edge
  consumers.

**Reasoning.** This is fragile toolchain territory (Emscripten + PHP + a new
async import). The PoC exists to learn cheaply whether the primitive is
achievable. A bounded budget protects against sinking unbounded time into an
approach that may not pan out. A documented fallback (a synchronous
SQLite-file-on-object-storage model) exists, so a negative result is an
acceptable and informative outcome, not a failure of the project.

**Follow-up.** A negative result must be written up in `RESULTS.md` with the
exact stack trace and failing function — negative results are a deliverable.

---

## ADR-0005 — Proof-of-concept scope and success criteria
**Date:** 2026-06-02 · **Status:** Accepted

**Decision.** The first milestone is the smallest program that proves the
primitive, with no data store and no application framework involved:

- A recompiled `php.wasm` imports one new host function, `fp_async_call(x)`.
- PHP source calls it; the host implementation returns a Promise that is
  **not yet resolved** at call time and resolves on a later event-loop tick.
- PHP suspends across the call and resumes with the resolved value, then
  continues executing.

**Success is defined as:** stdout contains `before:` followed by
`after: 42`, where the `42` originated from a Promise that had not resolved
at the moment of the call, and host-side logging confirms the ordering
(call returns control to the host → event loop turns → Promise resolves →
PHP resumes). Resolving the Promise from a genuine macrotask (e.g. a
zero-delay timer) is the strongest form of the proof.

**Measurement.** Correctness and ordering are the pass/fail criteria, not
latency. Latency is recorded in Node V8 against the existing baseline because
sub-second timing cannot be measured inside a Worker (the in-Worker clock
clamps to one-second precision). See `RESULTS.md`.

**Reasoning.** Reducing the proof to a single host round-trip isolates the
one thing in question — can PHP suspend on a newly added async import and
resume with the value — from every downstream concern.

---

## ADR-0004 — Toolchain pinning
**Date:** 2026-06-02 · **Status:** Partially superseded by ADR-0007 (the
Emscripten pin/rationale; the PHP 8.0.30 baseline decision still stands)

**Decision.** Pin the build toolchain:

- **Emscripten SDK 4.0.19**, matching the version the upstream reference
  pipeline validates its PHP builds against. JSPI requires Emscripten
  ≥ 3.1.61, so 4.0.19 covers both the Asyncify and JSPI paths.
- **PHP 8.0.30** as the initial source baseline, designed so that bumping to
  a currently-supported PHP branch later is a version-string change. (PHP 8.0
  is end-of-life; the baseline is chosen for continuity with prior prototype
  work, not for longevity.)

**Reasoning.** Pinning to a known-good, upstream-validated Emscripten version
removes one large variable from an already fragile build. Floating to the
latest toolchain invites unrelated breakage.

---

## ADR-0003 — Derive from the permissively-licensed lineage
**Date:** 2026-06-02 · **Status:** Accepted

**Decision.** Base build scripts and approach on the **Apache-2.0**-licensed
ancestor of the PHP-to-WebAssembly pipeline (the `seanmorris/php-wasm`
lineage and its PIB origin), not on the GPL-2.0-or-later WordPress Playground
npm packages. Read GPL-licensed upstream sources for **facts** (e.g. which
functions must be made suspendable) but do not copy or patch their code.

**Reasoning.** The compiled `php.wasm` binary carries the licenses of PHP
source and its statically-linked libraries regardless of which pipeline
produces it. The JavaScript glue and build scripts, however, carry the
license of whatever they are derived from. Deriving these from the
permissive ancestor keeps the whole project cleanly Apache-2.0 (see
ADR-0001). Factual information — such as the list of functions that need to
appear in the suspendable-imports list — is not copyrightable and may be
re-derived independently.

**Follow-up.** Exclude GPL-licensed components from the static link
(notably `readline`) and avoid any GPL-licensed PHP extension.

---

## ADR-0002 — Suspension mechanism: Asyncify first, JSPI as optimization
**Date:** 2026-06-02 · **Status:** Accepted

**Decision.** Prove the primitive using **Asyncify**, then port to **JSPI**
as a size and performance optimization once JSPI is confirmed available in
the target runtime's compatibility configuration.

**Reasoning.** Adding a new async import requires recompiling PHP under
*either* mechanism, so the recompile is not a differentiator. Asyncify is
proven in the target runtime and has no dependency on a runtime feature flag,
so it minimizes the number of variables during the proof. JSPI is cleaner and
smaller (suspension is handled by the virtual machine rather than by
rewriting the binary), but its availability in the target serverless runtime
is observed-in-practice rather than documented as a stable feature, and it
carries its own constraints on which frames may suspend. Proving on Asyncify
first means a failure is unambiguously about the primitive, not the platform.

**Alternatives considered.** JSPI-first — rejected for the PoC because it
couples the proof to an unverified platform-availability assumption. JSPI
remains the preferred long-term target.

**Follow-up.** Confirm JSPI availability empirically in the target runtime's
compatibility date before committing to it for production (open risk, see
`HANDOFF.md`).

---

## ADR-0001 — Project license: Apache-2.0
**Date:** 2026-06-02 · **Status:** Accepted

**Decision.** License the repository under **Apache-2.0**, on the
clean-derivation path described in ADR-0003.

**Reasoning.**
- The compiled binary is a derivative of PHP source (PHP License 3.01,
  permissive) and statically-linked libraries that are individually
  permissive (public-domain, MIT, BSD, Apache-2.0). None is copyleft,
  provided GPL components are excluded from the link.
- The JavaScript glue is generated fresh by the Emscripten toolchain
  (permissively licensed output) plus a hand-written loader, rather than
  derived from any copyleft glue.
- Apache-2.0 maximizes downstream adoption and includes an explicit patent
  grant, which is valuable for a runtime intended as an industry contribution.
- A permissive license permits use inside private and commercial hosted
  services without copyleft distribution obligations. **AGPL is explicitly
  rejected**: its network-use clause can require offering source to users of
  a hosted service, which would be incompatible with downstream commercial
  hosted consumers. (Note: even plain GPL-2.0+ copyleft triggers on
  distribution of the binary, not on use as a hosted service — but Apache-2.0
  avoids the question entirely.)

**Obligations.** Ship a `NOTICE` file carrying PHP License 3.01 attribution
for the binary plus the notices of all statically-linked libraries.
Acknowledge the prior art (`seanmorris/php-wasm`, WordPress Playground) as a
courtesy. Honor the PHP License naming restriction — do not use "PHP" in any
product name.

**Where professional legal review is warranted (neither author is a lawyer):**
1. Confirm no GPL/LGPL component enters the static link. LGPL components in
   particular carry relinking and source-availability obligations that are
   awkward in a statically-linked WebAssembly artifact.
2. Confirm build scripts are factually derived rather than textually copied
   from any copyleft source.
3. Sign off on the contents of the `NOTICE` file.

This decision is a defensible default to begin from, not legal advice.
