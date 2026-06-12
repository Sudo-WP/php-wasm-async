# Results

Benchmarks and findings — what works, what does not, with evidence.
Negative results are first-class and are recorded here, not glossed over.

> **Status: Session 7 PASS (2026-06-09).** D1 SQL consumer demonstrated in workerd:
> PHP executes two sequential D1 queries mid-request, suspending on each real async call.
> `curl http://localhost:8791/` → `before:\nafter: {"value":"hello from D1"} / {"value":"goodbye from D1"}\n`.
> Sequential suspension stateless — both suspend/resume cycles complete correctly. See Session 7 result below.

---

## Methodology

- **Where timing is measured: Node V8.** Sub-second timing cannot be measured
  inside the target serverless runtime, where the clock clamps to one-second
  precision. Node V8 is used as the faithful timing proxy for all latency
  numbers.
- **What the PoC measures: correctness and ordering, not latency.** The
  proof-of-concept passes or fails on whether PHP resumes with the correct
  value from a Promise that had not yet resolved at call time, with host-side
  logging confirming the suspend/resume ordering. See `DECISIONS.md`
  ADR-0005.
- **Latency is recorded for cost tracking**, to see what the added async
  import costs relative to the baseline below.

## Baseline to preserve

Carried from prior prototype work, for comparison once the rebuilt runtime
runs. These are targets to preserve or beat, measured in Node V8:

| Metric              | Baseline    |
|---------------------|-------------|
| Cold start (full)   | ~157 ms     |
| Warm start          | ~20 ms      |
| PHP execution       | ~2–31 ms    |

The Asyncify path is expected to add binary size and some overhead; the JSPI
path is expected to reduce both. Both deltas will be recorded here once
measured.

## Session 1 baseline build (2026-06-03)

**What was built.** Unmodified PHP **8.0.30** compiled from `php/php-src`
(branch `php-8.0.30`) to WebAssembly via the seanmorris pipeline, Node/CLI
target, full extension config (`.circleci/.env_8.0.ci`). No `fp_async_call`
import. Asyncify is on (upstream default). Effective toolchain: Emscripten
**3.1.68-git** (seanmorris fork `sm-updates`, commit d8c09a1) — see ADR-0007.

**Confirms it runs (synchronously, in Node V8).** Evidence:

```
$ node hello.mjs        # new PhpNode({version:'8.0'}); await php.run(...)
hello                   # <?php echo "hello\n";  -> stdout "hello\n", exit 0
8.0.30                  # <?php echo PHP_VERSION; -> confirms the built version
RESULT: PASS
```

**Size** (the binary the project owns):

| Artifact                 | Raw          | gzip         |
|--------------------------|--------------|--------------|
| `php8.0-node.mjs.wasm`   | 12,181,923 B (11.62 MiB) | 2,979,648 B (2.84 MiB) |
| `php8.0-node.mjs` (glue) | 315,711 B    | 74,886 B     |

The binary is large because the full extension set (incl. ICU/intl) links
statically and Asyncify instrumentation is present. A minimal config would be
much smaller; the full config was chosen so Session 2 diffs against the
canonical, comparable build (see HANDOFF "Decisions").

**Timing in Node V8** (median of 20 exec / 5 warm; cold = first instantiation
in a fresh process, averaged over 3 runs). Methodology: `cold` = `new
PhpNode()` → `await php.binary` for the first instance; `warm` = same for
later instances in the same process; `exec` = `await php.run()` of a trivial
script on an initialized instance.

| Metric    | Baseline (prior) | This build      | Note |
|-----------|------------------|-----------------|------|
| Cold      | ~157 ms          | ~98 ms          | faster |
| Warm      | ~20 ms           | ~57 ms (49 min) | higher — see below |
| Execution | 2–31 ms          | ~0.04 ms        | trivial script; not comparable |

Honest caveats: (1) different hardware and possibly a different prior config,
so the comparison is indicative, not controlled. (2) "Warm" here re-runs full
PHP module init for each new instance (V8 reuses the compiled module but PHP
still boots), which is why it exceeds the ~20 ms prior figure; the prior
"warm" may have measured re-execution on a live instance. (3) The ~0.04 ms
exec is for `echo "hello"` — it touches no extension; the 2–31 ms prior range
was surely heavier scripts. These are baselines to refine, not pass/fail.

## Session 2 — `fp_async_call` import added (2026-06-03)

**What changed.** Exactly one new host import, `fp_async_call`, added to the
Session 1 baseline (same `.env_8.0.ci` config, same toolchain). Delta committed
as `patches/session2-fp_async_call.patch`. No iconv/library/config changes.

**Builds and PHP can call it (the Session 2 goal).** Evidence in Node V8:

```
$ node call.mjs
function_exists("fp_async_call") -> exists
<?php echo "before:\n"; $r = fp_async_call(41); echo "after: $r\n";
  -> stdout "before:\nafter: 42\n", exit 0, stderr ""
RESULT: PASS
$ node hello.mjs   # regression: baseline still runs
  -> "hello", PHP_VERSION 8.0.30, PASS
```

The host implementation is synchronous this session (`payload + 1`); genuine
Promise suspension is Session 3.

**The "+1 import" cost** (Asyncify, vs the Session 1 baseline):

| Artifact                 | Session 1     | Session 2     | Delta     |
|--------------------------|---------------|---------------|-----------|
| `…node.mjs.wasm` raw     | 12,181,923 B  | 12,183,180 B  | **+1,257 B** |
| `…node.mjs.wasm` gzip    | 2,979,648 B   | 2,979,758 B   | **+110 B** |
| `…node.mjs` glue raw     | 315,711 B     | 315,807 B     | +96 B     |

The cost of the import itself is negligible because Asyncify instrumentation
was already fully present in the Session 1 baseline (`-sASYNCIFY=1`,
whole-program). The Asyncify *size tax* is not new in Session 2 — it was
already paid in Session 1.

**Suspendable-functions list: a single entry, no iteration.** The most
important result to surface. Because the pipeline instruments all functions
(no `ASYNCIFY_ONLY` allowlist — confirmed by grep), the whole call stack is
already suspendable, and the import built and ran on the **first** attempt.
There were **no** suspend-related crashes to resolve, so the list is simply
`fp_async_call`. This materially de-risks Session 3 and relaxes the effort
side of the ADR-0006 kill criterion: the feared "imports-list balloon" does
not occur on this pipeline. See ADR-0008 for the trade-off and JSPI caveat.

## Proof-of-concept result — Session 3 (2026-06-07)

**PASS.** PHP suspended on an unresolved Promise and resumed with the resolved
value `42`. The ADR-0006 hard-kill criterion is satisfied; Node V8 is not the
problem. Session 4 (port to workerd) is the next step.

### PHP program run (exact)

```php
<?php
echo "before:\n";
$r = fp_async_call(41);
echo "after: " . $r . "\n";
```

### stdout (both runs)

```
before:
after: 42
```

### Host-side ordering confirmation

The ordering markers from `library_fp_async.js` (logged to stderr) confirm the
correct suspend/resume sequence. Both runs:

```
[fp_async_call] invoked payload=41
[fp_async_call] promise registered, returning control to host
[fp_async_call] timer fired, resolving promise -> 42
[fp_async_call] wasm resumed, returning 42
```

The `timer fired` line appears **after** `returning control to host` — this is
unambiguous: the host-side timer macrotask fires only after `fp_async_call` has
returned the Asyncify sentinel and control is back in the event loop. PHP could
not have continued synchronously; the only path to `after: 42` is via the
Promise resolving and Asyncify rewinding the call stack.

### What changed (the two Session 3 deltas, committed as `patches/session3-suspend.patch`)

1. **`source/library_fp_async.js`** — replaced the synchronous `return (payload | 0) + 1`
   body with `Asyncify.handleAsync(async () => ...)` wrapping a Promise resolved by
   `setTimeout(..., 0)` (a genuine macrotask, the strongest proof form). Added
   `fp_async_call__async: true` annotation (confirmed present in Emscripten 3.1.68's
   `jsifier.mjs` — tells the linker this function participates in Asyncify). Added
   four ordering markers to stderr.

2. **`source/PhpBase.mjs` `_run()`** — added `{async: true}` to the `php.ccall('pib_run', ...)`
   call. Without this, Emscripten's ccall wrapper returns the Asyncify sentinel
   immediately (a synchronous return) instead of driving the Asyncify resume loop,
   so the wasm stack would unwind and never rewind. With `{async: true}`, ccall
   returns a Promise that resolves when Asyncify completes the full suspend/resume
   round-trip.

### Binary sizes (Session 3 vs Session 2)

The `.wasm` binary is **identical** to Session 2 (12,183,180 B raw) — the only
source change was to the JS library (`library_fp_async.js`), which is merged into
the Emscripten JS glue, not the wasm binary. The glue grew by 449 B raw.

| Artifact               | Session 2     | Session 3     | Delta   |
|------------------------|---------------|---------------|---------|
| `…node.mjs.wasm` raw   | 12,183,180 B  | 12,183,180 B  | 0 B     |
| `…node.mjs` glue raw   | 315,807 B     | 316,256 B     | +449 B  |

