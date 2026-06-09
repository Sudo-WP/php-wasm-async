# Build

How to reproduce the runtime build.

> **Status: validated (Session 1, 2026-06-03).** The procedure below built an
> unmodified PHP 8.0.30 WebAssembly binary from source via the seanmorris
> pipeline; it runs synchronously in Node (see `RESULTS.md`). One correction
> surfaced during the build: the reference pipeline uses Emscripten **3.1.68
> from the seanmorris fork**, not stock 4.0.19 — see ADR-0007, which
> supersedes ADR-0004 on the Emscripten pin.

---

## Toolchain (pinned)

| Component       | Version  | Notes                                              |
|-----------------|----------|----------------------------------------------------|
| Emscripten SDK  | 3.1.68 (seanmorris fork `sm-updates`, on `emscripten/emsdk:3.1.67` base) | **Corrected in Session 1 (ADR-0007).** The reference pipeline replaces stock Emscripten with this fork; stock 4.0.19 is *not* what it validates against. Covers both Asyncify and JSPI (JSPI needs ≥ 3.1.61). |
| PHP source      | 8.0.30   | Initial baseline. Designed so a later bump to a supported branch is a version-string change. |
| Node.js         | LTS      | For running and benchmarking the binary outside the serverless runtime. |
| Node.js (JSPI)  | 24-class | A build able to run `--experimental-wasm-jspi`, for the JSPI smoke test only. |
| Docker          | current  | The reference build pipeline is container-based.   |
| workerd / CLI   | current  | For running the PoC in the serverless runtime locally. |

Pin Emscripten explicitly; do not float to the latest toolchain.

## Statically-linked libraries and iconv configuration

The build links a set of libraries that are individually permissively
licensed (public-domain, MIT, BSD, Apache-2.0). **Exclude `readline`** (GPL)
and any GPL-licensed extension — see `DECISIONS.md` ADR-0001 and ADR-0003.

**iconv: build with `WITH_ICONV=0`.** The upstream env file ships with
`WITH_ICONV=1` (→ `dynamic`: GNU libiconv as a WASM side module). For this
project, `patches/iconv-resolution.patch` changes it to `WITH_ICONV=0`,
which drops `ext/iconv` and GNU libiconv entirely. PHP core was already
compiled with `HAVE_ICONV` undefined (iconv was never in the main wasm); the
only change is that the side-module artifacts (`libiconv.so`,
`php8.0-iconv.so`) are no longer built. Encoding needs are covered by
`ext/mbstring` (Oniguruma + libmbfl, permissive). See ADR-0011.

## Environment prep checklist

Before the first build session:

- [ ] Docker installed with the WSL2 backend; `docker build` / `docker run`
      working.
- [ ] Emscripten SDK 4.0.19 installed; environment sourced; `emcc --version`
      reports 4.0.19.
- [ ] PHP 8.0.30 source tarball downloaded and cached.
- [ ] Node.js LTS installed.
- [ ] A `--experimental-wasm-jspi`-capable Node.js available (for the later
      JSPI smoke test).
- [ ] workerd and the deploy CLI installed, able to run a worker locally.
- [ ] 25–40 GB free disk for the toolchain, source trees, and Docker layers.
- [ ] 8 GB+ RAM available to the WSL2 VM (the link step for the binary is
      memory-hungry).
- [ ] Git, and the repository scaffolded with the Apache-2.0 `LICENSE`, a
      `NOTICE` file, and the five project documents.

## What this build changes versus the reference pipeline

The reference PHP-to-WebAssembly pipeline is used as documentation of *how*
PHP is compiled to WebAssembly and *which* functions must be made
suspendable. This build differs from it in a small, well-scoped way:

1. Adds exactly one entry — `fp_async_call` — to the suspendable-imports
   list (and, in the JSPI variant, the corresponding imports/exports lists).
2. Provides the host implementation of that import in a loader written for
   the target serverless runtime.
3. Emits a loader compatible with the target runtime's instantiation and
   output conventions, rather than a Node- or browser-oriented loader.

Everything else follows the same compilation recipe.

## Build procedure

### Session 1 — baseline (validated 2026-06-03)

The baseline build runs the Apache-2.0 `seanmorris/php-wasm` pipeline in a
scratch checkout (kept **outside** this repo to avoid mixing its sources with
our Apache-2.0 tree). PHP 8.0.30 is built from `php/php-src` (branch
`php-8.0.30`) — genuinely from source, not a prebuilt binary.

