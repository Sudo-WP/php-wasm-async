#!/usr/bin/env python3
"""
Apply the two required workerd glue patches to worker/build/php8.0-worker.mjs.
These patches are documented in patches/session4-workerd-analysis.patch.

Patch 1: self.location.href guard
  - workerd ESM format has self.location = undefined at module load time
  - Emscripten's worker-env glue reads self.location.href unconditionally

Patch 2: addEventListener useCapture=false
  - workerd forbids useCapture=true (addEventListener 3rd arg)
  - Emscripten's emSetImmediate and Browser polyfills use true

Run from the php-wasm-async repo root:
  python3 worker/apply-workerd-patches.py
"""

import sys
import pathlib

GLUE = pathlib.Path(__file__).parent / 'build' / 'php8.0-worker.mjs'

if not GLUE.exists():
    print(f'ERROR: {GLUE} not found. Copy php8.0-worker.mjs to worker/build/ first.')
    sys.exit(1)

text = GLUE.read_text(encoding='utf-8')
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
    print('ERROR: Patch 1 target string not found in glue file. '
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

GLUE.write_text(text, encoding='utf-8')

print(f'Patched {GLUE} ({original_len} → {len(text)} bytes):')
for c in changes:
    print(f'  {c}')
print('Done.')