### Latency (Session 3, Node V8)

Measured with `test-session3.mjs` (single run each; not a statistical median).

| Metric              | Session 1 baseline | Session 3        |
|---------------------|--------------------|------------------|
| Cold (instantiation)| ~98 ms             | ~91 ms           |
| Warm (2nd instance) | ~57 ms             | ~51 ms           |
| Exec (run 1)        | ~0.04 ms           | ~8 ms            |
| Exec (run 2)        | ~0.04 ms           | ~2 ms            |

The exec cost increase (~8 ms run 1, ~2 ms run 2) is the Asyncify suspend/resume
round-trip plus the `setTimeout(0)` event-loop turn. This is not a concern for the
PoC; it will be refined in Session 5 (JSPI comparison) where per-call overhead is
the explicit measurement target.

### Regression

Session 1 and 2 baseline still passes:
```
$ node test-regression.mjs
hello: "hello\n"
version: "8.0.30"
RESULT: PASS
```

## Session 4 — workerd integration attempt (2026-06-08)

**BLOCKED (partial progress).** The Asyncify binary cannot initialize inside
workerd due to a fundamental incompatibility between Emscripten's dynamic-linking
stub mechanism (`addFunction` → `convertJsFunctionToWasm`) and workerd's
restrictions on runtime WebAssembly compilation. The Node V8 result (Session 3
PASS) stands. Session 5 will target workerd via JSPI with a new build.

**What worked:**

1. **wrangler bundling and wasm delivery.** `wrangler dev` bundles the 12 MB
   wasm and serves it correctly. The wasm arrives in the worker as a pre-compiled
   `WebAssembly.Module` object (wrangler compiles it at bundle time). Confirmed:
   `typeof phpWasm === 'object'`, `phpWasm.constructor.name === 'Module'`.

2. **`instantiateWasm` hook.** The hook intercepting wasm loading works cleanly:
   ```js
   instantiateWasm(imports, receive) {
       WebAssembly.instantiate(phpWasm, imports).then(
           instance => receive(instance, phpWasm)
       );
       return {};
   }
   ```
   `WebAssembly.instantiate(precompiledModule, imports)` succeeds. `receiveInstance`
   is called with the instance. Confirmed by `[worker] wasm instantiated ok, instance
   type: object Instance` in the wrangler console.

3. **Glue patches 1 and 2.** Two required patches to the Emscripten worker-env
   glue were identified and confirmed valid:
   - `self.location.href` → `(self.location&&self.location.href)||""` — required for
     workerd ESM module format where `self.location` is undefined at module load time.
   - Two `addEventListener("message", cb, true)` → `false` — required because workerd
     forbids `useCapture=true`.

**Hard blocker — patch 3 (ADR-0012):**

Exact error from wrangler console:
```
✘ [ERROR] [worker] instantiate error: TypeError: WebAssembly.Table.set():
  Argument 1 is invalid for table: function-typed object must be null
  (if nullable) or a Wasm function object

  at setWasmTableEntry (worker/build/php8.0-worker.mjs:9:16213)
  at addFunction (worker/build/php8.0-worker.mjs:9:16508)
  at reportUndefinedSymbols (worker/build/php8.0-worker.mjs:9:27138)
  at loadDylibs (worker/build/php8.0-worker.mjs:9:27344)
  at receiveInstance (worker/build/php8.0-worker.mjs:9:7882)
```

Call chain: `receiveInstance → loadDylibs → reportUndefinedSymbols → addFunction
→ convertJsFunctionToWasm → new WebAssembly.Module(bytes)`.

workerd blocks `new WebAssembly.Module(bytes)` at runtime ("Wasm code generation
disallowed by embedder") and does not provide `WebAssembly.Function` (the type
reflections API that would avoid it). `WebAssembly.Table.set()` rejects plain JS
functions — only proper wasm-typed functions are accepted.

The four undefined symbols (`xmlStrdup`, `xmlStrncmp`, `xmlURIUnescapeString`,
`xmlUnlinkNode`) are called during `php_embed_init('embed')` via ext/libxml MINIT →
`xmlInitParser()`. These fire before any PHP code runs; the stubs cannot be deferred.

**Workarounds attempted:**
- `reportUndefinedSymbols` no-op → GOT entries remain 0 → `RuntimeError: unreachable`
  trap when `xmlInitParser()` calls them via null function-table index.
- `convertJsFunctionToWasm = (f, sig) => f` (return raw JS) → `WebAssembly.Table.set()`
  rejects it with the same error above.

**JSPI probe result (2026-06-08):**

A probe worker confirmed that workerd (wrangler 4.96.0, compatibility date
2024-09-23) provides JSPI natively:
```
WebAssembly keys: ... Suspending, promising, SuspendError
WebAssembly.Function: undefined
```
`WebAssembly.Suspending` and `WebAssembly.promising` are available.
`WebAssembly.Function` (needed by Asyncify stubs) is not.

Session 4 artifacts:
- `worker/index.mjs` — workerd loader entry point (committed; status: BLOCKED)
- `wrangler.toml` — wrangler project config (committed)
- `patches/session4-workerd-analysis.patch` — three-patch analysis with workaround
  evidence (committed)

See ADR-0012 (blocker) and ADR-0013 (JSPI path) in `DECISIONS.md`.

## Session 5 — workerd integration: PASS (2026-06-09)

**PASS.** Asyncify suspend/resume confirmed inside workerd. The ADR-0005 success
criterion is satisfied in the target serverless runtime. ADR-0006 is fully satisfied
(both Node V8 and workerd pass).

### Success criterion result

```
$ curl http://localhost:8791/
before:
after: 42
```

Two consecutive requests both returned `before:\nafter: 42\n`.

### Host-side ordering (wrangler console)

```
[fp_async_call] invoked payload=41
[fp_async_call] promise registered, returning control to host
[fp_async_call] timer fired, resolving promise -> 42
[fp_async_call] wasm resumed, returning 42
```

The ordering is identical to Session 3 (Node V8). `timer fired` appears after
`returning control to host` — PHP suspended into the event loop and resumed after
the macrotask resolved the Promise. The ordering proof is unambiguous.

### What changed from Session 4 (the blocker and the fix)

**Root cause (corrected — see ADR-0015).** Session 4 identified the blocker as four
libxml2 GOT symbols (`xmlStrdup` etc.) causing `addFunction → convertJsFunctionToWasm
→ new WebAssembly.Module(bytes)`. Session 5 showed this was incomplete: even after
`WITH_LIBXML=static`, 6 Emscripten console/output symbols (`emscripten_console_log`,
`_error`, `_warn`, `_trace`, `emscripten_out`, `emscripten_err`) still triggered the
same path. All have sig `vp` (void, i32). The general cause: Emscripten MAIN_MODULE=1
always runs `reportUndefinedSymbols` and calls `addFunction` for any GOT.func symbol
that resolves to a JS function. Both synchronous (`new WebAssembly.Module`) and
asynchronous (`WebAssembly.compile`) runtime wasm compilation are blocked in workerd.

**Fix (two parts):**

1. **`WITH_LIBXML=static` + `WITH_TIDY=static`** — switches libxml2 and libtidy from
   WASM side modules to static archives in `ARCHIVES`. The four libxml2 symbols are
   resolved at link time. `DYNAMIC_LIBS_GROUPED` no longer includes `xml-libs`, so
   `loadDylibs` doesn't try to load a libxml2 side module. Required `WITH_TIDY=static`
   because `php-wasm-tidy/static.mak` enforces `WITH_TIDY=dynamic → requires
   WITH_LIBXML=dynamic`. Also required fixing `PHP_CONFIGURE_DEPS` (empty without
   libxml's dynamic-mode contribution — would cause bare `$(MAKE)` infinite recursion;
   fixed by adding `lib/lib/libxml2.a` as a sentinel in the Makefile). Required clearing
   a stale configure cache (options changed from `--with-libxml=/src/lib/` to
   `--with-libxml`; stale cache caused `cannot compute suffix of executables`).

2. **Pre-compiled `vp` trampoline** — created `worker/build/trampoline-vp.wasm` (31 bytes):
   a wasm module that imports `e.f` as `(i32)->void` and re-exports it as `f`. This is
   the type signature needed by all 6 Emscripten console symbols. Wrangler bundles it at
   compile time as a `WebAssembly.Module`. `worker/index.mjs` sets
   `globalThis.__phpWasmTrampolines = new Map([['vp', trampolineVP]])` in the
   `instantiateWasm` hook. `apply-workerd-patches.py` Patch 3 patches
   `convertJsFunctionToWasm` to read from the cache: `new WebAssembly.Instance` of
   a pre-compiled (not runtime-compiled) module IS allowed synchronously in workerd.

### Node V8 regression (re-confirmed, Session 5 binary)

