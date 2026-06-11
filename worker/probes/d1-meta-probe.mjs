/**
 * Session 11.5 — D1 meta verification probe (pre-pdo_d1).
 * Plain JS, no PHP. Measures D1's meta (last_row_id, changes, ...) per
 * statement, because the pdo_d1 driver will implement lastInsertId() and
 * rowCount()/exec() from these fields and the docs describe `changes` in
 * sqlite3_total_changes() (cumulative) terms — a design-critical ambiguity.
 * Run: wrangler dev --local -c wrangler.smoke.toml (main = this file).
 * Apache-2.0.
 */
export default {
    async fetch(_req, env) {
        const log = [];
        const note = (label, result) => log.push({
            label,
            via: result.__via,
            meta: result.meta ?? null,
            results_len: Array.isArray(result.results) ? result.results.length : null,
            success: result.success ?? null,
        });
        const run = async (label, sql, params = []) => {
            const r = await env.DB.prepare(sql).bind(...params).run();
            r.__via = 'run';
            note(label, r);
            return r;
        };
        const all = async (label, sql, params = []) => {
            const r = await env.DB.prepare(sql).bind(...params).all();
            r.__via = 'all';
            note(label, r);
            return r;
        };

        await env.DB.prepare('DROP TABLE IF EXISTS probe').run();

        await run('1 CREATE TABLE', 'CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)');
        await run('2 INSERT A', "INSERT INTO probe (v) VALUES ('A')");
        await run('3 INSERT B', "INSERT INTO probe (v) VALUES ('B')");
        await run('4 UPDATE both (matches 2)', "UPDATE probe SET v = v || '!'");
        await run('5 UPDATE matching 0', "UPDATE probe SET v='x' WHERE id = 999");
        await run('6 UPDATE one RETURNING *', "UPDATE probe SET v='r' WHERE id = 1 RETURNING *");
        await run('7 DELETE one', 'DELETE FROM probe WHERE id = 2');
        await run('8a SELECT * via run()', 'SELECT * FROM probe');
        await all('8b SELECT * via all()', 'SELECT * FROM probe');
        await all('8c SELECT with IN', 'SELECT * FROM probe WHERE id IN (1,2,3)');
        await run('9 INSERT C', "INSERT INTO probe (v) VALUES ('C')");

        // 10. batch of two INSERTs — meta per batch entry
        const batch = await env.DB.batch([
            env.DB.prepare("INSERT INTO probe (v) VALUES ('D')"),
            env.DB.prepare("INSERT INTO probe (v) VALUES ('E')"),
        ]);
        batch.forEach((r, i) => log.push({
            label: `10 batch[${i}] INSERT`, via: 'batch',
            meta: r.meta ?? null,
            results_len: Array.isArray(r.results) ? r.results.length : null,
            success: r.success ?? null,
        }));

        // one statement both ways: INSERT via all()
        await all('11 INSERT F via all()', "INSERT INTO probe (v) VALUES ('F')");

        return new Response(JSON.stringify(log, null, 2), {
            headers: { 'Content-Type': 'application/json' },
        });
    },
};
