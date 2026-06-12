<?php
/**
 * Session 15 micro-harness: validates the wp-shims against the live runtime
 * (pdo_d1 → miniflare D1; fp_async_call → Worker fetch). Seeded into MEMFS
 * by the Worker; NOT a WordPress boot (filesystem strategy = Session 16).
 * GPL-2.0-or-later (wp-shims/LICENSE).
 */

error_reporting( E_ALL & ~E_DEPRECATED );

require_once '/wp-shims/db.php';
require_once '/wp-shims/harness/class-harness-wpdb.php';
require_once '/wp-shims/requests-transport/class-fp-async-transport.php';

$pass = 0;
$fail = 0;
function check( $n, $ok, $detail ) {
	global $pass, $fail;
	$ok ? $pass++ : $fail++;
	echo 'CHECK ' . $n . ' ' . ( $ok ? 'PASS' : 'FAIL' ) . ': ' . $detail . "\n";
}

$wpdb = new Harness_WPDB( wp_shims_d1_translator() );

// Fresh table each run.
$wpdb->query( 'DROP TABLE IF EXISTS harness_items' );

// 1. MySQL-dialect DDL through the translator (AUTO_INCREMENT + KEY index).
$r1 = $wpdb->query(
	'CREATE TABLE `harness_items` (
		`id` BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
		`name` VARCHAR(190) NOT NULL,
		`qty` INT(11) NOT NULL DEFAULT 0,
		PRIMARY KEY (`id`),
		KEY `name_idx` (`name`)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
);
check( 1, false !== $r1 && '' === $wpdb->last_error, 'translated CREATE TABLE (AUTO_INCREMENT + KEY): ' . ( $wpdb->last_error ?: 'ok' ) );

// 2. insert() → insert_id 1 then 2.
$wpdb->insert( 'harness_items', array( 'name' => 'alpha', 'qty' => 1 ) );
$id1 = $wpdb->insert_id;
$wpdb->insert( 'harness_items', array( 'name' => 'beta', 'qty' => 2 ) );
$id2 = $wpdb->insert_id;
check( 2, 1 === $id1 && 2 === $id2, "insert_id sequence: $id1, $id2 (want 1, 2)" );

// 3. update() → rows_affected.
$wpdb->update( 'harness_items', array( 'qty' => 9 ), array( 'name' => 'alpha' ) );
$ra = $wpdb->rows_affected;
check( 3, 1 === $ra, "rows_affected after UPDATE: $ra (want 1)" );

// 4. get_results → typed rows.
$rows = $wpdb->get_results( 'SELECT id, name, qty FROM harness_items ORDER BY id' );
$ok4  = 2 === count( $rows ) && 'alpha' === $rows[0]->name && '9' == $rows[0]->qty;
check( 4, $ok4, 'get_results: ' . json_encode( $rows ) );

// 5. MySQL-flavored statement (SHOW TABLES → sqlite_master translation).
$tables = $wpdb->get_results( "SHOW TABLES LIKE 'harness%'" );
$ok5    = 1 === count( $tables ) && in_array( 'harness_items', array_map( 'current', array_map( 'get_object_vars', $tables ) ), true );
check( 5, $ok5, 'SHOW TABLES LIKE: ' . json_encode( $tables ) );

// 6. Failing query → last_error populated, no fatal.
$r6 = $wpdb->query( 'SELECT nope FROM table_that_does_not_exist' );
check( 6, false === $r6 && '' !== $wpdb->last_error, 'last_error: ' . substr( $wpdb->last_error, 0, 80 ) );

// 7. Transaction attempt → graceful path (works, or degrades without fatal).
$r7a = $wpdb->query( 'START TRANSACTION' );
$wpdb->insert( 'harness_items', array( 'name' => 'gamma', 'qty' => 3 ) );
$r7b   = $wpdb->query( 'COMMIT' );
$gamma = $wpdb->get_results( "SELECT name FROM harness_items WHERE name = 'gamma'" );
check( 7, 1 === count( $gamma ), 'transaction path survived (begin=' . var_export( $r7a, true ) . ', commit=' . var_export( $r7b, true ) . '), row present' );

// 8. HTTP GET via the Requests transport (allowlisted URL).
$transport = new FP_Async_Transport();
try {
	$raw = $transport->request( 'https://example.com/', array( 'X-Harness' => 'wp-shims' ) );
	list( $head, $body8 ) = explode( "\r\n\r\n", $raw, 2 );
	$ok8 = 0 === strpos( $head, 'HTTP/1.1 200' ) && strlen( $body8 ) > 0 && false !== stripos( $head, 'content-type:' );
	check( 8, $ok8, 'GET example.com: ' . strtok( $head, "\r\n" ) . ', body ' . strlen( $body8 ) . ' B, headers reconstructed' );
} catch ( Exception $e ) {
	check( 8, false, 'GET example.com threw: ' . $e->getMessage() );
}

// 9. Blocked (non-allowlisted) URL → clean error, no hang.
try {
	$transport->request( 'https://blocked.invalid/' );
	check( 9, false, 'blocked URL did not error' );
} catch ( Exception $e ) {
	check( 9, false !== stripos( $e->getMessage(), 'allowlist' ), 'blocked URL error: ' . $e->getMessage() );
}

// 10. Interleave: DB → HTTP → DB in one execution.
$before = $wpdb->get_results( 'SELECT COUNT(*) AS c FROM harness_items' );
try {
	$transport->request( 'https://example.com/' );
	$http_ok = true;
} catch ( Exception $e ) {
	$http_ok = false;
}
$wpdb->insert( 'harness_items', array( 'name' => 'delta', 'qty' => 4 ) );
$after = $wpdb->get_results( 'SELECT COUNT(*) AS c FROM harness_items' );
$ok10  = $http_ok && ( (int) $after[0]->c === (int) $before[0]->c + 1 );
check( 10, $ok10, 'DB -> HTTP -> DB interleave: count ' . $before[0]->c . ' -> ' . $after[0]->c );

echo 'php: ' . PHP_VERSION . "\n";
echo "SUMMARY: $pass PASS, $fail FAIL\n";