```
$ node test-regression.mjs
hello: "hello\n"
version: "8.0.30"
RESULT: PASS

$ node test-session3.mjs
stdout (run 1): "before:\nafter: 42\n"
stdout (run 2): "before:\nafter: 42\n"
RESULT: PASS
```

Session 3 latency was preserved (same ordering, same timing class).

### Build issues encountered and resolved (negative results)

1. **WITH_TIDY constraint** — `WITH_LIBXML=static` with `WITH_TIDY=1` (dynamic) triggers
   `$(error TIDY REQUIRES WITH_LIBXML=[dynamic])` in `php-wasm-tidy/static.mak`. Fixed by
   `WITH_TIDY=static`.

2. **PHP_CONFIGURE_DEPS empty → infinite recursion** — With `WITH_LIBXML=static`, no package
   adds to `PHP_CONFIGURE_DEPS` (libxml's static.mak only adds in dynamic/shared mode).
   Empty `${PHP_CONFIGURE_DEPS}` → bare `$(MAKE)` → `all` → `_all` → infinite recursion.
   Fixed by adding `PHP_CONFIGURE_DEPS+= lib/lib/libxml2.a` sentinel in the Makefile.

3. **Stale configure cache** — `--with-libxml=/src/lib/` (old cache) vs `--with-libxml`
   (static mode) caused `cannot compute suffix of executables`. Fixed by deleting
   `.cache/config-cache` and `third_party/php8.0-src/configured` via Docker.

4. **WebAssembly.compile blocked in workerd** — first attempt at a pre-compile fix used
   `await WebAssembly.compile(bytes)` in `instantiateWasm`. workerd (even in miniflare
   local dev mode) blocks ALL runtime wasm compilation, including async
   `WebAssembly.compile`. Fixed by bundling `trampoline-vp.wasm` as a static import
   that wrangler AOT-compiles at bundle time.

### Binary sizes (Session 5)

| Artifact | Session 4 (dynamic libxml) | Session 5 (static libxml+tidy) |
|---|---|---|
| `php8.0-worker.mjs.wasm` raw | 12,183,180 B (11.62 MiB) | 15,831,979 B (15.10 MiB) |
| `php8.0-worker.mjs` glue raw | 309,714 B | 309,714 B |
| `trampoline-vp.wasm` raw | — | 31 B |

The +3.65 MiB wasm increase is libxml2 + libtidy statically linked. Compresses well
(libxml2 is highly repetitive data). Gzip estimated ~4.8 MiB (not yet measured).

### Session 5 committed files

- `worker/index.mjs` — updated: trampoline import + cache setup in `instantiateWasm`
- `worker/build/trampoline-vp.wasm` — 31-byte bundled trampoline for sig `vp`
- `worker/apply-workerd-patches.py` — Patch 3 added (cache-backed `convertJsFunctionToWasm`)
- `patches/session5-static-libxml.patch` — env + Makefile changes for static build
- `docs/DECISIONS.md` — ADR-0014 (pre-session) + ADR-0015 (result)

---

## Session 6 — real async host call: PASS (2026-06-09)

**PASS.** PHP suspends on a genuine `env.KV.get("greeting")` (a real Promise, unresolved at
call time) and resumes with the stored value, in workerd. The primitive remains store-agnostic:
`fp_async_call` and `pib.c` contain no KV-specific code.

### Success criterion result

```
$ curl http://localhost:8791/
before:
after: hello from KV
```

Two consecutive requests both returned `before:\nafter: hello from KV\n`.

### Host-side ordering (wrangler console)

```
[worker] before: calling pib_run
[fp_async_call] invoked payload=greeting
[fp_async_call] delegating to Module.hostAsyncCall
[fp_async_call] wasm resumed, returning hello from KV
[worker] after: pib_run complete
```

`before: calling pib_run` fires before PHP runs; `delegating to Module.hostAsyncCall` marks
the Asyncify suspend into the event loop (the KV Promise is unresolved at this point);
`wasm resumed, returning hello from KV` marks the resume after the KV read resolved.
`after: pib_run complete` fires only after PHP returned.

### What changed from Session 5

1. **`library_fp_async.js` — string marshalling + handler dispatch.** Payload is now read
   as a UTF-8 string via `UTF8ToString(payloadPtr)`. Return is allocated in the wasm heap
   via `stringToNewUTF8(result)` (calls `_malloc`; C side copies to PHP heap, then `free()`s).
   Handler dispatch: if `Module.hostAsyncCall` is a function, call it and await the result;
   otherwise fall back to the old `setTimeout(0)` stub, preserving all prior Node V8 tests.

2. **`source/pib/pib.c` — string ABI.** `extern char* fp_async_call(const char* payload)`.
   `PHP_FUNCTION(fp_async_call)`: arginfo changed to `IS_STRING`; `Z_PARAM_STRING` extracts
   the payload string; `RETVAL_STRING(result)` + `free(result)` copies the wasm-heap string
   to PHP's heap and frees the wasm allocation.

3. **`worker/index.mjs` — handler registration.** Before running PHP:
   ```js
   mod.hostAsyncCall = async (key) => (await env.KV.get(key)) ?? '';
   ```
   `mod` is the Emscripten module instance returned by `await PHP({...})`, which is the same
   object as `Module` inside `library_fp_async.js`. Setting `hostAsyncCall` here makes it
   visible to `fp_async_call` at PHP call time.

4. **`wrangler.toml` — KV binding.**
   ```toml
   [[kv_namespaces]]
   binding = "KV"
   id = "local-dev-only"
   preview_id = "local-dev-only"
   ```
   Local miniflare KV, no Cloudflare credentials needed. Seed command:
   `wrangler kv key put --binding=KV "greeting" "hello from KV" --local --preview false`

### Node V8 results (Session 6 binary)

All three Node tests pass on the rebuilt binary:

```
$ node test-regression.mjs
hello: "hello\n"
version: "8.0.30"
RESULT: PASS

$ node test-session3.mjs
[fp_async_call] invoked payload=41
[fp_async_call] promise registered, returning control to host
[fp_async_call] timer fired, resolving promise -> 42
[fp_async_call] wasm resumed, returning 42
stdout (run 1): "before:\nafter: 42\n"
stdout (run 2): "before:\nafter: 42\n"
RESULT: PASS

$ node test-session6.mjs
Test 1: registered handler (async key => "hello from KV")
[fp_async_call] invoked payload=greeting
[fp_async_call] delegating to Module.hostAsyncCall
[fp_async_call] wasm resumed, returning hello from KV
stdout: "before:\nafter: hello from KV\n"
RESULT: PASS
Test 2: stub fallback (fp_async_call(41) -> "42")
stdout: "before:\nafter: 42\n"
RESULT: PASS
```

The stub fallback (integer 41 → "42") confirms non-strict PHP coercion: passing an integer
to the `IS_STRING` parameter silently coerces 41 → "41", and the fallback returns "42".
All prior tests pass without modification.

### Binary sizes (Session 6)

| Artifact | Session 5 | Session 6 | Delta |
|---|---|---|---|
| `php8.0-worker.mjs.wasm` raw | 15,831,979 B | 15,832,594 B | **+615 B** |
| `php8.0-worker.mjs` glue raw | 309,714 B | 310,000 B | **+286 B** |
| `php8.0-node.mjs.wasm` raw | 12,183,180 B | 15,832,594 B | +3.65 MB* |
| `trampoline-vp.wasm` | 31 B | 31 B | 0 |

*`php8.0-node.mjs` was rebuilt for Session 6 (needed for Node handler test). It now uses
`WITH_LIBXML=static` (the `.env_8.0.ci` patch from Session 5), matching the worker binary.
The +615 B wasm delta is the new `fp_async_call` string-marshalling code.

### Session 6 committed files

- `source/library_fp_async.js` (in upstream patch) — handler dispatch + string marshalling
- `source/pib/pib.c` (in upstream patch) — string ABI for `fp_async_call`
- `worker/index.mjs` — updated: KV handler registration, `env` parameter, string PHP script
- `wrangler.toml` — KV namespace binding added
- `patches/session6-real-async.patch` — full diff (pib.c + library_fp_async.js)
- `docs/DECISIONS.md` — ADR-0016

---

## Session 7 — D1 SQL consumer: PASS (2026-06-09)

**PASS.** PHP executes two sequential D1 SQL queries mid-request, suspending on each real
`env.DB.prepare(...).bind(...).first()` Promise and resuming with the query result.
No rebuild was required — only the Worker and wrangler config changed.

### Success criterion result

```
$ curl http://localhost:8791/
before:
after: {"value":"hello from D1"} / {"value":"goodbye from D1"}
```

Two consecutive requests both returned the same result. The stretch goal (two sequential
`fp_async_call` invocations) was achieved on the first attempt.

### Host-side ordering (wrangler console — one full request)

```
[worker] before: calling pib_run
[fp_async_call] invoked payload={"action":"query","sql":"SELECT value FROM config WHERE key=?","params":["greeting"]}
[fp_async_call] delegating to Module.hostAsyncCall
[fp_async_call] wasm resumed, returning {"value":"hello from D1"}
[fp_async_call] invoked payload={"action":"query","sql":"SELECT value FROM config WHERE key=?","params":["farewell"]}
[fp_async_call] delegating to Module.hostAsyncCall
[fp_async_call] wasm resumed, returning {"value":"goodbye from D1"}
[worker] after: pib_run complete
```

Two complete suspend/resume cycles in sequence. `delegating` marks Asyncify unwinding the
PHP stack into the event loop; `wasm resumed` marks Asyncify rewinding it after the D1
Promise resolved. Both cycles complete correctly — the wasm stack state is fully preserved
and restored independently for each call.

### Why this matters (sequential suspension proof)

WordPress makes many database calls per request. The ordering above proves that Asyncify
stack unwind/rewind is **stateless across calls**: the second `fp_async_call` suspends and
resumes correctly even though the first already ran a full unwind/rewind cycle. The wasm
Asyncify buffer is not "consumed" by the first call. This is the critical invariant that
makes the primitive usable for real PHP applications.

### What changed from Session 6

No rebuild. No changes to `pib.c`, `library_fp_async.js`, or the wasm binary.

1. **`wrangler.toml`** — added `[[d1_databases]] binding="DB"`.

2. **`worker/index.mjs`** — D1 handler replaces the KV handler (KV kept as comment):
   ```js
   mod.hostAsyncCall = async (payload) => {
       const req = JSON.parse(payload);
       if (req.action === 'query') {
           const row = await env.DB.prepare(req.sql).bind(...(req.params ?? [])).first();
           return JSON.stringify(row ?? null);
       }
       return JSON.stringify({ error: 'unknown action: ' + req.action });
   };
   ```

3. **`PHP_CODE`** — updated to make two sequential JSON-payload calls:
   ```php
   $r1 = fp_async_call('{"action":"query","sql":"SELECT value FROM config WHERE key=?","params":["greeting"]}');
   $r2 = fp_async_call('{"action":"query","sql":"SELECT value FROM config WHERE key=?","params":["farewell"]}');
   echo "after: " . $r1 . " / " . $r2 . "\n";
   ```

### Node V8 regression (Session 7 — no binary change)

Both regression tests pass with the existing Session 6 binary (stub fallback path):

```
$ node test-regression.mjs
hello: "hello\n"
version: "8.0.30"
RESULT: PASS

$ node test-session3.mjs
stdout (run 1): "before:\nafter: 42\n"
stdout (run 2): "before:\nafter: 42\n"
RESULT: PASS
```

### Session 7 committed files

- `worker/index.mjs` — D1 handler, two-call PHP script
- `wrangler.toml` — D1 database binding
- `docs/DECISIONS.md` — ADR-0017

No patch file (no C or JS library changes).

---

## Session 8 — PHP 8.2 + 8.4 dual build; multi-version Worker: PASS (2026-06-10)

**PASS.** PHP 8.2.11 and 8.4.1 both build from the same patched pipeline with **zero
source-patch deltas** (no `pib.c` changes, no glue-patch changes), both pass Node V8
regression + suspend/resume, both serve the two-query D1 demo in workerd, and a single
Worker deployment serves either version selected by the `X-PHP-Version` request header.
See ADR-0018.

### Build results

| Artifact | PHP 8.2 | PHP 8.4 | (8.0 Session 5, reference) |
|---|---|---|---|
| `php*-worker.mjs.wasm` raw | 17,050,329 B | 17,580,702 B | 15,831,979 B |
| `php*-worker.mjs` glue raw | 315,968 B | 315,555 B | 309,714 B |
| `php*-node.mjs.wasm` raw | 17,050,329 B | 17,580,702 B | — |

Exact PHP versions are the **pipeline-pinned** `PHP_VERSION_FULL` values (8.2 → 8.2.11,
8.4 → 8.4.1), not the latest upstream patch releases — see ADR-0018 for why.

**Key finding: the async primitive is version-agnostic in practice, not just in theory.**
- `pib.c` compiled unmodified against 8.2 and 8.4 headers — `Z_PARAM_STRING`,
  `RETVAL_STRING`, `ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX`, `PHP_FE`/`PHP_FE_END`,
  and `zend_function_entry` are all unchanged across 8.0 → 8.4.
- `library_fp_async.js` and the Makefile changes applied as-is.
- All four workerd glue patches (`apply-workerd-patches.py`) found their target strings
  unchanged in both new glue files — the Emscripten fork emits identical patterns.
- The 6 GOT.func console symbols still all use sig `vp`; the single bundled
  `trampoline-vp.wasm` suffices for both versions (open risk #3 stays closed).

### Node V8 results (per version)

```
$ PHP_VERSION=8.2 node test-regression.mjs   → version: "8.2.11"  RESULT: PASS
$ PHP_VERSION=8.2 node test-session3.mjs     → before:/after: 42 (×2)  RESULT: PASS
   Cold 120.7 ms · Warm 76.0 ms · Exec 12.6 / 1.8 ms

$ PHP_VERSION=8.4 node test-regression.mjs   → version: "8.4.1"  RESULT: PASS
$ PHP_VERSION=8.4 node test-session3.mjs     → before:/after: 42 (×2)  RESULT: PASS
   Cold 123.6 ms · Warm 77.6 ms · Exec 9.9 / 2.3 ms
```

Latency is in line with the 8.0 binary; no regression from the version bump.
(`test-regression.mjs` / `test-session3.mjs` now take a `PHP_VERSION` env var and accept
any `8.x.y` patch release of the requested branch.)

### workerd per-version smoke tests

Each version was verified standalone (temporary single-version entry point +
`wrangler.smoke.toml`, both gitignored) before the multi-version step:

```
$ curl http://localhost:8791/        # smoke-8.2
before:
after: {"value":"hello from D1"} / {"value":"goodbye from D1"}
php: 8.2.11

$ curl http://localhost:8791/        # smoke-8.4
before:
after: {"value":"hello from D1"} / {"value":"goodbye from D1"}
php: 8.4.1
```

Ordering markers in the wrangler console showed the same two complete suspend/resume
cycles per request as Session 7, for both versions.

### Multi-version Worker verification (single deployment)

`worker/index.mjs` imports both glue modules and both wasm binaries statically; the
fetch handler picks the runtime per request. The PHP script now also echoes
`PHP_VERSION`, so the served version is externally observable.

```
$ curl -si http://localhost:8791/                          # default
X-PHP-Version-Served: 8.4
before:
after: {"value":"hello from D1"} / {"value":"goodbye from D1"}
php: 8.4.1

$ curl -si -H "X-PHP-Version: 8.2" http://localhost:8791/  # header-selected
X-PHP-Version-Served: 8.2
before:
after: {"value":"hello from D1"} / {"value":"goodbye from D1"}
php: 8.2.11

$ curl -si -H "X-PHP-Version: 7.4" http://localhost:8791/  # unknown → fallback
X-PHP-Version-Served: 8.4
php: 8.4.1
```

Wrangler console confirms the selection (`[worker] serving PHP 8.2` / `8.4` per request).
Wrangler bundles both `.wasm` imports (AOT-compiled `WebAssembly.Module` objects) and
both glue modules without any `wrangler.toml` changes — no explicit module rules needed.

### Version-specific patch notes

**None required.** No hunk of any session patch failed against the 8.2 or 8.4 trees;
no PHP-internals API change affected `pib.c`. (The session patches modify the *pipeline*
tree — `source/`, `Makefile`, env files — not the PHP source tree, so the only
version-sensitive surface was `pib.c` compiling against new headers, and it did.)

### Session 8 committed files

- `patches/session8-multiversion.patch` — `.env_8.2.ci`/`.env_8.4.ci` deltas
  (`WITH_LIBXML=static`, `WITH_ICONV=0`, `WITH_TIDY=static`, `WITH_VRZNO=0`)
- `worker/index.mjs` — multi-version loader (header selection, version echo)
- `worker/apply-workerd-patches.py` — patches every `php*-worker.mjs` in `worker/build/`
- `.gitignore` — generalized artifact patterns
- `docs/DECISIONS.md` — ADR-0018 (committed first, per protocol)

---

## Session 9 — binary size reduction: PASS, with a major inventory finding (2026-06-10)

**Result.** Stripping the safely-removable static extensions (tidy + libtidy, calendar,
pdo_pglite) cut each worker binary by ~273 KB gzipped (−6.2%). Final sizes
(`gzip -9`): **8.2 = 3,977,584 B (3.79 MiB)**, **8.4 = 4,139,775 B (3.95 MiB)**,
combined **8,117,359 B (7.74 MiB)** — comfortably under the 10 MB (Paid plan)
Cloudflare limit with ~2.3 MiB headroom. The ≤3.5 MiB-per-binary target was **not**
reached: the remaining mass is PHP core under whole-program Asyncify plus libxml2,
neither strippable without violating a standing decision (ADR-0008, ADR-0014). All
verification passes on both versions.

### The finding that reframed the session: the static/dynamic split

The pipeline is dynamic-by-default: for most packages `WITH_X=1` means *dynamic side
module*, exactly as ADR-0011 found for iconv. Ground truth from `get_loaded_extensions()`
and the final link command (which contains only `libxml2.a` + `libtidy.a` beyond PHP):

- **Statically in the worker binary (Session 8 state):** Core, date, pcre, json, hash,
  SPL, standard, random, Reflection, bcmath, calendar, ctype, exif, filter, session,
  tokenizer, PDO, pdo_pglite, pib, libxml, tidy.
- **Side modules, NOT in the binary** (and not loadable in workerd — runtime wasm
  compilation is blocked, ADR-0015): mbstring, openssl, gd, dom, xml, simplexml, intl,
  sqlite3/pdo_sqlite, zip, zlib, yaml, phar (+ their C libraries: oniguruma, OpenSSL,
  freetype/libpng/libjpeg/libwebp, ICU, libyaml, libzip).
- **Not in the pipeline at all:** mysqli/mysqlnd, curl (`WITH_NETWORKING=0`), fileinfo,
  soap, ftp, sockets, gettext, shmop, sysv*, pspell, enchant, gmp — most of Session 9's
  intended "strip candidates" were never present.

**Consequence (named finding): the WordPress MUST-KEEP extension floor is not met by
these binaries and never was** — in any session to date. The live sanity line now in the
demo output makes it visible per request: `ext: - - - - - bc` (mysqli, gd, curl,
mbstring, openssl absent; bcmath present). Bringing the WP floor into the static link
(mbstring+oniguruma, openssl, gd+image libs, dom/xml/simplexml, sqlite/pdo_sqlite, zip,
fileinfo at minimum; mysqli and curl need `WITH_NETWORKING` or shims) is a dedicated
future session and will **grow** the binary substantially — Session 9's sizes are the
floor of the *current* capability set, not of a WP-ready one.

### Extension decision table (static set only — side modules cost 0 bytes in-binary)

| Extension (static) | Decision | Reason |
|---|---|---|
| bcmath | keep | WP/WooCommerce money math (MUST KEEP) |
| calendar | **strip** | niche calendar conversions; WP unused |
| ctype | keep | WP requirement (cheap) |
| exif | keep | WP recommended (image metadata) |
| filter | keep | WP requirement |
| json, hash, pcre, SPL, standard, date, random, Reflection | keep | PHP core; not removable |
| session | keep | WP login/auth paths |
| tokenizer | keep | WP requirement (plugin editor, sitemaps) |
| PDO | keep | base for the future sqlite/D1 driver path |
| pdo_pglite | **strip** | Postgres-in-wasm driver; pipeline default `=1` crept back in Session 8 (8.0 env had it 0); D1 path unused |
| pib | keep | our embed/runtime extension (`fp_async_call`) |
| libxml (`static`) | keep | required to avoid the GOT/addFunction init blocker (ADR-0014/0015) |
| tidy (`static`) | **strip** | WP unused; Session 5 chose `static` only because `=1`(dynamic) conflicted with `WITH_LIBXML=static`; `WITH_TIDY=0` carries **no libxml coupling** (verified in tidy's `static.mak`) — the Session 5 constraint is mode-matching, not presence |
| readline | n/a | never present (GPL, excluded per ADR-0003) — verified |
| vrzno | n/a | `WITH_VRZNO=0` since Session 8 — verified absent |

### Size progression (worker-mjs, `gzip -9`)

| Step | 8.4 raw | 8.4 gz | Δ gz | 8.2 raw | 8.2 gz |
|---|---|---|---|---|---|
| Session 8 baseline | 17,580,702 | 4,414,500 | — | 17,050,329 | 4,250,384 |
| Phase 1: −calendar −pdo_pglite | 17,533,688 | 4,403,552 | −10,948 | (not built separately) | |
| Phase 2: −tidy −libtidy.a | **16,462,783** | **4,139,775** | −263,777 | **15,934,663** | **3,977,584** |

Totals: 8.4 −1,117,919 B raw (−6.4%) / −274,725 B gz (−6.2%); 8.2 −1,115,666 B raw /
−272,800 B gz. Combined bundle: 8,664,884 → **8,117,359 B gz**. The 8.2 phase deltas
were not measured separately (final flag set applied in one rebuild, per the
work-on-8.4-first method).

### Phase 3 — the measured cost of intl: 0 bytes in the worker binary

intl was **already absent**: `WITH_INTL=1` builds it as a side module. Evidence:
- `get_loaded_extensions()` does not list intl (any session, any version);
- the final worker link command contains no ICU archive; the PHP build's `SKIP_LIBS`
  explicitly excludes `-licuio -licui18n -licuuc -licudata`;
- per the ADR-0011 precedent (iconv), side-module flags do not alter the main binary —
  no throwaway build was needed.

The "intl decision" is therefore moot at current capability: stripping it saves 0 B.
The relevant future number is the *cost of adding* `WITH_INTL=static` (ICU is tens of
MB unstripped; likely several MB gzipped) when the WP-floor session happens — that
session must measure it.

### Verification (final stripped binaries, both versions)

Node V8 (`PHP_VERSION=8.2|8.4`): regression (`8.2.11` / `8.4.1`) PASS ×2;
suspend/resume stub `before:/after: 42` PASS ×2. Loaded extensions match the intended
static set exactly (calendar, pdo_pglite, tidy gone; nothing else changed).

workerd multi-version (single deployment, final binaries):

```
$ curl http://localhost:8791/                          $ curl -H "X-PHP-Version: 8.2" ...
before:                                                before:
after: {"value":"hello from D1"} / {"value":...}       after: {"value":"hello from D1"} / {"value":...}
php: 8.4.1                                             php: 8.2.11
ext: - - - - - bc                                      ext: - - - - - bc
```

Two suspend/resume cycles per request on both versions; no trampoline regression (the
GOT.func symbol set still resolves with the single `vp` trampoline — open risk #3
unchanged by the extension-set change).

### What remains in the binary (the floor, and the levers left)

~16 MB raw ≈ PHP core + the small WP-floor static extensions, ×(whole-program Asyncify
instrumentation, ADR-0008) + libxml2.a. Remaining size levers, all out of Session 9
scope: **JSPI** (drops Asyncify instrumentation entirely — the largest single lever),
`ASYNCIFY_ONLY` curation (re-introduces the iterative-crash cost ADR-0008 rejected),
`OPTIMIZE=z`, and one-Worker-per-version deployment (halves per-Worker size; loses
single-deployment selection).

### Session 9 committed files

- `patches/session9-size-reduction.patch` — env deltas on top of session8 state
- `worker/index.mjs` — extension sanity line in the demo PHP
- `NOTICE` — libtidy no longer statically linked (attribution kept for S5–S8 artifacts)
- `docs/DECISIONS.md` — ADR-0019 (committed first, per protocol)

---

## Session 11 — Asyncify mixed-packaging coexistence: PASS (2026-06-11)

**PASS.** A second Asyncify-suspending extension function packaged as `EM_ASYNC_JS`
(`fp_async_probe`) coexists with the JS-library-packaged `fp_async_call` in one
binary, in workerd — both suspending and resuming correctly, interleaved, within a
single PHP execution. This was the one assumption gating the clean-room D1 PDO
driver (ADR-0021); it is now measured, not predicted.

### The probe

~40 lines added to `pib.c` (THROWAWAY-marked, captured as
`patches/session11-coexistence-probe.patch`, then reverted): `fp_async_probe(string):
string` via `EM_ASYNC_JS`, resolving on a `setTimeout(0)` macrotask (genuinely
unresolved at suspend time — Session 3 rigor). Same string ABI and free() pattern as
Session 6. Built on 8.4 only, Session 9 flag set, standard glue patches + trampoline.
`EM_ASYNC_JS` compiled cleanly under the sm-updates 3.1.68 fork with no special
handling.

### workerd interleaved test (the deliverable)

Four suspensions, two mechanisms, alternating, one PHP run — strictly stronger than
what the PDO driver needs. Two consecutive requests, identical output:

```
start
1 fp_async_call: {"value":"hello from D1"}     ← JS-library suspend (real D1 query)
2 fp_async_probe: probe:alpha                  ← EM_ASYNC_JS suspend
3 fp_async_call: {"value":"goodbye from D1"}   ← JS-library suspend (real D1 query)
4 fp_async_probe: probe:beta                   ← EM_ASYNC_JS suspend
done
```

No state corruption, no hangs, no stack errors, in either JS-lib→EM_ASYNC_JS or
EM_ASYNC_JS→JS-lib transitions.

### Node V8

- `test-regression.mjs` (8.4.1) — PASS; `test-session3.mjs` — PASS (fp_async_call
  path untouched).
- `test-session11.mjs` (same interleaving against the stub handler) — PASS:
  `start / 1 call: 42 / 2 probe: probe:alpha / 3 call: 100 / 4 probe: probe:beta / done`.

### Trampoline / GOT check (open risk #3)

workerd init clean. Zero `convertJsFunctionToWasm` / "Wasm code generation" /
`Table.set` errors in the wrangler log — no GOT.func signature beyond `vp` appeared.
The single bundled `trampoline-vp.wasm` still suffices. EM_ASYNC_JS imports are wired
as ordinary (async) JS imports, not via the GOT/addFunction path.

### Size (8.4 worker, gzip -9)

| | raw | gz |
|---|---|---|
| Session 9 final | 16,462,783 | 4,139,775 |
| + probe (1 EM_ASYNC_JS import + PHP wrapper) | 16,465,116 | 4,139,768 |
| delta | **+2,333** | **−7 (noise)** |

The fixed overhead of an additional EM_ASYNC_JS import is negligible; the future
driver's size cost will be its own logic.

### Aftermath

Probe reverted from the scratch tree (canonical source clean); the patch file is the
record. The deployed `worker/build` artifacts were rebuilt probe-free. Next session:
the clean-room D1 PDO driver (ADR-0021), starting with D1 `meta.last_row_id`/`changes`
sufficiency for `lastInsertId()`/affected-rows.

---

## D1 meta verification (pre-pdo_d1, Session 11.5, 2026-06-11)

JS-only probe (`worker/probes/d1-meta-probe.mjs`, run against the local miniflare D1
binding) measuring the `meta` object the pdo_d1 driver will build `lastInsertId()`
and `rowCount()`/`exec()` on. Motivation: Cloudflare's docs describe `changes` in
`sqlite3_total_changes()` (cumulative) terms, and there is a community report of
`changes: 0` on UPDATE…RETURNING — the driver must be designed against measurements.

### Measured (miniflare; `served_by: "miniflare.db"`; full log in the probe output)

| Statement | changes | last_row_id | notes |
|---|---|---|---|
| 1 CREATE TABLE | 0 | 5 (stale, pre-existing DB state) | `rows_written: 2` (schema tables) |
| 2 INSERT A | 1 | **1** | |
| 3 INSERT B | 1 | **2** | per-insert, not stale |
| 4 UPDATE matching 2 rows | **2** | 2 (stale) | per-statement, NOT cumulative |
| 5 UPDATE matching 0 rows | **0** | 2 (stale) | `changed_db: false` |
| 6 UPDATE one row RETURNING * | **1** | 2 (stale) | community report NOT reproduced; results_len 1 |
| 7 DELETE one row | **1** | 2 (stale) | |
| 8a/8b SELECT via run() / all() | 0 / 0 | 2 / 2 (stale) | meta identical across run()/all() |
| 8c SELECT with IN | 0 | 2 (stale) | `rows_written: 0` — community report not reproduced |
| 9 INSERT C | 1 | **2** | correct: rowid 2 was freed by the DELETE and reused (INTEGER PRIMARY KEY without AUTOINCREMENT) |
| 10 batch[0], batch[1] INSERTs | 1, 1 | **3, 4** | per-entry meta, correct per-statement values |
| 11 INSERT via all() | 1 | **5** | INSERT meta identical via all() |

### Conclusions

**a) `last_row_id`: per-insert and reliable — yes.** Increments correctly per INSERT
(1, 2), tracks rowid reuse after DELETE (9 → 2), and is correct per entry inside
`.batch()` (3, 4). On non-INSERT statements it holds the connection's last inserted
rowid (stale) — exactly `sqlite3_last_insert_rowid()` semantics, which is also PDO's:
the driver reads it immediately after each INSERT and caches it for `lastInsertId()`.

**b) `changes`: per-statement, NOT cumulative — and RETURNING-safe (in miniflare).**
UPDATE matching 2 → `2`; matching 0 → `0`; RETURNING → `1`; DELETE → `1`. The docs'
`sqlite3_total_changes()` wording does not match the measured behavior, which is
per-statement (`sqlite3_changes()`-like). The driver can map `rowCount()`/`exec()`
directly from `meta.changes` with **no delta computation** — with a production-D1
re-check before the driver is declared done (see c).

**c) Miniflare-vs-production re-verification list** (miniflare is an emulation;
flag, don't assume parity):
1. `changes` per-statement semantics (the cumulative docs wording) — re-measure on
   real D1.
2. UPDATE…RETURNING `changes` (the community report that motivated this probe was
   not reproduced locally — it may be a production-only or since-fixed behavior).
3. SELECT-with-IN `rows_written` (reported nonzero in production; 0 here).
4. CREATE TABLE meta quirks (changes=0 but rows_written=2; stale last_row_id).
The probe is committed (`worker/probes/d1-meta-probe.mjs`) precisely so the same
sequence can be re-run against production D1 with one config change.

Also measured: `.run()` and `.all()` return identical meta for the same statement;
`.batch()` returns full per-entry meta (relevant to transactions-via-batch, Phase 2).

---

## Session 12 — pdo_d1 Phase 1: PASS on both versions (2026-06-11)

**PASS.** The clean-room, Apache-2.0 D1 PDO driver (`pdo_d1`, ADR-0022) builds and
passes every gate on PHP 8.4.1 **and** 8.2.11: full Node mock-harness coverage, and the
real thing against miniflare D1 in workerd — including an `fp_async_call` interleave
mid-PDO-session. Every row of the pdo_cfd1 stub table is REAL in this driver.

### Implementation notes (what the gates surfaced)

- **Named parameters work via PDO core's rewriter** — better than the planned throw.
  Finding: PDO core only calls `pdo_parse_params` itself for `PLACEHOLDER_NONE`
  drivers; a POSITIONAL driver must call it in its own preparer (the
  pdo_mysql/pdo_pgsql pattern). `pdo_d1` does, getting `:name` → `?` rewriting +
  `bound_param_map` for free. The driver-level named-param throw remains as a safety
  net.
- **`execute([...])` binds as `PDO_PARAM_STR`** (standard PDO semantics) — params
  cross the JSON boundary as strings; SQLite/D1 column affinity handles comparisons.
  `bindValue(..., PDO::PARAM_INT/BOOL/NULL)` passes native JSON types (the driver
  honors `param_type`).
- **8.4 vs 8.2 PDO API delta: one field.** 8.4 adds a `scanner` member at the end of
  `pdo_dbh_methods`; the driver uses positional initializers that omit it (legal C,
  zero-initialized), compiling warning-clean-but-for-that on 8.4 and cleanly on 8.2.
  No other API differences — the dual-build promise (Session 8) holds.
- Statement execution always uses D1 `.all()` (meta identical to `.run()`, covers
  RETURNING — Session 11.5 measurements).

### Gate evidence

**Gate 1 (Node regression):** unchanged PASS both versions (fp_async_call untouched).

**Gate 2 (Node mock harness, `tests/test-pdo-d1-mock.mjs`):** PASS both versions —
connect, fetch/fetchAll/fetchObject/fetchColumn, typed binds, lastInsertId 42 (canned),
update rowCount 3, real exec(), `quote("it's")` → `'it''s'`, named-rewrite, PDOException
carrying the mock's D1_ERROR message, transactions throw honestly, bad DSN throws.

**Gate 3 (workerd, miniflare D1, both versions via X-PHP-Version, 2 requests each):**

```
start
select: hello from D1                              ← prepare/execute/fetchColumn
lastInsertId: 1 / lastInsertId2: 2                 ← real meta.last_row_id per INSERT
update rowCount: 2                                 ← real meta.changes
interleave fp_async_call: {"value":"goodbye from D1"}  ← both mechanisms in one run
rows: ["z","z"]                                    ← fetchAll(FETCH_COLUMN)
exception: has D1 message                          ← PDOException w/ D1 error text
php: 8.4.1 | 8.2.11
done
```

`exec()` of CREATE TABLE/DELETE actually executes (the table exists and is reused
across requests).

**Gate 4 (GOT/trampoline, open risk #3):** zero code-generation/`Table.set` errors in
the wrangler log with the driver's two additional EM_JS/EM_ASYNC_JS imports — `vp`-only
trampoline still suffices.

**Gate 5 (size, gzip -9):**

| | raw | gz | Δ vs Session 9 |
|---|---|---|---|
| 8.4 + pdo_d1 | 16,479,145 | 4,142,546 | +16,362 raw / +2,771 gz |
| 8.2 + pdo_d1 | 15,951,297 | 3,981,728 | +16,634 raw / +4,144 gz |

The whole driver costs ~16 KB raw / ~3-4 KB gz per binary. Combined bundle still
~7.75 MiB gz — comfortably inside the 10 MB Paid limit.

### Deferred (honest throws, Phase 2)

`beginTransaction`/`commit`/`rollBack` throw with an ADR-0022 reference (D1 has no
interactive transactions; batch() is its primitive — Phase 2 decides the strategy).
Driver-level named binding throws (unreachable in practice — core rewrites first).
Open item: production-D1 re-verification of the Session 11.5 meta measurements.

### Session 12 committed files

- `patches/session12-pdo-d1.patch` — `source/pdo_d1/{pdo_d1.c,php_pdo_d1.h,config.m4}`
  + Makefile wiring (`--enable-pdo-d1`, ext copy rule, configured dep)
- `tests/test-pdo-d1-mock.mjs` — the gate-2 mock harness (run from the scratch root)
- `worker/index.mjs` — permanent `mod.d1 = { main: env.DB }` injection
- `docs/DECISIONS.md` — ADR-0022 (committed first, per protocol)

---

## Session 13 — WordPress extension floor: complete, on both versions; over budget as measured (2026-06-11)

**The full MUST-KEEP floor is statically linked and functional on 8.4.1 and 8.2.11.**
All six batches built; every functional probe passes; the GOT/trampoline surface never
changed (`vp`-only held through all six batches — open risk #3 stays closed). The
combined two-binary bundle is now **15.89 MiB gz — 66% over the 10 MiB Paid limit**,
crossing at batch 2 (projected) exactly as the ADR-0023 tripwire protocol anticipated.
The fit-strategy decision is the next session's ADR, on these numbers.

### The headline artifact — per-batch size table (8.4 worker, `gzip -9`)

| Step | raw | gz | Δ raw | Δ gz |
|---|---|---|---|---|
| Session 12 base | 16,479,145 | 4,142,546 | — | — |
| B1 mbstring + oniguruma | 18,713,137 | 4,983,222 | +2,233,992 | +840,676 |
| B2 dom, simplexml, xml, xmlreader, xmlwriter | 22,802,101 | 6,030,294 | +4,088,964 | +1,047,072 |
| B3 openssl (libssl+libcrypto, ThinLTO) | 28,314,955 | 7,449,082 | +5,512,854 | +1,418,788 |
| B4 zip + zlib | 28,796,695 | 7,591,963 | +481,740 | +142,881 |
| B5 fileinfo | 37,509,719 | 8,043,367 | **+8,713,024** | +451,404 |
| B6 gd + png/jpeg/webp/freetype | **40,389,722** | **8,920,786** | +2,880,003 | +877,419 |

**Floor total (8.4): +23.9 MB raw / +4,778,240 B gz (+4.56 MiB).**
Final 8.2: 34,583,069 raw / 7,737,047 gz. **Combined: 16,657,833 B gz (15.89 MiB).**

Notable: B2 was predicted "cheap since libxml is already in" — it was not (+1 MiB gz);
the extension code itself under whole-program Asyncify is the mass, not the C library.
B5's raw cost is the embedded libmagic database (+8.7 MB raw) but it compresses 19:1.
B3 is the single largest gz increment (libcrypto). **Raw size is its own finding:**
the 8.4 binary is now 38.5 MiB raw — cold-start instantiation cost needs measuring
before production regardless of the compressed-fit strategy.

### Pipeline findings (flag, don't work around)

1. **The pipeline's mbstring static mode was broken for PHP 8.x**: it passed
   `--with-mbstring` / `--with-onig`, both unrecognized by 8.x configure (silently
   ignored → extension not built while libonig.a still linked). Fixed in
   `packages/mbstring/static.mak`: `--enable-mbstring`, oniguruma via pkg-config
   (`oniguruma.pc` already shipped). First observed as: batch-1 binary grew +672 KB
   with `extension_loaded('mbstring') === false`.
2. `packages/gd/static.mak` passed `--enable-png` (no such flag in 8.x; libpng is
   pkg-config-detected) — harmless no-op, removed for warning hygiene.
3. All other floor static modes were correct as shipped; no `$(error)` couplings, no
   new GOT.func signatures from any of the six static libs.
4. fileinfo has no pipeline package; `CONFIGURE_FLAGS+= --enable-fileinfo` in the env
   file is sufficient (no Makefile change needed).

### Verification (final, both versions)

Sanity line (workerd, both versions, 2 requests each):
`ext: mb dom sxml xml xr xw ssl zip zlib fi gd exif bc` — all 13 present.

Functional probes (loaded ≠ functional), identical on 8.2.11 and 8.4.1:
`mb_strlen("héllo wörld") = 11`; DOMDocument parse → `x`;
`openssl_random_pseudo_bytes(8)` → 8 bytes; ZipArchive create/read round-trip → `hi`;
`gzuncompress(gzcompress('ok'))` → `ok`; finfo->buffer() returns a MIME verdict
(`application/octet-stream` for the truncated PNG-signature probe — libmagic wants an
IHDR chunk before calling it image/png; the call path is what's proven);
`imagecreatetruecolor(1,1)` → ok. Plus the standing demo: D1 via pdo_d1 + an
fp_async_call interleave on every request.

`get_loaded_extensions()` (8.4; 8.2 identical mod ordering):
`Core,date,libxml,openssl,pcre,zlib,bcmath,ctype,dom,json,fileinfo,filter,gd,hash,SPL,mbstring,session,standard,PDO,pdo_d1,pib,random,Reflection,exif,SimpleXML,tokenizer,xml,xmlreader,xmlwriter,zip`

Node V8: regression + suspend/resume + pdo_d1 mock harness — PASS ×2 versions.
GOT/trampoline: zero codegen errors in every batch's wrangler log; `vp`-only.

### The three exit options, with this session's numbers (decision = next ADR)

| Option | Measured outcome |
|---|---|
| (i) Per-version Workers | **Fits today.** Each Worker carries one binary: 8.4 = 8.51 MiB gz, 8.2 = 7.38 MiB gz — both under 10 MiB with 1.5–2.6 MiB headroom. Cost: loses single-deployment header selection; two deployments to operate. |
| (ii) JSPI port | The structural lever: whole-program Asyncify instrumentation is the dominant multiplier on every batch's extension-code cost (see B2). Unmeasured until built; expected to shrink both binaries substantially and improve the raw-size/cold-start picture too. |
| (iii) Trim the floor | **Cannot reach 10 MiB combined alone.** The full floor costs +4.56 MiB gz against ~2.26 MiB of headroom; even dropping the two biggest optional batches (gd −0.84 + fileinfo −0.43 MiB gz) leaves the combined bundle ~14.3 MiB. Only useful in combination with (i) or (ii). |

### Session 13 committed files

- `patches/session13-extension-floor.patch` — env deltas (both versions) + the
  mbstring/gd static.mak flag fixes
- `worker/index.mjs` — canonical demo now carries the floor sanity line + functional
  probes (guarded; degrades gracefully on older binaries)
- `docs/DECISIONS.md` — ADR-0023 (committed first, per protocol)

---

## Session 14 — per-version Worker split: PASS (2026-06-12; no rebuild)

**PASS.** ADR-0024 adopted (i) per-version Workers; the deployment was restructured
(wrangler environments, one binary per Worker) and verified with the full standing
suite on both Workers. Config/loader surgery only — binaries unchanged from S13.

- Per-env `main` override verified empirically on wrangler 4.96.0 before committing
  to environments over two config files (dry-run with `--outdir` bundles the env's
  own entry).
- `php84` Worker (port 8791) and `php82` Worker (port 8792), two consecutive
  requests each: the complete Session 13 demo — pdo_d1 D1 query, fp_async_call
  interleave, all-13 extension sanity line, all functional probes — identical
  output to Session 13, with the correct `X-PHP-Version-Served: 8.4` / `8.2`
  headers. GOT errors: 0 on both.
- Node V8 (config-only sanity that nothing got unwired): regression + pdo_d1 mock
  PASS on both versions.
- `docs/UPSTREAM.md` created and seeded with the three standing upstream findings
  (mbstring static-mode flags, gd bogus flag, unpinned companion-extension clones).

---

## Session 15 — WP-side shims, validated by micro-harness: 10/10 PASS both versions (2026-06-12)

**PASS.** The `db.php` drop-in (pdo_d1 connection layer + adapted
sqlite-database-integration translator) and the `FP_Async_Transport` Requests
transport (HTTP via `fp_async_call` → Worker fetch) both work against the live
runtime. Harness: **10/10 PASS on 8.4.1 (×2 consecutive requests) and 8.2.11 (×2)**.
No PHP rebuild. Translator adapted from WordPress/sqlite-database-integration
**v2.2.23 (`f3ea1a43ba525be382c7a9c17735b6b4d4b11d49`, GPL-2.0)** — the last
classic-translator release line; current upstream `main` is the unreleased AST
monorepo (revisit when it ships).

### Harness results (identical on both versions)

```
CHECK 1  PASS  translated CREATE TABLE (AUTO_INCREMENT + KEY)
CHECK 2  PASS  insert_id sequence: 1, 2
CHECK 3  PASS  rows_affected after UPDATE: 1
CHECK 4  PASS  get_results: typed rows (stringified per translator config)
CHECK 5  PASS  SHOW TABLES LIKE → sqlite_master translation
CHECK 6  PASS  failing query → last_error populated, no fatal
CHECK 7  PASS  transaction path survived (see note below)
CHECK 8  PASS  GET https://example.com/ → HTTP/1.1 200 OK, 559 B, headers reconstructed
CHECK 9  PASS  blocked URL → clean allowlist error, no hang
CHECK 10 PASS  DB → HTTP → DB interleave in one execution
SUMMARY: 10 PASS, 0 FAIL        php: 8.4.1 | 8.2.11
```

**Transaction-path honesty note (CHECK 7):** miniflare's local D1 ACCEPTS raw
`BEGIN`/`COMMIT` — the real-transaction path ran locally, not the degradation
path. Production D1 rejects them. The degradation path (disable-once + notice +
level-tracking no-ops) is therefore exercised in **Node** with a production-like
mock that rejects BEGIN: `tests/test-wp-shims-node.mjs` — PASS on both versions,
notice logged, execution continues. This miniflare/production split is itself a
finding: local-D1 permits more than production; transaction behavior must be on
the production re-verification list (with the Session 11.5 meta items).

### The D1-DIVERGENCE list (primary deliverable; markers in the source)

| # | Divergence | Handling | Found |
|---|---|---|---|
| 1 | PHP UDFs (`sqliteCreateFunction`) impossible — D1 cannot call into PHP; MySQL functions emulated via UDFs (DATE_FORMAT, FIELD, REGEXP, …) unavailable | registration guarded; queries using them will error | analytic |
| 2 | Init PRAGMAs: production D1 allows only a small subset; `encoding`/`journal_mode` rejected | try/catch guards; journal_mode never issued | analytic |
| 3 | Interactive transactions rejected (`BEGIN`/`COMMIT`/`ROLLBACK`) | graceful degradation: disable-once flag + notice; WP runs without transactions | analytic; **exercised in Node** (miniflare accepts BEGIN — see note) |
| 4 | `SELECT SQLITE_VERSION()` blocked ("not authorized to use function") — **even in miniflare** | try/catch, nominal '3.40.0' fallback | **live** (first harness run) |
| 5 | Named-placeholder reuse (`:datatype` twice in the data-types-cache upsert) fails — pdo_d1 is a native-positional driver; PDO does not bind a reused named marker without emulation (pdo_sqlite's native named support masked this upstream) | upsert rewritten to `excluded.mysql_type` (standard SQLite, no reuse) | **live** (D1: "Wrong number of parameter bindings") |
| 6 | ATTACH-based ALTER TABLE paths (translator's tempschema strategy) | untouched and UNEXERCISED — flagged as the top risk for dbDelta-heavy flows in the core boot | analytic |
| 7 | File-backed bootstrap (FQDB/FQDBDIR, .htaccess writing) | unused — PDO injected; constants defined as inert placeholders | analytic |

Divergence #5 is a **divergence class**, not a one-off: any translator SQL that
reuses a named placeholder will fail on pdo_d1. Future adaptation work should grep
for repeated `:name` per statement.

### Other findings

- The Requests 2.x registration mechanism: `WpOrg\Requests\Requests::add_transport()`
  is the supported path; WP's old `http_api_transports` filter is deprecated (6.4+)
  and never reaches Requests 2 transports. Requests is **ISC**-licensed (ADR-0025
  corrected from BSD).
- MEMFS seeding (11 PHP files, ~330 KB total) via wrangler Text-module rules +
  `FS.writeFile` worked without incident — no S16-relevant structural problems
  surfaced at this scale; the open question remains WordPress-scale (thousands of
  files), not the mechanism.
- Worker `fetch` action runs behind an explicit allowlist
  (`https://example.com/` only). **Production needs a real egress policy — SSRF
  surface** (ADR-0025 caveat, carried in HANDOFF).
- Node suite green: regression, pdo_d1 mock, and the new `test-wp-shims-node.mjs`
  (production-like txn rejection + fetch contract + allowlist error), both versions.

### Session 15 committed files

- `wp-shims/` — LICENSE (GPL-2.0), README (attribution), `db.php`, `sqlite/*`
  (7 vendored/adapted files), `requests-transport/*` (transport + ISC interface +
  registration snippet), `harness/*`
- `worker/run-php.mjs` — fetch action (allowlisted) + `?harness=1` MEMFS seeding
- `wrangler.toml` — Text-module rules for `.php`
- `tests/test-wp-shims-node.mjs` — the production-like Node validation
- README/NOTICE — dual-license layout; `docs/DECISIONS.md` — ADR-0025 (first)

---

## Asyncify vs JSPI comparison

*Pending Session 5.* To be recorded:

- Binary size, each path.
- Cold/warm/execution latency, each path, against the baseline.
- Whether JSPI works in the target runtime's compatibility configuration.
- Any frames that could not be suspended under JSPI.

## Negative results and surprises

### 1. Missing `npm install` → runaway `make _all` recursion (resolved)

**Symptom.** Running `make PHP_VERSION=8.0 ENV_FILE=... node-mjs` on a fresh
checkout produced an infinite loop: the log filled with `make _all` →
`make[N]: Entering directory ...` at ever-increasing recursion depth (observed
past `make[30]`), spawning hundreds of `make` processes, never reaching the
PHP build. It had to be killed with a loop over `pkill -9 -x make`.

**Root cause.** The Makefile discovers each extension package's `static.mak`
and `pre.mak` via `-include $(addsuffix /...,$(shell npm ls -p))` (Makefile
~227, ~244). With no `node_modules`, `npm ls -p` exits non-zero (ELSPROBLEMS,
"missing: ...") and yields nothing usable, so the build-target variables
(`${NODE_MJS}`, `${PHP_CONFIGURE_DEPS}`, …) expand to **empty**. The
`node-mjs` recipe then runs `$(MAKE)` with no target → the default goal
`all` → `_all` → sub-makes with empty target vars → `$(MAKE)` no-arg → `all`
again → infinite recursion.

**Fix.** Install the npm workspace first:
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install`. Afterward `npm ls -p`
exits 0 and returns all 41 workspace package paths, the `static.mak`
fragments resolve, target vars populate, and the build proceeds normally
(0 occurrences of `make _all` in the log). Documented as a required
prerequisite in BUILD.md.

### 2. Environment restart interrupted the first long build (recovered)

The first full `node-mjs` build was interrupted partway through the static-lib
stage by a host/WSL2 restart (all build processes and the build log gone, a
fresh `dockerd` PID, the date advanced). No build error — just lost state.
The Docker image, `node_modules`, the `php8.0-src` checkout, and the
already-built `.a` libs survived on disk, so re-running the same `make`
command resumed incrementally and completed. Lesson: these builds are long;
expect to re-invoke and rely on the Makefile's incrementality.

### 3. Link-time audit finding: libiconv — RESOLVED (iconv-resolution task, 2026-06-07)

**Original (Session 1) finding — since corrected.** The Session 1 audit
reported GNU libiconv 1.17 (`libiconv.a` + `libcharset.a`) as "statically
linked." This was an analysis error: the `lib/lib/libiconv.a` seen on disk
was an intermediate build artifact used to produce a WASM side module
(`packages/iconv/libiconv.so`), not a static archive linked into the main
binary. Confirmed by:
- `make -n -p` with `ENV_FILE=.circleci/.env_8.0.ci`: `ARCHIVES =` (empty).
- `php_config.h`: `HAVE_ICONV` and `HAVE_LIBICONV` are both `#undef`.
- `packages/iconv/static.mak`: `WITH_ICONV=1` → `dynamic` mode → adds only
  `DYNAMIC_LIBS`/`EXTRA_MODULES`, never `ARCHIVES`.

**What was actually the case.** GNU libiconv was built as a WASM side module
(dynamically loaded via Emscripten's side-module mechanism). The main
`php8.0-node.mjs.wasm` contained zero libiconv code.

**Resolution.** Set `WITH_ICONV=0` in `.circleci/.env_8.0.ci`. This drops
GNU libiconv entirely from the build — no side module, no static artifact.
The main wasm binary is byte-for-byte identical (confirmed: `HAVE_ICONV` was
already `#undef`; `ARCHIVES` was already empty). PHP's `ext/iconv` functions
are unavailable; encoding needs are covered by `ext/mbstring` (Oniguruma +
libmbfl, both permissive). libxml2 uses musl/Emscripten libc's built-in iconv
throughout. See ADR-0011.

**Post-resolution binary size (confirmed after rebuild, 2026-06-07).**

| Artifact               | Session 3 (WITH_ICONV=1/dynamic) | Post-resolution (WITH_ICONV=0) |
|------------------------|----------------------------------|--------------------------------|
| `…node.mjs.wasm` raw   | 12,183,180 B                     | 12,183,180 B (byte-identical)  |
| `…node.mjs` glue raw   | 316,256 B                        | 316,256 B (unchanged)          |

The glue size is also unchanged — the EXTRA_MODULES list change (removing the
iconv `.so` references) does not affect the JS glue emitted by Emscripten.

**Re-verification (baseline + Session 3 proof).** Both PASS on the rebuilt binary:
```
$ node test-regression.mjs   -> hello/"8.0.30" PASS
$ node test-session3.mjs     -> before:/after: 42 PASS (ordering confirmed, same latency)
```

OpenSSL is 1.1.1x (legacy dual OpenSSL/SSLeay license, permissive, not
Apache-2.0). No LGPL components remain in the binary or distribution.
