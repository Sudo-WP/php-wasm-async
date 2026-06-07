# Decisions

A dated log of architecture and project decisions for `php-wasm-async`.
Newest entries at the top. Each entry records the decision, the reasoning,
the alternatives considered, and any follow-up obligations.

Format is loosely [ADR](https://adr.github.io/)-style. Decisions are not
immutable; a later entry may supersede an earlier one, in which case the
earlier one is marked **Superseded** with a pointer.

---

## ADR-0013 — JSPI confirmed available in workerd; designated path for workerd integration
**Date:** 2026-06-08 · **Status:** Accepted · **Depends on:** ADR-0012

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
**Date:** 2026-06-08 · **Status:** Accepted · **Per:** ADR-0006 hard-stop criterion

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
