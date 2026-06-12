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

// wp-shims (Session 15, ADR-0025): the GPL-side shim + harness files, bundled
// as Text modules and seeded into MEMFS when ?harness=1. Arm's-length
// interaction only — the runtime does not link this code.
import shimDb from '../wp-shims/db.php';
import shimPolyfills from '../wp-shims/sqlite/php-polyfills.php';
import shimToken from '../wp-shims/sqlite/class-wp-sqlite-token.php';
import shimLexer from '../wp-shims/sqlite/class-wp-sqlite-lexer.php';
import shimRewriter from '../wp-shims/sqlite/class-wp-sqlite-query-rewriter.php';
import shimUdfs from '../wp-shims/sqlite/class-wp-sqlite-pdo-user-defined-functions.php';
import shimTranslator from '../wp-shims/sqlite/class-wp-sqlite-translator.php';
import shimHarnessWpdb from '../wp-shims/harness/class-harness-wpdb.php';
import shimHarness from '../wp-shims/harness/harness.php';
import shimTransportIface from '../wp-shims/requests-transport/Transport.php';
import shimTransport from '../wp-shims/requests-transport/class-fp-async-transport.php';

const WP_SHIM_FILES = {
    '/wp-shims/db.php': shimDb,
    '/wp-shims/sqlite/php-polyfills.php': shimPolyfills,
    '/wp-shims/sqlite/class-wp-sqlite-token.php': shimToken,
    '/wp-shims/sqlite/class-wp-sqlite-lexer.php': shimLexer,
    '/wp-shims/sqlite/class-wp-sqlite-query-rewriter.php': shimRewriter,
    '/wp-shims/sqlite/class-wp-sqlite-pdo-user-defined-functions.php': shimUdfs,
    '/wp-shims/sqlite/class-wp-sqlite-translator.php': shimTranslator,
    '/wp-shims/harness/class-harness-wpdb.php': shimHarnessWpdb,
    '/wp-shims/harness/harness.php': shimHarness,
    '/wp-shims/requests-transport/Transport.php': shimTransportIface,
    '/wp-shims/requests-transport/class-fp-async-transport.php': shimTransport,
};

const PHP_CODE_HARNESS = `<?php require '/wp-shims/harness/harness.php';`;

// fetch-action egress allowlist (harness policy). SECURITY: this is a
// Worker-side fetch on behalf of PHP — an SSRF surface. Production needs a
// real egress policy (ADR-0025 caveat; flagged, not designed here).
const FETCH_ALLOWLIST = ['https://example.com/'];

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
        async fetch(request, env, _ctx) {
            const harness = new URL(request.url).searchParams.has('harness');
            try {
                return await runPhp(env, { factory, wasm, trampolineVP, version, harness });
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

async function runPhp(env, { factory, wasm, trampolineVP, version, harness }) {
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
        if (req.action === 'fetch') {
            // Session 15: Worker-side fetch for the WP Requests transport.
            if (!FETCH_ALLOWLIST.some(p => req.url === p || (typeof req.url === 'string' && req.url.startsWith(p)))) {
                return JSON.stringify({ ok: false, error: 'fetch blocked by allowlist (harness policy): ' + req.url });
            }
            try {
                const method = (req.method || 'GET').toUpperCase();
                const r = await fetch(req.url, {
                    method,
                    headers: req.headers || {},
                    body: (method === 'GET' || method === 'HEAD') ? undefined : (req.body || undefined),
                });
                const body = await r.text();
                const headers = {};
                r.headers.forEach((v, k) => { headers[k] = v; });
                return JSON.stringify({ ok: true, status: r.status, statusText: r.statusText, headers, body });
            } catch (e) {
                return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
            }
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

    if (harness) {
        // Seed the wp-shims + harness into MEMFS (Session 15; the smallest
        // mechanism that works — NOT the Session 16 filesystem strategy).
        for (const dir of ['/wp-shims', '/wp-shims/sqlite', '/wp-shims/harness', '/wp-shims/requests-transport']) {
            if (!mod.FS.analyzePath(dir).exists) mod.FS.mkdir(dir);
        }
        for (const [path, text] of Object.entries(WP_SHIM_FILES)) {
            mod.FS.writeFile(path, text, { encoding: 'utf8' });
        }
    }

    await mod.ccall('pib_run', 'number', ['string'],
        ['?>' + (harness ? PHP_CODE_HARNESS : PHP_CODE)], { async: true });

    const output = new TextDecoder().decode(new Uint8Array(stdoutBytes));
    return new Response(output, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-PHP-Version-Served': version,
        },
    });
}
