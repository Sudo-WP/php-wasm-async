/**
 * php-wasm-async Session 7: D1 SQL query from PHP mid-request.
 *
 * PHP calls fp_async_call with a JSON payload encoding a SQL action; the Worker
 * handler parses it, runs env.DB.prepare(...).bind(...).first(), and returns the
 * row as a JSON string. PHP resumes with the JSON result and can decode it with
 * json_decode(). The primitive (fp_async_call / pib.c / library_fp_async.js)
 * is unchanged from Session 6 — only the Worker-side handler changes.
 *
 * JSON payload convention (consumer-owned, not baked into fp_async_call):
 *   PHP sends:    '{"action":"query","sql":"SELECT...","params":[...]}'
 *   Handler returns: '{"value":"hello from D1"}' (the first matching row as JSON)
 *   See docs/DECISIONS.md ADR-0017.
 *
 * Stretch goal: two sequential fp_async_call invocations prove that Asyncify
 * stack unwind/rewind is stateless across calls (critical for WordPress DB usage).
 *
 * Trampoline fix (Session 5): six Emscripten GOT.func symbols (emscripten_console_*)
 * all use sig 'vp'; the pre-compiled trampoline-vp.wasm is bundled by wrangler
 * and loaded via globalThis.__phpWasmTrampolines before PHP instantiation.
 * apply-workerd-patches.py Patch 3 makes convertJsFunctionToWasm use the cache.
 *
 * Status: see docs/RESULTS.md Session 7.
 * Apache-2.0. Our own code; no GPL or LGPL content.
 */

import PHP from './build/php8.0-worker.mjs';
import phpWasm from './build/php8.0-worker.mjs.wasm';
import trampolineVP from './build/trampoline-vp.wasm';

// Session 7 PHP script: two sequential fp_async_call invocations via D1.
// Each call suspends on a real async D1 query and resumes with the row JSON.
// The JSON convention is the consumer's encoding — fp_async_call is opaque to it.
const PHP_CODE = `<?php
echo "before:\n";
$r1 = fp_async_call('{"action":"query","sql":"SELECT value FROM config WHERE key=?","params":["greeting"]}');
$r2 = fp_async_call('{"action":"query","sql":"SELECT value FROM config WHERE key=?","params":["farewell"]}');
echo "after: " . $r1 . " / " . $r2 . "\n";
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

    // D1 handler (Session 7 — active). Parses the JSON payload from PHP,
    // dispatches on the action field, and returns the result as a JSON string.
    // No D1-specific code in fp_async_call or pib.c — the primitive is store-agnostic.
    mod.hostAsyncCall = async (payload) => {
        const req = JSON.parse(payload);
        if (req.action === 'query') {
            const row = await env.DB.prepare(req.sql).bind(...(req.params ?? [])).first();
            return JSON.stringify(row ?? null);
        }
        return JSON.stringify({ error: 'unknown action: ' + req.action });
    };

    // Session 6 KV handler (kept for reference — not active):
    // mod.hostAsyncCall = async (key) => (await env.KV.get(key)) ?? '';

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
