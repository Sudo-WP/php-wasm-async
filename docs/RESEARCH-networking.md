# Research: networking & database access on the Workers target (Session 10)

Investigation of how the seanmorris php-wasm ecosystem intends database and HTTP
access to work on Cloudflare Workers — specifically the companion extensions
`pdo_cfd1`, `vrzno`, and `pdo_pglite` — and what that means for this project's
`fp_async_call` primitive. **Report only; no builds were run.** All findings are
from reading the source repos (cloned read-only at the commits noted below) and
the pipeline checkout.

Sources examined:

| Repo | Commit | Date | License |
|---|---|---|---|
| seanmorris/pdo-cfd1 | `6fad4b3` | 2024-10-06 | **none** (GitHub `license: null`, no LICENSE file) |
| seanmorris/vrzno | `c3aa3b9` | 2026-05-04 | **none** (same) |
| seanmorris/pdo-pglite | (HEAD) | — | **none** (same) |
| seanmorris/php-wasm (pipeline) | local checkout | — | Apache-2.0 |

---

## Summary

1. **Same suspension mechanism as ours.** Both `pdo_cfd1` and `vrzno` suspend PHP
   with `EM_ASYNC_JS` — Emscripten async JS imports riding the **same Asyncify
   runtime** our `fp_async_call` uses. There is no second mechanism and no
   ownership conflict: multiple Asyncify-suspending imports in one binary is the
   normal, supported case. Coexistence with `pib`/`fp_async_call` is expected to
   be safe (high confidence; verify empirically in a prototype).
2. **pdo_cfd1 is a prototype, not a product.** Only the prepare→execute→fetch path
   is implemented. `PDO::exec()`, transactions, `lastInsertId()` (returns 0),
   `quote()` (returns input **unescaped**), attributes, and error propagation are
   stubs. `lastInsertId()` alone is a WordPress-breaker (`$wpdb->insert_id`).
3. **pdo_cfd1 hard-depends on vrzno.** It includes vrzno's header and is built on
   vrzno's zval↔JS proxy runtime (`Module.zvalToJS`/`jsToZval`/`targets`). It is
   not adoptable standalone, despite having been split into its own repo.
4. **Licensing blocks adoption today.** None of vrzno / pdo-cfd1 / pdo-pglite has
   a license — legally all-rights-reserved. The Apache-2.0 pipeline git-clones
   them at build time (unpinned `master`); its license does not cover them. Under
   ADR-0001/0003 we cannot ship or fork them until upstream licenses them.
5. **mysqli/curl are absent by design.** `WITH_NETWORKING=1` only links
   Emscripten's WebSocket-based socket emulation (browser-oriented); there is no
   curl or mysqli anywhere in the pipeline. The intended DB path is PDO →
   companion driver; the intended HTTP path is JS `fetch()` (vrzno exposes it two
   ways). Nothing in this ecosystem integrates WordPress today.
6. **Strategic conclusion: `fp_async_call` is not superseded.** It is proven in
   workerd, Apache-2.0-clean, and already demonstrated against D1 (Session 7).
   The right next step is a measured prototype of `WITH_VRZNO=1` (+`pdo_cfd1`)
   to get size/compatibility data, in parallel with an upstream license inquiry —
   not wholesale adoption. See §4.

---

## 1. pdo_cfd1 — the D1 database path

### Suspension mechanism

`pdo_cfd1_db_statement.c:8`:

```c
EM_ASYNC_JS(int, pdo_cfd1_real_stmt_execute, (zval *zv, zval *rv), {
    const statement = Module.zvalToJS(zv);
    ...
    result = await bound.run();   // awaits D1's async API
    ...
    Module.jsToZval(result.results, rv);
});
```

`EM_ASYNC_JS` generates an async JS import; under the pipeline's whole-program
Asyncify build (`-sASYNCIFY=1`, no allowlist — ADR-0008), calling it unwinds and
rewinds the wasm stack exactly as our `fp_async_call` does. **Same approach as
ours, same family** — the differences are packaging (C-side macro with inline JS
vs. our JS-library + per-request registered handler) and marshalling (vrzno zval
proxies vs. our UTF-8 string payloads). It does not use JSPI and has no
mechanism of its own.

### How D1 is passed in

