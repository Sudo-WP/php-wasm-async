/**
 * php-wasm-async Session 5: suspend/resume PoC for Cloudflare Workers / workerd.
 *
 * Imports the Emscripten worker-env glue and the pre-compiled wasm module.
 * Wrangler bundles the .mjs glue and compiles the .wasm at bundle time —
 * the instantiateWasm hook pre-compiles wasm trampolines for Emscripten's
 * GOT.func JS-function stubs (blocked synchronously in workerd), then hands
 * the pre-compiled PHP module to Emscripten via the receive callback.
 *
 * Status: PASS — see docs/RESULTS.md Session 5.
 * Asyncify suspend/resume works in workerd: curl http://localhost:8791/ returns
 * "before:\nafter: 42\n". The key insight: WITH_LIBXML=static + pre-compiling
 * the 'vp'-signature trampoline async resolves the MAIN_MODULE init blocker.
 * Six GOT.func symbols (emscripten_console_log/_error/_warn/_trace,
 * emscripten_out, emscripten_err) all require a vp trampoline; the cache is
 * populated once before instantiation and reused for all six.
 *
 * Apache-2.0. Our own code; no GPL or LGPL content.
 */

import PHP from './build/php8.0-worker.mjs';
import phpWasm from './build/php8.0-worker.mjs.wasm';
// Pre-compiled wasm trampoline for sig 'vp' (void, i32).
// Wrangler compiles this .wasm at bundle time → WebAssembly.Module.
// apply-workerd-patches.py Patch 3 makes convertJsFunctionToWasm read from
// globalThis.__phpWasmTrampolines instead of calling new WebAssembly.Module(bytes),
// which workerd forbids at runtime. Synchronous new WebAssembly.Instance of a
// wrangler-bundled module (no new code generation) IS allowed.
import trampolineVP from './build/trampoline-vp.wasm';

// The PoC PHP script — identical to Node V8 Session 3 proof.
const PHP_CODE = `<?php
echo "before:\n";
$r = fp_async_call(41);
echo "after: " . $r . "\n";
`;

export default {
    async fetch(_request, _env, _ctx) {
        try {
            return await runPhp();
        } catch (e) {
            console.error('[worker] error:', e);
            return new Response('Error: ' + String(e) + '\n' + (e?.stack || ''), {
                status: 500,
                headers: {'Content-Type': 'text/plain'},
            });
        }
    },
};

async function runPhp() {
    const stdoutBytes = [];

    // Instantiate the Emscripten module, overriding the default wasm
    // fetch path with the pre-compiled module bundled by wrangler.
    const mod = await PHP({
        instantiateWasm(imports, receive) {
            // Expose the wrangler-bundled trampoline module for Patch 3 in
            // apply-workerd-patches.py. No runtime compilation needed — wrangler
            // pre-compiles trampolineVP at bundle time. Synchronous
            // new WebAssembly.Instance of a bundled module is allowed in workerd.
            globalThis.__phpWasmTrampolines = new Map([['vp', trampolineVP]]);
            WebAssembly.instantiate(phpWasm, imports).then(
                instance => receive(instance, phpWasm)
            ).catch(e => console.error('[worker] instantiate error:', e));
            return {};
        },
        stdout: byte => { if (byte !== null) stdoutBytes.push(byte); },
        stderr: byte => {},
    });

    // Minimal PHP runtime setup (mirrors PhpBase initialization).
    // pib_storage_init is a no-op without Module.persist; called with
    // {async: true} because the whole binary is Asyncify-instrumented.
    await mod.ccall('pib_storage_init', 'number', [], [], {async: true});

    if (!mod.FS.analyzePath('/preload').exists) {
        mod.FS.mkdir('/preload');
    }
    mod.FS.writeFile('/php.ini', '\n', {encoding: 'utf8'});

    await mod.ccall('pib_init', 'number', ['string'], ['embed'], {async: true});

    // Ordering marker: this log fires before pib_run is entered.
    console.log('[worker] before: calling pib_run');

    // {async: true} makes ccall return a Promise that Emscripten resolves
    // after the full Asyncify suspend/resume cycle — identical to the
    // Session 3 Node V8 proof. Control returns to the event loop between
    // 'promise registered' and 'timer fired' in fp_async_call.
    await mod.ccall(
        'pib_run',
        'number',
        ['string'],
        ['?>' + PHP_CODE],
        {async: true}
    );

    // Ordering marker: this log fires only after fp_async_call has
    // resolved and pib_run has returned — proving resume happened.
    console.log('[worker] after: pib_run complete');

    const output = new TextDecoder().decode(new Uint8Array(stdoutBytes));
    return new Response(output, {
        headers: {'Content-Type': 'text/plain; charset=utf-8'},
    });
}