```bash
# 0. Toolchain on PATH (host emcc is only needed for ad-hoc checks; the build
#    itself runs entirely inside the Docker builder image).
source ~/emsdk/emsdk_env.sh        # host emcc 4.0.19 — NOT what the build uses

# 1. Clone the reference pipeline into a scratch dir (not this repo).
git clone --depth 1 https://github.com/seanmorris/php-wasm.git \
    ~/scratch/php-wasm-upstream
cd ~/scratch/php-wasm-upstream

# 2. REQUIRED PREREQUISITE — install the npm workspace.
#    The Makefile discovers each extension's static.mak/pre.mak via
#    `$(shell npm ls -p)`. Without node_modules, `npm ls -p` errors, the
#    build-target variables come out EMPTY, and `make <target>` degrades to a
#    no-arg `$(MAKE)` -> default goal `all` -> infinite `make _all` recursion.
#    (See RESULTS.md "Negative results".)
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund

# 3. Build the toolchain image (downloads emscripten/emsdk:3.1.67, then
#    REPLACES its Emscripten with the seanmorris fork `sm-updates`, giving an
#    effective emcc 3.1.68-git — see ADR-0007). One-time; image ~5.9 GB.
make image

# 4. Build PHP 8.0.30 -> WebAssembly for the Node/CLI environment, full
#    extension config. ASYNCIFY is on by upstream default (no fp_async_call
#    import yet — that is Session 2).
make PHP_VERSION=8.0 ENV_FILE=.circleci/.env_8.0.ci node-mjs
```

**Outputs** (in `packages/php-wasm/`, gitignored, not committed):

- `php8.0-node.mjs.wasm` — the binary (~11.6 MiB raw). Note the suffix is
  `8.0`, not `80`.
- `php8.0-node.mjs` — Emscripten JS glue (~308 KiB).
- `PhpBase.mjs`, `PhpNode.mjs`, helpers — the loader surface.

**Run it in Node** (the `8.0` runtime is selected by `version`):

```js
import { PhpNode } from '.../packages/php-wasm/PhpNode.mjs';
const php = new PhpNode({ version: '8.0' });
php.addEventListener('output', e => e.detail.forEach(l => process.stdout.write(l)));
await php.binary;                       // instantiate wasm
await php.run('<?php echo "hello\\n";'); // -> "hello", exit 0, synchronous
```

The full extension set (`.env_8.0.ci`) links statically into one binary — no
`.so` files are emitted. The link-time license audit of that set is in
`NOTICE`; it surfaced one open issue (libiconv, LGPL-2.1) — see `RESULTS.md`.

### Session 2 — add the `fp_async_call` import (validated 2026-06-03)

Adds **exactly one** new host import to the Session 1 baseline. The complete,
reproducible delta is committed as `patches/session2-fp_async_call.patch`
(against the pipeline checkout); apply it with `git apply` from
`~/scratch/php-wasm-upstream/` and rebuild. The three changes are:

1. **Host implementation** — `source/library_fp_async.js` (our Apache-2.0
   code) registers the `fp_async_call` WebAssembly import via
   `mergeInto(LibraryManager.library, …)`. Session 2 body is synchronous
   (`payload + 1`); Session 3 swaps it for a deferred Promise.
2. **PHP exposure** — `source/pib/pib.c` (the already-wired `pib` extension)
   gains `extern int fp_async_call(int)`, a `PHP_FUNCTION(fp_async_call)`
   wrapper, and a `zend_function_entry` table (the module previously
   registered no userspace functions). PHP can now call `fp_async_call($x)`.
3. **Link flags** — one `EXTRA_FLAGS` line in the `Makefile` adds
   `--js-library /src/source/library_fp_async.js` and
   `-s ASYNCIFY_IMPORTS=fp_async_call`.

Rebuild with the **identical** Session 1 command — editing `pib.c` forces the
re-copy into `php-src/ext/pib`, a reconfigure, a recompile, and a relink that
picks up the new flags:

```bash
cd ~/scratch/php-wasm-upstream
ls -d node_modules >/dev/null || PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
git apply ~/php-wasm-async/patches/session2-fp_async_call.patch   # if pristine
make PHP_VERSION=8.0 ENV_FILE=.circleci/.env_8.0.ci node-mjs
```

