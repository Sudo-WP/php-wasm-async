# Results

Benchmarks and findings — what works, what does not, with evidence.
Negative results are first-class and are recorded here, not glossed over.

> **Status: iconv-resolution task complete (2026-06-07).** Session 3 PoC PASS
> stands. GNU libiconv dropped (`WITH_ICONV=0`); no LGPL in binary or distribution.
> Main wasm is byte-identical (12,183,180 B). Session 4 (port to workerd) is next.

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
