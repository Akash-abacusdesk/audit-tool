<?php
/**
 * S8-D4 WordPress MU-plugin: signed mutation events + temporary JIT admin sessions.
 *
 * Auto-loaded by WordPress from wp-content/mu-plugins/. Emits signed, async
 * HTTPS mutation events for every privileged human action on WP so each is
 * attributable (actor, grant/session id, request id, ip) per PRD §10 / §11 and
 * wp-remote-control-boundaries.md. Also wires the JIT WP-side redemption hooks.
 *
 * Inbound direction (prod -> central) is untrusted input: every emitted event
 * is signed + replay-protected; the central ingest (S8-D1) verifies and dedups.
 *
 * Config (wp-config.php or env):
 *   S8_WP_EVENT_SECRET   shared HMAC secret (REQUIRED to emit)
 *   S8_EVENT_INGEST_URL  central ingest endpoint (REQUIRED to emit)
 *   S8_WP_SITE_ID        deployment_id / site id (REQUIRED)
 *   S8_CENTRAL_BASE_URL  central base for JIT redeem/request
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

require_once __DIR__ . '/s8-lib/s8-signing.php';
require_once __DIR__ . '/s8-lib/s8-jit.php';

if ( ! function_exists( 's8_site_id' ) ) {
	function s8_site_id(): string {
		if ( defined( 'S8_WP_SITE_ID' ) ) {
			return (string) S8_WP_SITE_ID;
		}
		$v = getenv( 'S8_WP_SITE_ID' );
		return $v === false ? '' : (string) $v;
	}
}

if ( ! function_exists( 's8_ingest_url' ) ) {
	function s8_ingest_url(): string {
		if ( defined( 'S8_EVENT_INGEST_URL' ) ) {
			return (string) S8_EVENT_INGEST_URL;
		}
		$v = getenv( 'S8_EVENT_INGEST_URL' );
		return $v === false ? '' : (string) $v;
	}
}

if ( ! function_exists( 's8_new_delivery_id' ) ) {
	function s8_new_delivery_id(): string {
		if ( function_exists( 'wp_generate_uuid4' ) ) {
			return wp_generate_uuid4();
		}
		return sprintf(
			'%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
			random_int( 0, 0xffff ), random_int( 0, 0xffff ), random_int( 0, 0xffff ),
			random_int( 0, 0x0fff ) | 0x4000, random_int( 0, 0x3fff ) | 0x8000,
			random_int( 0, 0xffff ), random_int( 0, 0xffff ), random_int( 0, 0xffff )
		);
	}
}

if ( ! function_exists( 's8_emit_event' ) ) {
	/**
	 * Build -> sign -> async-POST a mutation event. Non-blocking; fire-and-forget.
	 * Returns false if not configured or the POST could not be dispatched.
	 */
	function s8_emit_event( array $event ): bool {
		$event = array_merge( array(
			'schema_version' => 'wp-mutation-events/1.0',
			'site_id'        => s8_site_id(),
			'delivery_id'    => s8_new_delivery_id(),
			'event_type'     => 'wp.mutation.unknown',
			'occurred_at'    => gmdate( 'c' ),
			'actor'          => array( 'type' => 'system', 'id' => 's8-monitor', 'ip' => null, 'grant_id' => null ),
			'request_id'     => null,
			'details'        => new stdClass(),
		), $event );

		$secret = s8_event_secret();
		if ( $secret === '' ) {
			return false;
		}
		$url = s8_ingest_url();
		if ( $url === '' ) {
			return false;
		}
		$body = s8_canonical_body( $event );
		$sig  = s8_sign_event( $secret, $event );
		$r    = wp_remote_post( $url, array(
			'timeout'  => 5,
			'blocking' => false,
			'headers'  => array(
				'Content-Type'   => 'application/json',
				'X-WP-Signature' => 'sha256=' . $sig,
				'X-WP-Delivery'  => $event['delivery_id'],
				'X-WP-Site'      => $event['site_id'],
			),
			'body'     => $body,
		) );
		return ! is_wp_error( $r );
	}
}

// ---- Privileged mutation observers (PRD §10, lines 888-911) ----

