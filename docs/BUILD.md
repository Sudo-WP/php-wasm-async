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

## Statically-linked libraries

The build links a set of libraries that are individually permissively
licensed (public-domain, MIT, BSD, Apache-2.0). **Exclude `readline`** (GPL)
and any GPL-licensed extension — see `DECISIONS.md` ADR-0001 and ADR-0003.

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

### Later sessions (outline, not yet validated)

1. Make `fp_async_call` actually suspend on an unresolved Promise
   (`Asyncify.handleAsync`) and make the run path await it (`pib_run` is
   currently called via a synchronous `ccall`). (Session 3)
2. Wire the binary into the target-runtime loader. (Session 4)

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
