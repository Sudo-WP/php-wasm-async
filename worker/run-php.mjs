/**
 * php-wasm-async — shared single-version Worker core (Session 14, ADR-0024).
 *
 * Each per-version entry (php84.mjs / php82.mjs) imports exactly ONE PHP
 * binary + glue and passes them here. Version selection is a deploy-time
 * property (wrangler environments); the per-request X-PHP-Version selection
 * of ADR-0018 is retired for production-shaped builds — the Session 13
 * extension floor pushed the two-binary bundle past the 10 MiB gz limit
 * (see ADR-0024). The X-PHP-Version-Served response header is kept so each
 * Worker stays externally verifiable.
 *
 * The PHP demo: D1 via pdo_d1 + fp_async_call interleave + the WordPress
 * extension-floor sanity line + guarded functional probes (Session 13).
 *
 * Apache-2.0. Our own code; no GPL or LGPL content.
 */

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

export function createHandler({ factory, wasm, trampolineVP, version }) {
    return {
        async fetch(_request, env, _ctx) {
            try {
                return await runPhp(env, { factory, wasm, trampolineVP, version });
            } catch (e) {
                console.error('[worker] error:', e);
                return new Response('Error: ' + String(e) + '\n' + (e?.stack || ''), {
                    status: 500,
                    headers: { 'Content-Type': 'text/plain' },
                });
            }
        },
    };
}

async function runPhp(env, { factory, wasm, trampolineVP, version }) {
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

    // fp_async_call generic host-async handler (ADR-0016/0017) — store-agnostic.
    mod.hostAsyncCall = async (payload) => {
        const req = JSON.parse(payload);
        if (req.action === 'query') {
            const row = await env.DB.prepare(req.sql).bind(...(req.params ?? [])).first();
            return JSON.stringify(row ?? null);
        }
        return JSON.stringify({ error: 'unknown action: ' + req.action });
    };

    // pdo_d1 D1 bindings (ADR-0022) — the DB hot path's own surface.
    mod.d1 = { main: env.DB };

    await mod.ccall('pib_storage_init', 'number', [], [], { async: true });

    if (!mod.FS.analyzePath('/preload').exists) {
        mod.FS.mkdir('/preload');
    }
    mod.FS.writeFile('/php.ini', '\n', { encoding: 'utf8' });

    await mod.ccall('pib_init', 'number', ['string'], ['embed'], { async: true });

    await mod.ccall('pib_run', 'number', ['string'], ['?>' + PHP_CODE], { async: true });

    const output = new TextDecoder().decode(new Uint8Array(stdoutBytes));
    return new Response(output, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-PHP-Version-Served': version,
        },
    });
}
