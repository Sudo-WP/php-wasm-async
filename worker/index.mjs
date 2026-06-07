/**
 * php-wasm-async Session 4: suspend/resume PoC for Cloudflare Workers / workerd.
 *
 * Imports the Emscripten worker-env glue and the pre-compiled wasm module.
 * Wrangler bundles the .mjs glue and compiles the .wasm at bundle time —
 * the instantiateWasm hook hands the pre-compiled module to Emscripten,
 * bypassing the default fetch-based loading path.
 *
 * Status: BLOCKED — see docs/RESULTS.md Session 4 and DECISIONS.md ADR-0012.
 * The instantiateWasm hook works (wasm instantiates), but php_embed_init
 * fails because workerd blocks runtime WebAssembly.Module() compilation,
 * which is required by Emscripten's dynamic-linking stub mechanism
 * (addFunction → convertJsFunctionToWasm → new WebAssembly.Module(bytes)).
 * The libxml2 undefined-symbol stubs are needed by ext/libxml MINIT →
 * xmlInitParser(), called before any PHP code runs.
 * See ADR-0012 for the analysis and ADR-0013 for the JSPI path forward.
 *
 * Apache-2.0. Our own code; no GPL or LGPL content.
 */

import PHP from './build/php8.0-worker.mjs';
import phpWasm from './build/php8.0-worker.mjs.wasm';

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
