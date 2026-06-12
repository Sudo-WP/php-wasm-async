<?php
/**
 * D1 database drop-in for WordPress (php-wasm-async wp-shims).
 *
 * License: GPL-2.0-or-later (see wp-shims/LICENSE). This file runs INSIDE
 * WordPress and is licensed separately from the Apache-2.0 runtime that
 * provides the pdo_d1 driver (ADR-0025 boundary).
 *
 * Connection layer (ours): connects PDO to Cloudflare D1 via the runtime's
 * pdo_d1 driver — new PDO('d1:<name>') — instead of a SQLite file. The
 * MySQL→SQLite translation layer is adapted from
 * WordPress/sqlite-database-integration v2.2.23
 * (commit f3ea1a43ba525be382c7a9c17735b6b4d4b11d49, GPL-2.0) — see
 * wp-shims/README.md for attribution and the D1-DIVERGENCE list.
 *
 * Transactions: D1 has none; the adapted translator degrades gracefully
 * (notice, no fatal) on the first rejected BEGIN. WordPress core runs
 * without transactions.
 */

// The vendored stack references these constants in its file-backed code
// paths. They are never used when a PDO instance is injected (our case),
// but must exist for parsing/older call sites.
if ( ! defined( 'FQDB' ) ) {
	define( 'FQDB', '/tmp/wp-shims-unused.sqlite' );
}
if ( ! defined( 'FQDBDIR' ) ) {
	define( 'FQDBDIR', '/tmp/' );
}

require_once __DIR__ . '/sqlite/php-polyfills.php';
require_once __DIR__ . '/sqlite/class-wp-sqlite-token.php';
require_once __DIR__ . '/sqlite/class-wp-sqlite-lexer.php';
require_once __DIR__ . '/sqlite/class-wp-sqlite-query-rewriter.php';
require_once __DIR__ . '/sqlite/class-wp-sqlite-pdo-user-defined-functions.php';
require_once __DIR__ . '/sqlite/class-wp-sqlite-translator.php';

/**
 * The PDO connection to D1 (via the runtime's pdo_d1 driver).
 * The database name defaults to 'main'; override with the D1_DB_NAME constant.
 */
function wp_shims_d1_pdo() {
	static $pdo = null;
	if ( null === $pdo ) {
		$name = defined( 'D1_DB_NAME' ) ? D1_DB_NAME : 'main';
		$pdo  = new PDO( 'd1:' . $name );
		// PDO defaults to ERRMODE_EXCEPTION since PHP 8.0 — the translator
		// relies on exceptions; pdo_d1 propagates real D1 error messages.
	}
	return $pdo;
}

/**
 * The shared translator instance, connected to D1.
 */
function wp_shims_d1_translator() {
	static $translator = null;
	if ( null === $translator ) {
		$translator = new WP_SQLite_Translator( wp_shims_d1_pdo() );
	}
	return $translator;
}

// Inside full WordPress (wpdb exists), install the drop-in database class.
// The vendored dual-engine WP_SQLite_DB is future work for the core-boot
// session; the harness drives the translator through its own facade.
if ( class_exists( 'wpdb' ) && function_exists( 'add_filter' ) ) {
	// Placeholder for the Session 16+ core boot: load class-wp-sqlite-db.php
	// (legacy-translator engine) once its dual-engine wiring is adapted.
	// For now the drop-in exposes the connection + translator factories only.
	error_log( 'wp-shims/db.php: full-WordPress wiring is pending the core-boot session; factories are available.' );
}
