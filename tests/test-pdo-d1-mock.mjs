// Session 12 gate 2: pdo_d1 unit test against a mock Module.d1 (no workerd).
// The mock implements prepare/bind/all with canned results+meta, including a
// rejecting statement for error-propagation testing. Apache-2.0.
import { PhpNode } from './packages/php-wasm/PhpNode.mjs';

const VERSION = process.env.PHP_VERSION ?? '8.4';

function makeMockD1() {
    const calls = [];
    const stmt = (sql) => {
        let params = [];
        const s = {
            bind: (...p) => { params = p; return s; },
            all: async () => {
                calls.push({ sql, params });
                if (/FAILME/.test(sql)) throw new Error('D1_ERROR: no such table: failme');
                if (/^\s*SELECT/i.test(sql)) {
                    if (/WHERE id = \?/.test(sql)) {
                        return { success: true,
                            results: [{ id: params[0], v: 'row' + params[0] }],
                            meta: { changes: 0, last_row_id: 7 } };
                    }
                    return { success: true,
                        results: [{ id: 1, v: 'one' }, { id: 2, v: 'two' }, { id: 3, v: 'three' }],
                        meta: { changes: 0, last_row_id: 7 } };
                }
                if (/^\s*INSERT/i.test(sql)) {
                    return { success: true, results: [], meta: { changes: 1, last_row_id: 42 } };
                }
                if (/^\s*UPDATE/i.test(sql)) {
                    return { success: true, results: [], meta: { changes: 3, last_row_id: 42 } };
                }
                // DDL etc.
                return { success: true, results: [], meta: { changes: 0, last_row_id: 42 } };
            },
        };
        return s;
    };
    return { db: { prepare: stmt }, calls };
}

const PHP = `<?php
$pdo = new PDO('d1:main');
echo "connected\\n";

// prepare/bind positional/execute/fetch
$s = $pdo->prepare('SELECT id, v FROM t WHERE id = ?');
$s->execute([2]);
$row = $s->fetch(PDO::FETCH_ASSOC);
echo "fetch: " . json_encode($row) . "\\n";

// typed bind: PDO::PARAM_INT passes a native int through JSON
$si = $pdo->prepare('SELECT id, v FROM t WHERE id = ?');
$si->bindValue(1, 5, PDO::PARAM_INT);
$si->execute();
echo "fetchInt: " . json_encode($si->fetch(PDO::FETCH_ASSOC)) . "\\n";

// fetchAll + rowCount on SELECT
$s2 = $pdo->query('SELECT id, v FROM t');
$all = $s2->fetchAll(PDO::FETCH_ASSOC);
echo "fetchAll: " . count($all) . " rows, rowCount=" . $s2->rowCount() . "\\n";

// fetchObject + fetchColumn
$s3 = $pdo->query('SELECT id, v FROM t');
$o = $s3->fetchObject();
echo "fetchObject: " . $o->v . "\\n";
$s4 = $pdo->query('SELECT id, v FROM t');
echo "fetchColumn: " . $s4->fetchColumn(1) . "\\n";

// INSERT -> lastInsertId
$pdo->prepare('INSERT INTO t (v) VALUES (?)')->execute(['x']);
echo "lastInsertId: " . $pdo->lastInsertId() . "\\n";

// UPDATE -> rowCount (changes)
$u = $pdo->prepare('UPDATE t SET v = ?');
$u->execute(['y']);
echo "update rowCount: " . $u->rowCount() . "\\n";

// exec() DDL — real, returns changes
$n = $pdo->exec('CREATE TABLE x (id INTEGER PRIMARY KEY)');
echo "exec returned: " . var_export($n, true) . "\\n";

// quote()
echo "quote: " . $pdo->quote("it's") . "\\n";

// named params via PDO core rewriter (POSITIONAL declaration)
$np = $pdo->prepare('SELECT id, v FROM t WHERE id = :id');
$np->execute([':id' => 2]);
echo "named-rewrite: " . json_encode($np->fetch(PDO::FETCH_ASSOC)) . "\\n";

// error propagation
try {
    $pdo->query('SELECT * FROM FAILME');
    echo "ERROR: no exception\\n";
} catch (PDOException $e) {
    echo "PDOException: " . (strpos($e->getMessage(), 'D1_ERROR') !== false ? 'has D1 message' : $e->getMessage()) . "\\n";
}

// transactions throw honestly
try {
    $pdo->beginTransaction();
    echo "ERROR: beginTransaction did not throw\\n";
} catch (PDOException $e) {
    echo "txn: throws as designed\\n";
}

// bad DSN name
try {
    new PDO('d1:nope');
    echo "ERROR: bad dsn no exception\\n";
} catch (PDOException $e) {
    echo "badDsn: throws\\n";
}
echo "done\\n";
`;

const php = new PhpNode({ version: VERSION });
let out = '';
php.addEventListener('output', e => e.detail.forEach(l => { out += l; }));
php.addEventListener('error', e => e.detail.forEach(l => { out += l; }));
const mod = await php.binary;
const mock = makeMockD1();
mod.d1 = { main: mock.db };
await php.run(PHP);
console.log(out);

const expected = [
    'connected',
    'fetch: {"id":"2","v":"row2"}',  // execute([]) binds as PDO_PARAM_STR — standard PDO
    'fetchInt: {"id":5,"v":"row5"}',
    'fetchAll: 3 rows, rowCount=3',
    'fetchObject: one',
    'fetchColumn: one',
    'lastInsertId: 42',
    'update rowCount: 3',
    'exec returned: 0',
    "quote: 'it''s'",
    'named-rewrite: {"id":"2","v":"row2"}',
    'PDOException: has D1 message',
    'txn: throws as designed',
    'badDsn: throws',
    'done',
];
const lines = out.trim().split('\n');
const pass = expected.every(e => lines.includes(e));
console.log('RESULT:', pass ? 'PASS' : 'FAIL');
if (!pass) console.log('missing:', expected.filter(e => !lines.includes(e)));
process.exit(pass ? 0 : 1);