add_action( 'user_register', function ( $uid ) {
	$u = get_userdata( $uid );
	if ( ! $u || ! user_can( $u, 'manage_options' ) ) {
		return;
	}
	s8_emit_event( array(
		'event_type' => 'wp.mutation.admin_user_create',
		'actor'      => s8_actor_from_current(),
		'details'    => array(
			'object'    => $u->user_login,
			'object_type' => 'wp_user',
			'action'    => 'create',
			'role'      => implode( ',', $u->roles ),
		),
	) );
} );

add_action( 'deleted_user', function ( $uid ) {
	s8_emit_event( array(
		'event_type' => 'wp.mutation.admin_user_delete',
		'actor'      => s8_actor_from_current(),
		'details'    => array( 'object' => (string) $uid, 'object_type' => 'wp_user', 'action' => 'delete' ),
	) );
} );

add_action( 'set_user_role', function ( $uid, $role, $old ) {
	$u = get_userdata( $uid );
	if ( ! $u || ! user_can( $u, 'manage_options' ) ) {
		return;
	}
	s8_emit_event( array(
		'event_type' => 'wp.mutation.role_change',
		'actor'      => s8_actor_from_current(),
		'details'    => array(
			'object'    => $u->user_login,
			'object_type' => 'wp_user',
			'action'    => 'role_change',
			'from'      => is_array( $old ) ? implode( ',', $old ) : (string) $old,
			'to'        => $role,
		),
	) );
}, 10, 3 );

add_action( 'activated_plugin', function ( $plugin ) {
	s8_emit_event( array(
		'event_type' => 'wp.mutation.plugin_activate',
		'actor'      => s8_actor_from_current(),
		'details'    => array( 'object' => $plugin, 'object_type' => 'wp_plugin', 'action' => 'activate' ),
	) );
} );

add_action( 'deactivated_plugin', function ( $plugin ) {
	s8_emit_event( array(
		'event_type' => 'wp.mutation.plugin_deactivate',
		'actor'      => s8_actor_from_current(),
		'details'    => array( 'object' => $plugin, 'object_type' => 'wp_plugin', 'action' => 'deactivate' ),
	) );
} );

add_action( 'upgrader_process_complete', function ( $upgrader, $extra ) {
	$extra = (array) $extra;
	if ( ( $extra['type'] ?? '' ) === 'plugin' ) {
		$action = $extra['action'] ?? '';
		$map    = array(
			'install' => 'wp.mutation.plugin_install',
			'update'  => 'wp.mutation.plugin_update',
			'delete'  => 'wp.mutation.plugin_delete',
		);
		$et = $map[ $action ] ?? null;
		if ( $et ) {
			s8_emit_event( array(
				'event_type' => $et,
				'actor'      => s8_actor_from_current(),
				'details'    => array( 'object' => $extra['plugin'] ?? '', 'object_type' => 'wp_plugin', 'action' => $action ),
			) );
		}
	} elseif ( ( $extra['type'] ?? '' ) === 'core' ) {
		s8_emit_event( array(
			'event_type' => 'wp.mutation.core_update',
			'actor'      => s8_actor_from_current(),
			'details'    => array(
				'object'    => 'wordpress-core',
				'object_type' => 'wp_core',
				'action'    => 'update',
				'to'        => ( $extra['version'] ?? '' ),
			),
		) );
	}
}, 10, 2 );

// ---- JIT WP-side hooks ----
add_action( 's8_jit_expire_user', 's8_jit_expire_user' );

