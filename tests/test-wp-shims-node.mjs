// Session 15: Node-side wp-shims test. Exercises (a) the PRODUCTION-D1
// transaction degradation path (mock d1 REJECTS BEGIN, like real D1;
// miniflare accepts it so workerd can't cover this), and (b) the fetch
// action contract via a mocked hostAsyncCall. GPL-side files seeded into
// MEMFS from the repo. Apache-2.0 (test scaffold).
import { PhpNode } from './packages/php-wasm/PhpNode.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = process.env.PHP_VERSION ?? '8.4';
const SHIMS = process.env.WP_SHIMS_DIR ?? '/home/sikam/php-wasm-async/wp-shims';

const php = new PhpNode({ version: VERSION });
let out = '';
php.addEventListener('output', e => e.detail.forEach(l => { out += l; }));
php.addEventListener('error', e => e.detail.forEach(l => { out += l; }));
const mod = await php.binary;

// Mock D1 that behaves like PRODUCTION (rejects explicit transactions).
const tables = { rows: [], nextId: 1 };
mod.d1 = { main: { prepare: (sql) => {
    let params = [];
    const s = {
        bind: (...p) => { params = p; return s; },
        all: async () => {
            if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(sql)) {
                throw new Error('D1_ERROR: not authorized: explicit transactions are not supported');
            }
            if (/^\s*SELECT 1/i.test(sql)) return { success: true, results: [{ one: 1 }], meta: { changes: 0, last_row_id: 0 } };
            if (/^\s*INSERT INTO/i.test(sql)) return { success: true, results: [], meta: { changes: 1, last_row_id: tables.nextId++ } };
            // everything else (incl. CREATE TABLE, PRAGMA, data-types cache)
            return { success: true, results: [], meta: { changes: 0, last_row_id: tables.nextId - 1 } };
        },
    };
    return s;
} } };

// Mock the fetch action contract.
mod.hostAsyncCall = async (payload) => {
    const req = JSON.parse(payload);
    if (req.action === 'fetch') {
        if (!req.url.startsWith('https://example.com/')) {
            return JSON.stringify({ ok: false, error: 'fetch blocked by allowlist (harness policy): ' + req.url });
        }
        return JSON.stringify({ ok: true, status: 200, statusText: 'OK',
            headers: { 'content-type': 'text/html', 'x-mock': '1' }, body: '<html>mock</html>' });
    }
    return JSON.stringify({ error: 'unknown action' });
};

// Seed shim files into MEMFS.
const files = [
    'db.php',
    'sqlite/php-polyfills.php', 'sqlite/class-wp-sqlite-token.php', 'sqlite/class-wp-sqlite-lexer.php',
    'sqlite/class-wp-sqlite-query-rewriter.php', 'sqlite/class-wp-sqlite-pdo-user-defined-functions.php',
    'sqlite/class-wp-sqlite-translator.php',
    'requests-transport/Transport.php', 'requests-transport/class-fp-async-transport.php',
];
for (const dir of ['/wp-shims', '/wp-shims/sqlite', '/wp-shims/requests-transport']) {
    if (!mod.FS.analyzePath(dir).exists) mod.FS.mkdir(dir);
}
for (const f of files) {
    mod.FS.writeFile('/wp-shims/' + f, readFileSync(join(SHIMS, f), 'utf8'), { encoding: 'utf8' });
}

const PHP = `<?php
require '/wp-shims/db.php';
require '/wp-shims/requests-transport/class-fp-async-transport.php';
$t = wp_shims_d1_translator();
// production-D1 behavior: BEGIN rejected -> degradation, no fatal
$r = $t->query('START TRANSACTION');
$t->query('INSERT INTO t (v) VALUES (1)');
$c = $t->query('COMMIT');
echo "txn-degraded: " . var_export($r, true) . "/" . var_export($c, true) . "\\n";
// fetch contract via transport
$x = new FP_Async_Transport();
$raw = $x->request('https://example.com/');
echo "fetch: " . strtok($raw, "\\r\\n") . "\\n";
try { $x->request('https://nope.invalid/'); } catch (Exception $e) { echo "blocked: ok\\n"; }
echo "done\\n";
`;
await php.run(PHP);
console.log(out);
const ok = out.includes('txn-degraded: true/true')
    && out.includes('transactions unavailable on this database')
    && out.includes('fetch: HTTP/1.1 200 OK')
    && out.includes('blocked: ok')
    && out.includes('done')
    ;  // (error_log notice goes to the PHP error log stream, not stdout)
console.log('RESULT:', ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