The Worker sets `Module.cfd1 = { <name>: <D1Database> }` before PHP runs; PHP
connects with `new PDO('cfd1:<name>')`. The handle factory
(`pdo_cfd1_db.c`, `pdo_cfd1_db_handle_factory`) validates `Module.cfd1[<name>]`
exists and throws otherwise; `phpinfo()` reports "CloudFlare D1 SQL module
detected" by checking `Module.cfd1` (`pdo_cfd1.c`, MINFO). This maps directly
onto our loader: the same place we set `mod.hostAsyncCall` would set
`mod.cfd1 = { main: env.DB }`.

### PHP version

`config.m4` hard-errors below PHP 8.1.0 — compatible with our 8.2.11/8.4.1
(and our retired 8.0.30 would have been incompatible).

### Limitations (from source — beyond the documented ones)

Documented in README: positional-only tokens; rudimentary error handling.
Found in source (`pdo_cfd1_db.c` unless noted):

| PDO surface | State | WordPress impact |
|---|---|---|
| `prepare`/`execute`/`fetch`/`fetchObject` | implemented (the only real path) | OK |
| `PDO::exec()` (`cfd1_handle_doer`) | **stub — returns 1 without executing** | schema changes, `dbDelta()`-style paths break silently |
| `lastInsertId()` | **stub — `console.log`, returns 0** | breaks `$wpdb->insert_id` → post/user/meta creation |
| Transactions (`begin`/`commit`/`rollback`) | **stubs — `console.log`, return true** | WooCommerce order paths assume working transactions |
| `PDO::quote()` (`cfd1_handle_quoter`) | **returns input unescaped** | any non-prepared SQL path is injection-prone/broken |
| Error info (`fetch_error_func`, einfo) | `console.error` only; messages not propagated to PHP | silent failures |
| get/set attribute | stubs | minor |
| Affected-rows for UPDATE/DELETE | not surfaced (row_count = SELECT results length) | `$wpdb->rows_affected` wrong |

Also: the pipeline clones the driver from **unpinned `master`** at build time
(`packages/pdo-cfd1/static.mak`) — a repeatability/supply-chain concern by our
standards (everything else we build is pinned). Last upstream commit 2024-10-06.

### Build integration

`WITH_PDO_CFD1?=0` (off by default — unlike `pdo_pglite`, which defaults on).
When enabled it is copied into `php-src/ext/pdo_cfd1` and compiled **statically**
into the main binary via `--enable-pdo-cfd1` (same pattern as our `pib`). It is
not a side module, so it would genuinely be in the workerd-visible binary.

### vrzno dependency — confirmed, hard

The split out of vrzno is repo-level only:

- `php_pdo_cfd1.h:16` → `#include "../vrzno/php_vrzno.h"`
- statement layer calls `vrzno_fetch_object(...)->targetId` and names its method
  table `vrzno_stmt_methods`
- every marshalling step uses vrzno's EM_JS runtime: `Module.zvalToJS`,
  `Module.jsToZval`, `Module.targets`, `Module.PdoParams`

**pdo_cfd1 cannot be built or run without vrzno compiled in.**

### License

None. No LICENSE file, no SPDX metadata, GitHub API reports `license: null`.
Default copyright = all rights reserved. Blocker for use under ADR-0001/0003
until upstream adds a license (and a fork to fix the stubs above would be
equally blocked).

### Coexistence with pib / fp_async_call

No conflict identified in source:
- No symbol or PHP-function collisions (`pdo_cfd1_*`/`vrzno_*` vs `pib_*`/
  `fp_async_call`).
- No competing "ownership" of suspension: Asyncify is a runtime facility, not a
  hook one extension claims. Our build already instruments every function
  (whole-program Asyncify); `EM_ASYNC_JS` imports are additional suspending
  imports beside `fp_async_call`. PHP is single-threaded, so only one suspension
  is in flight at a time — the Session 7 result (sequential suspensions are
  stateless) is the relevant invariant and it held.
- Module-property surfaces are disjoint (`Module.cfd1`/`targets`/`zvalToJS` vs
  our `Module.hostAsyncCall`).

Residual risk is empirical, not architectural (e.g. vrzno's use of
`FinalizationRegistry`/`WeakRef` — present in workerd's V8, but untested here;
glue-size growth; any GOT.func signature changes affecting the trampoline set).
A throwaway build would settle it.