Verify in Node: `function_exists("fp_async_call")` is true and
`fp_async_call(41)` returns `42` (`before:\nafter: 42\n`), exit 0.

#### Suspendable-functions list — **one entry, no iteration needed**

The most important Session 2 finding. The seanmorris pipeline builds with
**whole-program Asyncify** (`-sASYNCIFY=1` and **no `ASYNCIFY_ONLY`
allowlist** anywhere — confirmed by grep across the Makefile, `source/`, and
the env file). Every function is already instrumented to unwind/rewind, so the
entire `pib_run → zend_eval_string → … → fp_async_call` stack is suspendable
out of the box. The full suspendable-imports list is therefore just:

```
fp_async_call          # the one import we added (ASYNCIFY_IMPORTS)
```

No "add a function, rebuild, read the next crash" iteration occurred — adding
the import built and ran on the first attempt. This is the opposite of the
WordPress Playground experience, which curates an `ASYNCIFY_ONLY` allowlist
(smaller binary, but each new suspend point can surface a chain of functions
that must be added). See ADR-0008 for the trade-off and its forward
implications (JSPI port).

### Session 3 — async host implementation + run-path change (validated 2026-06-07)

Upgrades `fp_async_call` from a synchronous stub to a genuine suspend/resume
point. Two source-only changes (no C recompile; only a re-link is needed because
`library_fp_async.js` is a JS library merged at link time). Complete, reproducible
delta committed as `patches/session3-suspend.patch`.

#### The two changes

1. **`source/library_fp_async.js`** — replace the synchronous body with
   `Asyncify.handleAsync(async () => ...)` wrapping a Promise resolved by
   `setTimeout(..., 0)`. Add `fp_async_call__async: true` annotation. The
   `__async: true` annotation is the established Emscripten pattern (confirmed in
   `jsifier.mjs:441` of the seanmorris 3.1.68 fork) — it marks this function as
   participating in Asyncify at the JS-codegen level.

2. **`source/PhpBase.mjs` `_run()`** — add `{async: true}` to the `php.ccall`
   for `pib_run`. This is the critical run-path fix: without it, Emscripten's ccall
   wrapper returns the Asyncify "async in progress" sentinel synchronously and
   discards the result — the stack unwinds but never rewinds. With `{async: true}`,
   ccall returns a Promise that Emscripten resolves only after the full Asyncify
   suspend/resume cycle completes.

#### How to reproduce

Apply both session patches on top of the upstream baseline, then trigger a
re-link. The re-link is needed because `library_fp_async.js` is not in the
Makefile's `DEPENDENCIES`, so Make does not detect the change automatically —
touch `source/env.js` (which IS in `PRE_JS_FILES → PRE_JS_CACHE → DEPENDENCIES`)
to force the link step without a full PHP recompile:

```bash
cd ~/scratch/php-wasm-upstream
# Apply sessions 2 and 3 on a clean upstream checkout
git apply ~/php-wasm-async/patches/session2-fp_async_call.patch
git apply ~/php-wasm-async/patches/session3-suspend.patch
# Force re-link (library_fp_async.js is not auto-tracked by Make)
touch source/env.js
make PHP_VERSION=8.0 ENV_FILE=.circleci/.env_8.0.ci node-mjs
```

The `.wasm` binary is identical to Session 2 (the Asyncify-capable binary from
Session 2 already contains everything needed; the async logic lives in the JS
glue). Only the JS glue is re-emitted. Verify:

```bash
node test-session3.mjs    # before:/after: 42 + ordering markers — PASS
node test-regression.mjs  # hello/8.0.30 — PASS
```

### iconv-resolution task — drop GNU libiconv (2026-06-07)

Applies `patches/iconv-resolution.patch` to set `WITH_ICONV=0` in
`.circleci/.env_8.0.ci`. This drops GNU libiconv (LGPL) from the build
entirely; the main wasm binary is byte-identical (ARCHIVES was already empty
of libiconv in the prior `dynamic` mode; only the side-module build and
EXTRA_MODULES list change). After applying the patch, a full `make` reruns
the PHP configure + link steps (triggered by ENV_FILE being in DEPENDENCIES):

