<?php
/**
 * Requests 2.x transport backed by the php-wasm-async generic primitive.
 *
 * WordPress ships exactly two transports — cURL and fsockopen — and neither
 * exists in the workerd runtime (RESEARCH-networking §2). This transport
 * routes HTTP through fp_async_call() with a {action:"fetch", ...} JSON
 * payload (the ADR-0017 consumer-owned-encoding convention); the Worker-side
 * handler performs the actual fetch() (with an egress allowlist — see
 * ADR-0025 security caveat).
 *
 * GPL-2.0-or-later (wp-shims/LICENSE). Implements the WpOrg\Requests
 * Transport interface (Requests library, ISC license — vendored interface in
 * this directory, attributed in wp-shims/README.md).
 */

if ( ! interface_exists( 'WpOrg\\Requests\\Transport' ) ) {
	require_once __DIR__ . '/Transport.php';
}

class FP_Async_Transport implements WpOrg\Requests\Transport {

	/**
	 * Perform a request. Returns a raw HTTP response string
	 * (status line + headers + body) per the Transport contract.
	 */
	public function request( $url, $headers = array(), $data = array(), $options = array() ) {
		$method = isset( $options['type'] ) ? strtoupper( $options['type'] ) : 'GET';

		$body = '';
		if ( is_string( $data ) && '' !== $data ) {
			$body = $data;
		} elseif ( is_array( $data ) && ! empty( $data ) ) {
			if ( 'GET' === $method || 'HEAD' === $method ) {
				$url .= ( strpos( $url, '?' ) === false ? '?' : '&' ) . http_build_query( $data );
			} else {
				$body = http_build_query( $data );
			}
		}

		$payload = json_encode(
			array(
				'action'  => 'fetch',
				'url'     => $url,
				'method'  => $method,
				'headers' => (object) $headers,
				'body'    => $body,
				'timeout' => isset( $options['timeout'] ) ? (float) $options['timeout'] : 10.0,
			)
		);

		$raw = fp_async_call( $payload );
		$res = json_decode( $raw, true );

		if ( ! is_array( $res ) || empty( $res['ok'] ) ) {
			$msg = is_array( $res ) && isset( $res['error'] ) ? $res['error'] : 'malformed fetch response';
			throw new Exception( 'FP_Async_Transport: ' . $msg );
		}

		$status_text = isset( $res['statusText'] ) && '' !== $res['statusText'] ? $res['statusText'] : 'OK';
		$out         = 'HTTP/1.1 ' . (int) $res['status'] . ' ' . $status_text . "\r\n";
		if ( isset( $res['headers'] ) && is_array( $res['headers'] ) ) {
			foreach ( $res['headers'] as $name => $value ) {
				$out .= $name . ': ' . $value . "\r\n";
			}
		}
		$out .= "\r\n" . ( isset( $res['body'] ) ? $res['body'] : '' );

		return $out;
	}

	/**
	 * Sequential fallback for multiple requests (no parallelism in one
	 * PHP execution; each call suspends/resumes independently).
	 */
	public function request_multiple( $requests, $options ) {
		$responses = array();
		foreach ( $requests as $id => $request ) {
			try {
				$responses[ $id ] = $this->request(
					$request['url'],
					isset( $request['headers'] ) ? $request['headers'] : array(),
					isset( $request['data'] ) ? $request['data'] : array(),
					isset( $request['options'] ) ? $request['options'] : array()
				);
			} catch ( Exception $e ) {
				$responses[ $id ] = $e;
			}
		}
		return $responses;
	}

	/**
	 * The transport is usable when the runtime primitive exists.
	 * (SSL capability is the Worker's concern — fetch() is always HTTPS-capable.)
	 */
	public static function test( $capabilities = array() ) {
		return function_exists( 'fp_async_call' );
	}
}