---

## 2. vrzno — the fetch()/JS-bridge path

### Mechanism

`vrzno_functions.c:178`:

```c
EM_ASYNC_JS(void, vrzno_await_internal, (jstarget *targetId, zval *rv), {
    const target = Module.targets.get(targetId);
    const result = await target;
    Module.jsToZval(result, rv);
});
```

`vrzno_await($promise)` suspends PHP on any JS thenable — same Asyncify family
as `fp_async_call`. Direct comparison:

| | `fp_async_call` (ours) | `vrzno_await` |
|---|---|---|
| Suspension | Asyncify, JS-library import + `Asyncify.handleAsync` | Asyncify, `EM_ASYNC_JS` |
| Payload | UTF-8 string in / string out; consumer-owned encoding (ADR-0017) | arbitrary JS object proxies (zval↔JS bridge) |
| Host coupling | one registered handler (`Module.hostAsyncCall`), store-agnostic | full `globalThis` access from PHP (`new Vrzno`) |
| Surface area | ~60 lines JS + ~50 lines C | ~3,700 lines C + EM_JS proxy runtime |

### fetch() from PHP

Two forms:
1. **Explicit** (README): `$window = new Vrzno;`
   `$res = vrzno_await($window->fetch($url)); $json = vrzno_await($res->json());`
2. **Transparent stream wrapper** (`vrzno_fetch.c:70`,
   `php_stream_fetch_real_open`): vrzno registers a fetch-backed `http`/`https`
   stream wrapper honoring `allow_url_fopen` — `file_get_contents('https://…')`
   works, including status line + headers reconstruction and context options
   (`method`, `content`, `header`, `ignore_errors`). Read-only (no writeable
   connections).

