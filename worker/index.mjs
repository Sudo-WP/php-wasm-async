/**
 * php-wasm-async Session 8: multi-version Worker — PHP 8.2 + 8.4 from one deployment.
 *
 * Both PHP versions are imported statically: wrangler bundles and AOT-compiles
 * every .wasm import at deploy time (the same property the trampoline fix relies
 * on — workerd blocks all runtime wasm compilation, see ADR-0015), and the glue
 * .mjs modules are plain ESM imports resolved at bundle time. Version selection
 * happens per request by choosing which already-imported module factory + wasm
 * module to instantiate — never by dynamic import. See ADR-0018.
 *
 * Selection: X-PHP-Version request header ('8.2' or '8.4'); default 8.4.
 *
 * The PHP payload demo is unchanged from Session 7: two sequential D1 queries
 * via fp_async_call (JSON payload convention, ADR-0017). The async primitive
 * (fp_async_call / pib.c / library_fp_async.js) is version-agnostic.
 *
 * Status: see docs/RESULTS.md Session 8.
 * Apache-2.0. Our own code; no GPL or LGPL content.
 */

import PHP82 from './build/php8.2-worker.mjs';
import php82Wasm from './build/php8.2-worker.mjs.wasm';
import PHP84 from './build/php8.4-worker.mjs';
import php84Wasm from './build/php8.4-worker.mjs.wasm';
import trampolineVP from './build/trampoline-vp.wasm';

const RUNTIMES = {
    '8.2': { factory: PHP82, wasm: php82Wasm },
    '8.4': { factory: PHP84, wasm: php84Wasm },
};
const DEFAULT_VERSION = '8.4';

// Session 13 canonical demo: D1 via pdo_d1, fp_async_call interleave, the
// WordPress extension-floor sanity line, and guarded functional probes
// (loaded != functional — each family proves it actually works).
const PHP_CODE = `<?php
echo "start\n";
$pdo = new PDO('d1:main');
$s = $pdo->prepare('SELECT value FROM config WHERE key = ?');
$s->execute(['greeting']);
echo "pdo: " . $s->fetchColumn() . "\n";
$kv = fp_async_call('{"action":"query","sql":"SELECT value FROM config WHERE key=?","params":["farewell"]}');
echo "fp: " . $kv . "\n";
echo "php: " . PHP_VERSION . "\n";
echo "ext: " . (extension_loaded('mbstring')?'mb ':'- ') . (extension_loaded('dom')?'dom ':'- ')
    . (extension_loaded('simplexml')?'sxml ':'- ') . (extension_loaded('xml')?'xml ':'- ')
    . (extension_loaded('xmlreader')?'xr ':'- ') . (extension_loaded('xmlwriter')?'xw ':'- ')
    . (extension_loaded('openssl')?'ssl ':'- ') . (extension_loaded('zip')?'zip ':'- ')
    . (extension_loaded('zlib')?'zlib ':'- ') . (extension_loaded('fileinfo')?'fi ':'- ')
    . (extension_loaded('gd')?'gd ':'- ') . (extension_loaded('exif')?'exif ':'- ')
    . (extension_loaded('bcmath')?'bc':'-') . "\n";
if (extension_loaded('mbstring')) echo "mb_strlen: " . mb_strlen("héllo wörld") . "\n";
if (extension_loaded('dom')) { $d = new DOMDocument(); $d->loadXML('<a><b>x</b></a>'); echo "dom: " . $d->getElementsByTagName('b')->item(0)->textContent . "\n"; }
if (extension_loaded('openssl')) echo "openssl: " . strlen(openssl_random_pseudo_bytes(8)) . " bytes\n";
if (extension_loaded('zip')) { $z = new ZipArchive(); $f = '/tmp/p.zip'; $z->open($f, ZipArchive::CREATE); $z->addFromString('t.txt', 'hi'); $z->close(); $z2 = new ZipArchive(); $z2->open($f); echo "zip: " . $z2->getFromName('t.txt') . "\n"; }
if (extension_loaded('zlib')) echo "zlib: " . gzuncompress(gzcompress('ok')) . "\n";
if (extension_loaded('fileinfo')) { $fi = new finfo(FILEINFO_MIME_TYPE); echo "finfo: " . $fi->buffer("\\x89PNG\\r\\n\\x1a\\n" . str_repeat("\\0", 16)) . "\n"; }
if (extension_loaded('gd')) { $im = imagecreatetruecolor(1, 1); echo "gd: " . (($im !== false) ? "1x1 ok" : "fail") . "\n"; }
echo "done\n";
`;

export default {
    async fetch(request, env, _ctx) {
        const requested = request.headers.get('X-PHP-Version') ?? DEFAULT_VERSION;
        // Unknown versions fall back to the default rather than erroring.
        const version = RUNTIMES[requested] ? requested : DEFAULT_VERSION;
        try {
            return await runPhp(env, version);
        } catch (e) {
            console.error('[worker] error:', e);
            return new Response('Error: ' + String(e) + '\n' + (e?.stack || ''), {
                status: 500,
                headers: {'Content-Type': 'text/plain'},
            });
        }
    },
};

async function runPhp(env, version) {
    const { factory, wasm } = RUNTIMES[version];
    console.log(`[worker] serving PHP ${version}`);
    const stdoutBytes = [];

    const mod = await factory({
        instantiateWasm(imports, receive) {
            globalThis.__phpWasmTrampolines = new Map([['vp', trampolineVP]]);
            WebAssembly.instantiate(wasm, imports).then(
                instance => receive(instance, wasm)
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

    // pdo_d1 (Session 12, ADR-0022): D1 bindings for the clean-room PDO driver.
    // PHP connects with new PDO('d1:main'). This is the driver's own surface;
    // fp_async_call/hostAsyncCall above stays the generic host-async primitive.
    mod.d1 = { main: env.DB };

    await mod.ccall('pib_storage_init', 'number', [], [], {async: true});

    if (!mod.FS.analyzePath('/preload').exists) {
        mod.FS.mkdir('/preload');
    }
    mod.FS.writeFile('/php.ini', '\n', {encoding: 'utf8'});

    await mod.ccall('pib_init', 'number', ['string'], ['embed'], {async: true});

    console.log(`[worker] before: calling pib_run (PHP ${version})`);

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
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-PHP-Version-Served': version,
        },
    });
}
