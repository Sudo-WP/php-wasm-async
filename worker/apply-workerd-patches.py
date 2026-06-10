#!/usr/bin/env python3
"""
Apply the required workerd glue patches to every php*-worker.mjs glue file in
worker/build/. The patches are documented in patches/session4-workerd-analysis.patch
(patches 1, 2a, 2b) and docs/DECISIONS.md ADR-0015 (patch 3).

Patch 1: self.location.href guard
  - workerd ESM format has self.location = undefined at module load time
  - Emscripten's worker-env glue reads self.location.href unconditionally

Patch 2: addEventListener useCapture=false
  - workerd forbids useCapture=true (addEventListener 3rd arg)
  - Emscripten's emSetImmediate and Browser polyfills use true

Patch 3: convertJsFunctionToWasm trampoline cache
  - workerd blocks ALL runtime wasm compilation; the pre-compiled, wrangler-bundled
    trampoline-vp.wasm (populated into globalThis.__phpWasmTrampolines by
    worker/index.mjs) is used instead of new WebAssembly.Module(bytes).

Session 8: handles multiple glue files (php8.2-worker.mjs, php8.4-worker.mjs, ...).
Idempotent; safe to re-run.

Run from the php-wasm-async repo root:
  python3 worker/apply-workerd-patches.py
"""

import sys
import pathlib

BUILD_DIR = pathlib.Path(__file__).parent / 'build'
GLUES = sorted(BUILD_DIR.glob('php*-worker.mjs'))

if not GLUES:
    print(f'ERROR: no php*-worker.mjs found in {BUILD_DIR}. '
          'Copy the built glue file(s) to worker/build/ first.')
    sys.exit(1)


def patch_glue(glue: pathlib.Path) -> None:
    text = glue.read_text(encoding='utf-8')
    original_len = len(text)
    changes = []

    # Patch 1: self.location.href guard
    OLD1 = 'if(ENVIRONMENT_IS_WORKER){scriptDirectory=self.location.href}'
    NEW1 = 'if(ENVIRONMENT_IS_WORKER){scriptDirectory=(self.location&&self.location.href)||""}'
    if OLD1 in text:
        text = text.replace(OLD1, NEW1, 1)
        changes.append('Patch 1: self.location.href guard — applied')
    elif NEW1 in text:
        changes.append('Patch 1: self.location.href guard — already applied')
    else:
        print(f'ERROR: Patch 1 target string not found in {glue.name}. '
              'The glue format may have changed.')
        sys.exit(1)

    # Patch 2a: Browser_setImmediate_messageHandler useCapture
    OLD2A = 'addEventListener("message",Browser_setImmediate_messageHandler,true)'
    NEW2A = 'addEventListener("message",Browser_setImmediate_messageHandler,false)'
    if OLD2A in text:
        text = text.replace(OLD2A, NEW2A, 1)
        changes.append('Patch 2a: Browser_setImmediate useCapture=false — applied')
    elif NEW2A in text:
        changes.append('Patch 2a: Browser_setImmediate useCapture=false — already applied')
    else:
        print('WARNING: Patch 2a target not found (may be OK if this polyfill is absent)')
        changes.append('Patch 2a: Browser_setImmediate useCapture — NOT FOUND (skipped)')

    # Patch 2b: __setImmediate_cb useCapture
    OLD2B = 'addEventListener("message",__setImmediate_cb,true)'
    NEW2B = 'addEventListener("message",__setImmediate_cb,false)'
    if OLD2B in text:
        text = text.replace(OLD2B, NEW2B, 1)
        changes.append('Patch 2b: __setImmediate_cb useCapture=false — applied')
    elif NEW2B in text:
        changes.append('Patch 2b: __setImmediate_cb useCapture=false — already applied')
    else:
        print('WARNING: Patch 2b target not found (may be OK if this polyfill is absent)')
        changes.append('Patch 2b: __setImmediate_cb useCapture — NOT FOUND (skipped)')

    # Patch 3: convertJsFunctionToWasm cache
    # All 6 affected GOT.func symbols (emscripten_console_log/_error/_warn/_trace,
    # emscripten_out, emscripten_err) have sig 'vp'; worker/index.mjs populates
    # globalThis.__phpWasmTrampolines with the bundled trampoline-vp.wasm module.
    OLD3 = 'var module=new WebAssembly.Module(new Uint8Array(bytes));'
    NEW3 = ('var module=globalThis.__phpWasmTrampolines&&globalThis.__phpWasmTrampolines.has(sig)'
            '?globalThis.__phpWasmTrampolines.get(sig)'
            ':new WebAssembly.Module(new Uint8Array(bytes));')
    if OLD3 in text:
        text = text.replace(OLD3, NEW3, 1)
        changes.append('Patch 3: convertJsFunctionToWasm trampoline cache — applied')
    elif NEW3 in text:
        changes.append('Patch 3: convertJsFunctionToWasm trampoline cache — already applied')
    else:
        print(f'ERROR: Patch 3 target string not found in {glue.name}. '
              'The glue format may have changed.')
        sys.exit(1)

    glue.write_text(text, encoding='utf-8')

    print(f'Patched {glue} ({original_len} → {len(text)} bytes):')
    for c in changes:
        print(f'  {c}')


for glue in GLUES:
    patch_glue(glue)
print('Done.')
