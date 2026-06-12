<?php
/**
 * mu-plugin: register the fp_async_call-backed Requests transport.
 * GPL-2.0-or-later (wp-shims/LICENSE).
 *
 * Registration mechanism (WP 6.x): the supported path is the Requests 2.x
 * library API itself — \WpOrg\Requests\Requests::add_transport(). The old
 * WP_Http 'http_api_transports' filter is deprecated (since WP 6.4) and only
 * reaches the legacy cURL/fsockopen wrappers; custom Requests transports go
 * through add_transport(). Documented in BUILD.md (Session 15).
 */

require_once __DIR__ . '/class-fp-async-transport.php';

if ( class_exists( 'WpOrg\\Requests\\Requests' ) ) {
	WpOrg\Requests\Requests::add_transport( FP_Async_Transport::class );
}