if ( ! function_exists( 's8_collect_inventory' ) ) {
	/**
	 * S10-D4: collect a reliable WordPress inventory (core/plugins/themes).
	 * Uses only WordPress-native APIs; no external scanners. Returns an
	 * assoc array shaped for the central correlation pipeline (Dwight S10-D3).
	 */
	function s8_collect_inventory(): array {
		if ( ! function_exists( 'get_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		if ( ! function_exists( 'wp_get_themes' ) ) {
			require_once ABSPATH . 'wp-admin/includes/theme.php';
		}

		$active_plugins = (array) get_option( 'active_plugins', array() );
		$plugins         = array();
		foreach ( get_plugins() as $file => $meta ) {
			$plugins[] = array(
				'name'    => (string) ( $meta['TextDomain'] ?? $meta['Name'] ?? $file ),
				'slug'    => (string) ( $meta['TextDomain'] ?? dirname( $file ) === '.' ? $file : dirname( $file ) ),
				'file'    => (string) $file,
				'version' => (string) ( $meta['Version'] ?? '' ),
				'active'  => in_array( $file, $active_plugins, true ),
			);
		}

		$current_theme = wp_get_theme();
		$themes         = array();
		foreach ( wp_get_themes() as $slug => $theme ) {
			$themes[] = array(
				'name'    => (string) ( $theme->get( 'Name' ) ?? $slug ),
				'slug'    => (string) $slug,
				'version' => (string) ( $theme->get( 'Version' ) ?? '' ),
				'active'  => ( $slug === $current_theme->get_stylesheet() ),
			);
		}

		return array(
			'schema_version' => 'wp-inventory/1.0',
			'site_id'        => s8_site_id(),
			'collected_at'   => gmdate( 'c' ),
			'core'           => array(
				'version' => (string) get_bloginfo( 'version' ),
			),
			'plugins'        => $plugins,
			'themes'         => $themes,
		);
	}
}

if ( function_exists( 'register_rest_route' ) ) {
	add_action( 'rest_api_init', function () {
		// One-time redemption: the token IS the credential (central-issued).
		register_rest_route( 's8/v1', '/jit/redeem', array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => function ( $request ) {
				$p     = $request->get_json_params();
				$token = (string) ( $p['token'] ?? '' );
				$rid   = (string) ( $p['request_id'] ?? '' );
				if ( $token === '' ) {
					return new WP_Error( 'bad_request', 'missing token', array( 'status' => 400 ) );
				}
				return rest_ensure_response( s8_jit_redeem( $token, $rid ) );
			},
		) );
		// Request a JIT grant (human approval happens centrally).
		register_rest_route( 's8/v1', '/jit/request', array(
			'methods'             => 'POST',
			'permission_callback' => function () {
				return current_user_can( 'manage_options' );
			},
			'callback'            => function ( $request ) {
				$p   = $request->get_json_params();
				$res = s8_jit_request( (string) ( $p['reason'] ?? '' ), (int) ( $p['duration_minutes'] ?? 60 ) );
				return rest_ensure_response( $res );
			},
		) );
		// Inventory pull (central -> WP). Signed request (reuse S8 event secret)
		// so only the central plane can read version metadata. Fail-closed.
		register_rest_route( 's8/v1', '/inventory', array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => function ( $request ) {
				$secret = s8_event_secret();
				if ( $secret === '' ) {
					return new WP_Error( 's8_config', 'inventory signing not configured', array( 'status' => 503 ) );
				}
				$body = (string) $request->get_body();
				$sig  = (string) ( $request->get_header( 'x-wp-signature' ) ?? '' );
				$sig  = preg_replace( '/^sha256=/', '', $sig );
				if ( $sig === '' || ! s8_verify_event( $secret, $body, $sig ) ) {
					return new WP_Error( 's8_auth', 'invalid signature', array( 'status' => 401 ) );
				}
				return rest_ensure_response( s8_collect_inventory() );
			},
		) );
	} );
}

if ( ! function_exists( 's8_actor_from_current' ) ) {
	function s8_actor_from_current(): array {
		$uid = function_exists( 'get_current_user_id' ) ? get_current_user_id() : 0;
		if ( $uid ) {
			$u = get_userdata( $uid );
			return array(
				'type'     => 'human',
				'id'       => $u ? $u->user_login : (string) $uid,
				'ip'       => s8_client_ip(),
				'grant_id' => null,
			);
		}
		return array( 'type' => 'system', 'id' => 'wp-cron', 'ip' => null, 'grant_id' => null );
	}
}

if ( ! function_exists( 's8_client_ip' ) ) {
	function s8_client_ip(): ?string {
		foreach ( array( 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR' ) as $k ) {
			if ( ! empty( $_SERVER[ $k ] ) ) {
				return (string) $_SERVER[ $k ];
			}
		}
		return null;
	}
}