```bash
cd ~/scratch/php-wasm-upstream
git apply ~/php-wasm-async/patches/session2-fp_async_call.patch   # if pristine
git apply ~/php-wasm-async/patches/session3-suspend.patch
git apply ~/php-wasm-async/patches/iconv-resolution.patch
touch source/env.js   # force re-link (same reason as Session 3)
make PHP_VERSION=8.0 ENV_FILE=.circleci/.env_8.0.ci node-mjs
```

The rebuild verifies that the iconv drop does not cascade (no linking errors,
no PHP configure failures). Post-build sizes and test results are in `RESULTS.md`.

### Session 4 — workerd integration attempt (2026-06-08, BLOCKED)

**Goal:** wire the Session 3 binary into a Cloudflare Worker and confirm
suspend/resume in workerd locally via `wrangler dev`.

**Build artifact used:** `php8.0-worker.mjs` + `php8.0-worker.mjs.wasm`
(built with `make PHP_VERSION=8.0 ENV_FILE=.circleci/.env_8.0.ci worker-mjs`
from the upstream pipeline). This is the worker-env glue, analogous to the
node-mjs target. It ships with `ENVIRONMENT_IS_WORKER = true` hardcoded.

**Setup:**
```bash
# In the project repo (not the upstream scratch checkout)
# Install wrangler if not present
npm install -g wrangler@4.96.0

# Copy built artifacts (gitignored) to worker/build/
mkdir -p worker/build
cp ~/scratch/php-wasm-upstream/packages/php-wasm/php8.0-worker.mjs \
   worker/build/php8.0-worker.mjs
cp ~/scratch/php-wasm-upstream/packages/php-wasm/php8.0-worker.mjs.wasm \
   worker/build/php8.0-worker.mjs.wasm
```

**Three required glue patches** (applied to `worker/build/php8.0-worker.mjs`
before running wrangler; documented in `patches/session4-workerd-analysis.patch`):

1. `self.location.href` guard (required — workerd ESM has `self.location = undefined`):
   ```
   OLD: if(ENVIRONMENT_IS_WORKER){scriptDirectory=self.location.href}
   NEW: if(ENVIRONMENT_IS_WORKER){scriptDirectory=(self.location&&self.location.href)||""}
   ```

2. `addEventListener` useCapture fix (required — workerd forbids `true`):
   ```
   OLD: addEventListener("message",Browser_setImmediate_messageHandler,true)
   NEW: addEventListener("message",Browser_setImmediate_messageHandler,false)
   OLD: addEventListener("message",__setImmediate_cb,true)
   NEW: addEventListener("message",__setImmediate_cb,false)
   ```

3. **Patch 3 has no valid JS-level fix** — the `addFunction/convertJsFunctionToWasm`
   chain requires either `WebAssembly.Function` (unavailable) or `new
   WebAssembly.Module(bytes)` (blocked). See ADR-0012. This is the hard blocker.

**Run wrangler dev (after patches 1 and 2):**
```bash
cd /path/to/php-wasm-async
wrangler dev --local --port 8787
# In another terminal:
curl http://localhost:8787/
```

**Result:** 500 error. The exact error (from wrangler console):
```
[worker] instantiate error: TypeError: WebAssembly.Table.set(): Argument 1 is
invalid for table: function-typed object must be null (if nullable) or a Wasm
function object
  at addFunction → reportUndefinedSymbols → loadDylibs → receiveInstance
```

**JSPI availability probe:**
```js
// Minimal probe worker
export default { fetch() {
  const keys = Object.getOwnPropertyNames(WebAssembly).join(', ');
  const f = typeof WebAssembly.Function;
  return new Response(`keys: ${keys}\nWebAssembly.Function: ${f}\n`);
}}
```
Result: `Suspending, promising, SuspendError` present; `WebAssembly.Function` undefined.

**Session 4 committed files:**
- `worker/index.mjs` — workerd loader entry (status: BLOCKED, per comment)
- `wrangler.toml` — wrangler config
- `patches/session4-workerd-analysis.patch` — full three-patch analysis

### Session 5 — WITH_LIBXML=static rebuild + workerd trampoline fix (validated 2026-06-09)

**Goal:** fix the Session 4 init blocker and confirm Asyncify suspend/resume inside
workerd. See DECISIONS.md ADR-0014 (approach) and ADR-0015 (result).

