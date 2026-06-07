# CLAUDE.md

Standing instructions for any AI coding assistant (e.g. Claude Code) working
in this repository. Read this first, every session.

## What this repo is

`php-wasm-async` rebuilds the PHP-to-WebAssembly runtime so PHP can call a
host-provided async function, suspend, and resume with the resolved value —
targeting serverless WebAssembly runtimes (initial target: Cloudflare
Workers / workerd). The async host-call bridge is generic: it exposes a
"PHP awaits a host Promise" primitive and assumes no specific data store.
See `docs/DESIGN.md`.

## This is a public, Apache-2.0 repository

- Keep it clean and generic. No private notes, no business context, no
  customer or commercial product names. This is an industry contribution
  first, a dependency second.
- License is Apache-2.0 on a clean-derivation path (`docs/DECISIONS.md`
  ADR-0001 and ADR-0003). Do **not** copy or patch GPL-licensed code (e.g.
  the WordPress Playground npm packages or their build scripts). You may
  read GPL sources for *facts* — such as which functions must be made
  suspendable — and re-derive them independently in your own scripts, but
  never copy their text.
- Exclude GPL components from the static link (notably `readline`) and
  avoid any GPL-licensed PHP extension.

## Working protocol (follow on every task)

1. **Before starting:** read the docs relevant to the task — at minimum
   `docs/HANDOFF.md` (current state + next action) and `docs/DECISIONS.md`
   (binding decisions), plus `docs/DESIGN.md`, `docs/BUILD.md`, or
   `docs/RESULTS.md` as the task touches them.
2. **Decision changes are recorded, never silent.** Do not contradict an
   accepted decision. If a task (or the prompt driving it) changes a
   previously-documented decision — even a sensible change — **record a new
   dated ADR that supersedes the old one, and reconcile every affected doc
   (HANDOFF, BUILD, etc.), as the FIRST step, before any code or build work.**
   A prompt that diverges from the docs without an ADR is itself the bug:
   treat the reconciling ADR as part of the task, not an afterthought. Commit
   the decision change as its own isolated, legible step.
3. **During:** stay within the decided approach — Asyncify first, JSPI as a
   later optimization (ADR-0002); PHP 8.0.30 (ADR-0004); Emscripten = the
   seanmorris `sm-updates` fork as built in Session 1 (ADR-0007), **not** stock
   4.0.19. Flag — do not silently work around — anything that conflicts with a
   decision or a documented constraint.
4. **After completing the task, update the docs so they reflect reality:**
   - `docs/BUILD.md` — replace "to be validated" scaffolding with the build
     steps that actually ran.
   - `docs/RESULTS.md` — record outcomes with evidence, including negative
     results (on failure: the exact stack trace and failing function).
   - `docs/HANDOFF.md` — update "Current state" and "Next action".
   - `docs/DECISIONS.md` — add a dated ADR if a new decision was made.
   Be rigorously honest: document what failed, not just what worked.

## Toolchain (pinned — see `docs/BUILD.md` and ADR-0007)

- Emscripten = the **seanmorris/emscripten `sm-updates` fork** (effective
  `emcc ~3.1.68-git`, on an `emscripten/emsdk:3.1.67` base), built into the
  pipeline's Docker image. This — **not** stock 4.0.19 — is the toolchain the
  reference pipeline validates against and the one this project builds with
  (ADR-0007 superseded ADR-0004 on this point). The host `~/emsdk` 4.0.19 is
  incidental: handy for ad-hoc `emcc` checks only; the build runs inside the
  Docker builder image.
- PHP **8.0.30** source baseline.
- Node.js for running/benchmarking outside the runtime. Benchmark in Node
  V8 — the in-Worker clock clamps to 1s precision.
- The reference build pipeline is container-based; builds run in Docker. The
  pipeline checkout lives at `~/scratch/php-wasm-upstream/` (outside this
  repo). Run `npm install` there before `make`, or the build recurses
  infinitely (RESULTS negative result #1).

## Don't

- Don't commit secrets (e.g. Cloudflare API tokens, `.dev.vars`, wrangler
  credentials).
- Don't add business or private context to any file.
- Don't float the toolchain to "latest" — the pin is deliberate.