**WordPress mapping — important nuance:** WP's HTTP API (Requests 2.x) ships
exactly two transports: **cURL and fsockopen**. Neither exists in this
ecosystem (no curl ext, no sockets). vrzno's stream wrapper does NOT plug into
either — `wp_remote_get()` would still fail. Regardless of which primitive
provides HTTP (vrzno's wrapper or `fp_async_call`), WordPress needs a small
WP-side shim: a custom Requests transport or a `pre_http_request` filter
backed by `file_get_contents` (vrzno path) or a `{action:"fetch",…}` payload
(our path). The shim cost is identical in both architectures.

### Separability

The fetch capability is **not separable as shipped**: `vrzno_fetch.c` compiles
into the single vrzno extension along with the full object-proxy machinery
(object/array/expose/callback/dbg — the bulk of its ~3,700 C lines), which is
far more than a Worker needs (it exists to proxy the browser DOM). Binary-size
cost is unmeasured — a prototype build is the only honest way to get the number.

### Build, status, license

Static extension (`--enable-vrzno`), **on by default upstream** (`WITH_VRZNO?=1`),
cloned from unpinned `master` at build time. We have set `WITH_VRZNO=0` since
Session 8 — enabling it is a real decision (size + unlicensed code + larger
suspend surface), not a free toggle. Actively maintained (2026-05-04, "Adding
PHP8.0 support"; requires PHP 8.0+). License: **none** — same blocker as
pdo_cfd1.

---

## 3. The mysqli/curl question

Confirmed absent **by design**, not omission:

- No mysqli, mysqlnd, or curl anywhere in the pipeline (no package, no configure
  flag, no Makefile reference).
- `WITH_NETWORKING=1` adds exactly one thing: `-lwebsocket.js` (Makefile:294) —
  Emscripten's POSIX-sockets-over-WebSocket emulation, aimed at browsers with a
  websockify proxy. It is not raw TCP and is not a path to MySQL or cURL in
  workerd.
- The ecosystem's intended architecture is exactly the pattern the session
  brief hypothesized: **DB = PDO → companion driver** (`pdo_cfd1` for D1,
  `pdo_pglite` for PGlite — both split out of vrzno, per vrzno's README note);
  **HTTP = JS `fetch()`** (vrzno explicit await or its stream wrapper).
- **No one has integrated WordPress in this ecosystem** — zero WordPress
  references in the pipeline or the three repos. The known prior art is
  WordPress Playground's SQLite Database Integration drop-in (`db.php`
  replacing `$wpdb`'s MySQL backend with MySQL→SQLite SQL translation over PDO;
  GPL). D1 speaks SQLite dialect, so that translation approach transfers
  conceptually — and since the drop-in lives **inside WordPress** (GPL land,
  like every WP plugin), using or adapting GPL code there does not contaminate
  this Apache-2.0 runtime repo. The ADR-0003 boundary stays clean: runtime on
  our side, `db.php` shim on WordPress's side. What such a shim targets —
  `pdo_cfd1`, or a thin PDO driver of our own, or `fp_async_call` directly — is
  the open architecture question of §4.

---

## 4. Strategic synthesis — fp_async_call vs pdo_cfd1

### Assessment

**`fp_async_call` is not superseded.** The investigation strengthens its
position in the short term:

- pdo_cfd1 validates our mechanism choice (same Asyncify suspend-on-host-call),
  while being unlicensed, vrzno-coupled, stale (Oct 2024), and missing
  WordPress-critical PDO surfaces (`lastInsertId`=0, no `exec`, no transactions,
  unescaped `quote`, no error propagation). Adopting it today means adopting
  unlicensed code we cannot legally fork to fix.
- Everything pdo_cfd1 does for D1, our Session 7 demo already does over
  `fp_async_call` with a JSON convention — what's missing on our side is not
  the primitive but the **PHP-facing ergonomics** (a `$wpdb`/PDO-shaped
  surface) and that lives in WP-side shim code either way.
- For HTTP, neither candidate gives WordPress transport for free (§2); the
  required WP-side Requests-transport shim can sit on `fp_async_call`
  **today, with no rebuild**, via a `{action:"fetch",…}` payload to the
  registered handler.

### Architecture options

- **(a) Everything through `fp_async_call`.** Full control, Apache-2.0-clean,
  one suspend point, smallest binary. Cost: we own a `$wpdb`-level (or thin
  PDO-driver-level) DB shim ourselves. The PDO driver surface pdo_cfd1
  implements is ~700 lines of C — re-derivable cleanly (PDO's driver API is
  PHP's, not theirs; ADR-0003 read-for-facts applies).
- **(b) pdo_cfd1 for the DB hot path + `fp_async_call` for everything else**
  (KV, R2, DO, fetch). Best ergonomics *if* upstream (1) adds a permissive
  license and (2) the stub gaps get fixed; brings vrzno's size along.
- **(c) Adopt vrzno+pdo_cfd1 wholesale, retire `fp_async_call`.** Rejected:
  loses our only licensed, proven, store-agnostic primitive; maximizes
  unlicensed surface; vrzno's DOM-proxy generality is dead weight in a Worker.

### Recommendation

**Keep `fp_async_call` as the foundation (no change to ADR-0016's invariant).
Defer the (a)-vs-(b) choice until two cheap actions land:**

1. **Upstream license inquiry** (file issues on vrzno + pdo-cfd1 asking for a
   license declaration; mention the stub status of the PDO surfaces while
   there). Zero cost; unblocks (b) if answered permissively.
2. **Prototype-to-measure session** (throwaway build, explicitly NOT this
   session): `WITH_VRZNO=1` (+`WITH_PDO_CFD1=1`) on 8.4 — measure gz size
   delta, verify workerd init (trampoline/GOT set), verify Asyncify coexistence
   with `fp_async_call` empirically, run a D1 query through PDO. Data in hand,
   the ADR for (a) vs (b) writes itself.

Independently of that choice, the WordPress-side work is invariant and can
start anytime: a Requests-transport shim (HTTP) and a `db.php`-style DB shim
(Playground pattern) — both live in WP land and both can target
`fp_async_call` now.

### Open questions for a hands-on session

1. Empirical: does `EM_ASYNC_JS` (auto-registered as an Asyncify import by
   emcc) coexist with our `library_fp_async.js` import in one binary in
   workerd? (Expected yes; unverified.)
2. vrzno's gz size cost when compiled statically (unmeasured anywhere).
3. Whether vrzno's `FinalizationRegistry`/`WeakRef` usage behaves under
   workerd's request-lifecycle GC semantics.
4. Whether D1's `meta` (last_row_id, changes) suffices to implement the missing
   `lastInsertId`/affected-rows surfaces — relevant both to fixing pdo_cfd1
   upstream and to writing our own thin driver.
5. Upstream licensing intent.