**Part 1: Rebuild the PHP wasm with static libxml2 + libtidy.**

Apply the session5 patch on top of sessions 2, 3, and iconv-resolution:

```bash
cd ~/scratch/php-wasm-upstream
# Apply all four patches in order (from a clean upstream checkout)
git apply ~/php-wasm-async/patches/session2-fp_async_call.patch
git apply ~/php-wasm-async/patches/session3-suspend.patch
git apply ~/php-wasm-async/patches/iconv-resolution.patch
git apply ~/php-wasm-async/patches/session5-static-libxml.patch

# REQUIRED: clear the PHP configure cache (--with-libxml path changed; stale
# cache causes "cannot compute suffix of executables" configure error)
docker run --rm -v /home/sikam/scratch/php-wasm-upstream:/src \
    seanmorris/php-emscripten-builder:latest \
    rm -f /src/.cache/config-cache /src/third_party/php8.0-src/configured

# Build the worker-env glue (~20 min; libxml2 + libtidy now statically linked)
make PHP_VERSION=8.0 ENV_FILE=.circleci/.env_8.0.ci worker-mjs
```

The session5 patch makes three changes (see the patch file for detail):
1. `.circleci/.env_8.0.ci`: `WITH_LIBXML=1` → `WITH_LIBXML=static`,
   `WITH_TIDY=1` → `WITH_TIDY=static`
   (tidy requires libxml in the same mode; a `$(error ...)` in tidy's `static.mak`
   enforces this).
2. `Makefile`: adds `PHP_CONFIGURE_DEPS+= lib/lib/libxml2.a` sentinel.
   (With `WITH_LIBXML=static`, libxml's `static.mak` does NOT add to
   `PHP_CONFIGURE_DEPS`. The empty variable causes `$(MAKE) ${PHP_CONFIGURE_DEPS}`
   to become a bare `$(MAKE)` → default goal `all` → `_all` → infinite recursion.
   The sentinel keeps the variable non-empty and points to an already-built artifact.)

**Verify Node V8 regression before proceeding to workerd:**

```bash
node test-regression.mjs   # expect: hello/"8.0.30" PASS
node test-session3.mjs     # expect: before:/after: 42 PASS (ordering confirmed)
```

**Part 2: Copy artifacts and apply workerd patches.**

```bash
# Copy built artifacts to worker/build/ (gitignored directory)
mkdir -p ~/php-wasm-async/worker/build
cp ~/scratch/php-wasm-upstream/packages/php-wasm/php8.0-worker.mjs \
   ~/scratch/php-wasm-upstream/packages/php-wasm/php8.0-worker.mjs.wasm \
   ~/php-wasm-async/worker/build/

# Apply all four workerd glue patches (idempotent; safe to re-run)
python3 ~/php-wasm-async/worker/apply-workerd-patches.py
```

`apply-workerd-patches.py` applies four patches to `worker/build/php8.0-worker.mjs`:
1. `self.location.href` guard (workerd ESM has `self.location = undefined`)
2a. `Browser_setImmediate useCapture` → `false`
2b. `__setImmediate_cb useCapture` → `false`
3. `convertJsFunctionToWasm` cache: replaces `new WebAssembly.Module(bytes)` with a
   `globalThis.__phpWasmTrampolines.get(sig)` lookup. `worker/index.mjs` populates
   this map with the wrangler-bundled `trampoline-vp.wasm` before PHP instantiation.

**Part 3: Run and verify in workerd.**

```bash
cd ~/php-wasm-async
wrangler dev --local --port 8791 &
sleep 5
curl http://localhost:8791/
# Expected: before:\nafter: 42\n
```

**The trampoline wasm** (`worker/build/trampoline-vp.wasm`, 31 bytes, committed) is
the key. It implements the `vp` (void, i32) signature required by all 6 Emscripten
console/output GOT.func symbols. Wrangler bundles it at compile time as a
`WebAssembly.Module` (AOT-compiled, no runtime compilation). `new WebAssembly.Instance`
of a pre-compiled bundled module IS allowed in workerd (instantiation, not compilation).
Runtime compilation (`new WebAssembly.Module(bytes)` and `WebAssembly.compile(bytes)`)
are both blocked; only bundle-time AOT compilation works.

### Session 6 — real async host call + string marshalling (validated 2026-06-09)

