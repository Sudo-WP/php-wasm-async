<?php
/**
 * Minimal wpdb-shaped facade over WP_SQLite_Translator for the Session 15
 * micro-harness. NOT a wpdb replacement — just the surface the harness
 * checks need ($wpdb->insert/update/get_results/query, insert_id,
 * rows_affected, last_error). GPL-2.0-or-later (wp-shims/LICENSE).
 */
class Harness_WPDB {
	public $insert_id     = 0;
	public $rows_affected = 0;
	public $last_error    = '';

	/** @var WP_SQLite_Translator */
	private $t;

	public function __construct( $translator ) {
		$this->t = $translator;
	}

	/** Run a MySQL-dialect statement through the translation layer. */
	public function query( $sql ) {
		$this->last_error = '';
		$result           = $this->t->query( $sql );
		$err              = $this->t->get_error_message();
		if ( false === $result && '' !== trim( (string) $err ) ) {
			$this->last_error = trim( $err );
			return false;
		}
		$this->insert_id     = (int) $this->t->get_insert_id();
		$this->rows_affected = (int) $this->t->get_affected_rows();
		return $result;
	}

	public function get_results( $sql ) {
		$r = $this->query( $sql );
		return is_array( $r ) ? $r : array();
	}

	public function insert( $table, $data ) {
		$cols = array();
		$vals = array();
		foreach ( $data as $col => $val ) {
			$cols[] = '`' . $col . '`';
			$vals[] = $this->quote_value( $val );
		}
		return $this->query(
			'INSERT INTO `' . $table . '` (' . implode( ', ', $cols ) . ') VALUES (' . implode( ', ', $vals ) . ')'
		);
	}

	public function update( $table, $data, $where ) {
		$set = array();
		foreach ( $data as $col => $val ) {
			$set[] = '`' . $col . '` = ' . $this->quote_value( $val );
		}
		$cond = array();
		foreach ( $where as $col => $val ) {
			$cond[] = '`' . $col . '` = ' . $this->quote_value( $val );
		}
		return $this->query(
			'UPDATE `' . $table . '` SET ' . implode( ', ', $set ) . ' WHERE ' . implode( ' AND ', $cond )
		);
	}

	private function quote_value( $val ) {
		if ( null === $val ) {
			return 'NULL';
		}
		if ( is_int( $val ) || is_float( $val ) ) {
			return (string) $val;
		}
		return "'" . str_replace( "'", "''", (string) $val ) . "'";
	}
}
