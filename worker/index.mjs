/**
 * php-wasm-async Session 6: real async host call — Cloudflare KV read.
 *
 * PHP calls fp_async_call("greeting"), which suspends on env.KV.get("greeting")
 * and resumes with the stored value. The Worker registers the KV handler per
 * request via mod.hostAsyncCall; fp_async_call itself stays store-agnostic.
 *
 * fp_async_call is now string→string (changed from int→int in Session 5).
 * Payload is the string key; return is the string value from the handler.
 *
 * Trampoline fix (Session 5): six Emscripten GOT.func symbols (emscripten_console_*)
 * all use sig 'vp'; the pre-compiled trampoline-vp.wasm is bundled by wrangler
 * and loaded via globalThis.__phpWasmTrampolines before PHP instantiation.
 * apply-workerd-patches.py Patch 3 makes convertJsFunctionToWasm use the cache.
 *
 * Status: see docs/RESULTS.md Session 6.
 * Apache-2.0. Our own code; no GPL or LGPL content.
 */

import PHP from './build/php8.0-worker.mjs';
import phpWasm from './build/php8.0-worker.mjs.wasm';
// Pre-compiled wasm trampoline for sig 'vp' (void, i32). Wrangler compiles at
// bundle time; used by apply-workerd-patches.py Patch 3 to satisfy MAIN_MODULE
// GOT.func entries without runtime wasm compilation (blocked in workerd).
import trampolineVP from './build/trampoline-vp.wasm';

// Session 6 PHP script: fp_async_call with a string key → real KV read.
const PHP_CODE = `<?php
echo "before:\n";
$v = fp_async_call("greeting");
echo "after: " . $v . "\n";
`;

export default {
    async fetch(_request, env, _ctx) {
        try {
            return await runPhp(env);
        } catch (e) {
            console.error('[worker] error:', e);
            return new Response('Error: ' + String(e) + '\n' + (e?.stack || ''), {
                status: 500,
                headers: {'Content-Type': 'text/plain'},
            });
        }
    },
};

async function runPhp(env) {
    const stdoutBytes = [];

    const mod = await PHP({
        instantiateWasm(imports, receive) {
            globalThis.__phpWasmTrampolines = new Map([['vp', trampolineVP]]);
            WebAssembly.instantiate(phpWasm, imports).then(
                instance => receive(instance, phpWasm)
            ).catch(e => console.error('[worker] instantiate error:', e));
            return {};
        },
        stdout: byte => { if (byte !== null) stdoutBytes.push(byte); },
        stderr: byte => {},
    });

    // Register the KV-backed handler before running PHP.
    // fp_async_call will delegate to this function, passing the key string
    // and receiving the KV value string. No KV-specific code in fp_async_call
    // or pib.c — the primitive stays store-agnostic (ADR-0016).
    mod.hostAsyncCall = async (key) => (await env.KV.get(key)) ?? '';

    await mod.ccall('pib_storage_init', 'number', [], [], {async: true});

    if (!mod.FS.analyzePath('/preload').exists) {
        mod.FS.mkdir('/preload');
    }
    mod.FS.writeFile('/php.ini', '\n', {encoding: 'utf8'});

    await mod.ccall('pib_init', 'number', ['string'], ['embed'], {async: true});

    console.log('[worker] before: calling pib_run');

    await mod.ccall(
        'pib_run',
        'number',
        ['string'],
        ['?>' + PHP_CODE],
        {async: true}
    );

    console.log('[worker] after: pib_run complete');

    const output = new TextDecoder().decode(new Uint8Array(stdoutBytes));
    return new Response(output, {
        headers: {'Content-Type': 'text/plain; charset=utf-8'},
    });
}