**Goal:** replace the `setTimeout(0)`/int stub with a registered `Module.hostAsyncCall`
handler backed by Cloudflare KV. Changes `fp_async_call` to `string → string`.

**Part 1: Rebuild both node-mjs and worker-mjs.**

`pib.c` changes (string arginfo) force the ext re-copy, reconfigure, recompile, and
relink — same mechanism as Session 2. Apply the session6 patch on top of sessions 2,
3, iconv-resolution, and session5:

```bash
cd ~/scratch/php-wasm-upstream
# Apply session6 patch (if working from a clean checkout with earlier patches applied)
git apply ~/php-wasm-async/patches/session6-real-async.patch

# Rebuild worker binary (the prod target for workerd)
make PHP_VERSION=8.0 ENV_FILE=.circleci/.env_8.0.ci worker-mjs

# Rebuild node binary (needed for Node V8 regression + handler tests)
make PHP_VERSION=8.0 ENV_FILE=.circleci/.env_8.0.ci node-mjs
```

The session6 patch changes two files:
1. `source/library_fp_async.js` — string payload (UTF8ToString), registered handler
   dispatch (`Module.hostAsyncCall`), stub fallback, string return (`stringToNewUTF8`).
2. `source/pib/pib.c` — `extern char* fp_async_call(const char* payload)`;
   `PHP_FUNCTION` arginfo changed to `IS_STRING`; `Z_PARAM_STRING` + `RETVAL_STRING`
   + `free(result)` pattern (JS side allocates with `stringToNewUTF8` / `_malloc`;
   C side copies to PHP heap via `RETVAL_STRING` then frees the wasm allocation).

**Note on node-mjs binary size**: the `node-mjs` target now uses `WITH_LIBXML=static`
(from the session5 patch applied to `.env_8.0.ci`), so `php8.0-node.mjs.wasm` is now
~15.8 MB, same as the worker binary. This is expected.

**Part 2: Verify Node V8 (regression + new handler test).**

```bash
cd ~/scratch/php-wasm-upstream
node test-regression.mjs    # hello/"8.0.30" — PASS
node test-session3.mjs      # before:/after: 42 (stub fallback) — PASS
node test-session6.mjs      # before:/after: hello from KV (handler) — PASS
```

`test-session6.mjs` sets `phpModule.hostAsyncCall = async (key) => "hello from KV"`
on the resolved `php.binary` module instance before calling `php.run()`. This proves
string marshalling and handler dispatch work in isolation from workerd.

**Part 3: Copy artifacts, apply workerd patches, seed KV, verify in workerd.**

```bash
# Copy both artifacts to worker/build/ (gitignored)
cp ~/scratch/php-wasm-upstream/packages/php-wasm/php8.0-worker.mjs \
   ~/scratch/php-wasm-upstream/packages/php-wasm/php8.0-worker.mjs.wasm \
   ~/php-wasm-async/worker/build/

# Apply all four workerd glue patches (idempotent)
python3 ~/php-wasm-async/worker/apply-workerd-patches.py

# Seed the KV key once (miniflare local store; needs --preview false because
# wrangler.toml has both id and preview_id set)
cd ~/php-wasm-async
wrangler kv key put --binding=KV "greeting" "hello from KV" --local --preview false

# Start wrangler dev and curl
wrangler dev --local --port 8791 &
sleep 6
curl http://localhost:8791/
# Expected: before:\nafter: hello from KV\n
```

The KV seeding must be done once after any `wrangler` state reset. The seeded value
persists across `wrangler dev` restarts. Do not hardcode the value in the worker —
keep the KV read on the real async path.

## Known fragile steps

- **Exhaustive suspendable-imports list.** *Not a problem on this pipeline*
  (Session 2 finding): it uses whole-program Asyncify with no `ASYNCIFY_ONLY`
  allowlist, so all functions are already suspendable and adding an import
  needs no iteration. This step only bites if a curated allowlist is later
  introduced (e.g. to shrink the binary), or under JSPI. See ADR-0008.
- **First container build is long** and produces large intermediate layers.
- **JSPI frame-suspension limits.** Some functions cannot be suspended via
  JSPI and must be handled differently; relevant only when porting to JSPI.
- **Runtime instantiation.** The loader must instantiate from statically
  bundled bytes; the target runtime blocks runtime compilation of
  WebAssembly.
