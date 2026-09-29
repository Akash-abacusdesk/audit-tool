<?php
/**
 * S8-D4 JIT WP-side: temporary admin sessions + one-time redemption.
 *
 * Contract with the central plane (Jim S8-D1):
 *   - WP requests a JIT grant:      POST {CENTRAL}/api/v1/jit/requests
 *                                    body { reason, duration_minutes, site_id }
 *                                    -> 202 { request_id }
 *   - Human approves centrally; central issues a ONE-TIME opaque token.
 *   - WP redeems the token:         POST {CENTRAL}/api/v1/jit/redeem
 *                                    body { token, request_id }
 *                                    -> 200 { grant_id, ttl_seconds, requester }
 *                                    (central marks the token consumed, atomic)
 *   - WP provisions a SHORT-LIVED administrator, stores ONLY token_hash
 *     (hash-only storage), and schedules a single-fire auto-revoke cron.
 *
 * No shared/permanent admin password exists anywhere (PRD 2.1(5), §11).
 */

if ( ! function_exists( 's8_jit_central_base' ) ) {
	function s8_jit_central_base(): string {
		if ( defined( 'S8_CENTRAL_BASE_URL' ) ) {
			return rtrim( (string) S8_CENTRAL_BASE_URL, '/' );
		}
		$v = getenv( 'S8_CENTRAL_BASE_URL' );
		return rtrim( $v === false ? '' : (string) $v, '/' );
	}
}

if ( ! function_exists( 's8_jit_create_temp_user' ) ) {
	// Provisions a temporary administrator. Stores ONLY the token hash.
	// Returns the new user id, or 0 on failure.
	function s8_jit_create_temp_user( string $grantId, string $tokenHash, int $ttlSeconds, string $requester = '' ): int {
		$login = 's8jit_' . substr( preg_replace( '/[^a-z0-9]/i', '', $grantId ), 0, 8 );
		$email = $login . '@jit.local';
		$uid   = wp_insert_user( array(
			'user_login'           => $login,
			'user_email'           => $email,
			'user_pass'            => wp_generate_password( 32, true, true ),
			'role'                 => 'administrator',
			'show_admin_bar_front' => false,
		) );
		if ( is_wp_error( $uid ) ) {
			return 0;
		}
		$uid = (int) $uid;
		update_user_meta( $uid, 's8_jit_grant_id', $grantId );
		update_user_meta( $uid, 's8_jit_token_hash', $tokenHash ); // hash-only
		update_user_meta( $uid, 's8_jit_expires_at', (int) ( time() + $ttlSeconds ) );
		update_user_meta( $uid, 's8_jit_requester', $requester );
		// Atomic single-fire auto-revoke.
		wp_schedule_single_event( (int) ( time() + $ttlSeconds ), 's8_jit_expire_user', array( $uid ) );
		return $uid;
	}
}

if ( ! function_exists( 's8_jit_expire_user' ) ) {
	// Single-fire cron handler: delete the temp admin + emit a revoke event.
	function s8_jit_expire_user( int $uid ): void {
		$uid = (int) $uid;
		if ( $uid <= 0 || ! function_exists( 'get_userdata' ) || ! get_userdata( $uid ) ) {
			return;
		}
		$grantId = (string) get_user_meta( $uid, 's8_jit_grant_id', true );
		if ( $grantId !== '' && function_exists( 's8_emit_event' ) ) {
			$u = get_userdata( $uid );
			s8_emit_event( array(
				'event_type' => 'wp.jit.session_revoke',
				'actor'      => array( 'type' => 'jit', 'id' => $grantId, 'ip' => null, 'grant_id' => $grantId ),
				'request_id' => null,
				'details'    => array(
					'object'      => $u ? $u->user_login : (string) $uid,
					'object_type' => 'wp_user',
					'action'      => 'auto_revoke',
					'grant_id'    => $grantId,
				),
			) );
		}
		if ( function_exists( 'wp_delete_user' ) ) {
			wp_delete_user( $uid );
		}
	}
}

if ( ! function_exists( 's8_jit_redeem' ) ) {
	// One-time redemption. Central consumes the token atomically; WP keeps only
	// the hash. Fail-closed: any central error => no session created.
	function s8_jit_redeem( string $token, string $requestId ): array {
		$base = s8_jit_central_base();
		if ( $base === '' ) {
			return array( 'ok' => false, 'error' => 'central base url not configured' );
		}
		$url       = $base . '/api/v1/jit/redeem';
		$tokenHash = (string) hash( 'sha256', $token, false );
		$resp      = wp_remote_post( $url, array(
			'timeout'  => 10,
			'headers'  => array( 'Content-Type' => 'application/json' ),
			'body'     => json_encode( array( 'token' => $token, 'request_id' => $requestId ) ),
		) );
		if ( is_wp_error( $resp ) ) {
			return array( 'ok' => false, 'error' => $resp->get_error_message() );
		}
		$code = (int) wp_remote_retrieve_response_code( $resp );
		$body = json_decode( (string) wp_remote_retrieve_body( $resp ), true );
		if ( $code !== 200 || empty( $body['grant_id'] ) ) {
			return array( 'ok' => false, 'error' => 'central rejected redemption', 'code' => $code );
		}
		$ttl  = (int) ( $body['ttl_seconds'] ?? 900 );
		$uid  = s8_jit_create_temp_user( (string) $body['grant_id'], $tokenHash, $ttl, (string) ( $body['requester'] ?? '' ) );
		if ( ! $uid ) {
			return array( 'ok' => false, 'error' => 'failed to provision temp user' );
		}
		if ( function_exists( 's8_emit_event' ) ) {
			$u = function_exists( 'get_userdata' ) ? get_userdata( $uid ) : null;
			s8_emit_event( array(
				'event_type' => 'wp.jit.session_create',
				'actor'      => array( 'type' => 'jit', 'id' => (string) $body['grant_id'], 'ip' => null, 'grant_id' => (string) $body['grant_id'] ),
				'request_id' => $requestId === '' ? null : $requestId,
				'details'    => array(
					'object'      => $u ? $u->user_login : (string) $uid,
					'object_type' => 'wp_user',
					'action'      => 'create_temporary_admin',
					'grant_id'    => (string) $body['grant_id'],
					'expires_at'  => (int) ( time() + $ttl ),
				),
			) );
		}
		return array(
			'ok'         => true,
			'user_id'    => $uid,
			'grant_id'   => (string) $body['grant_id'],
			'expires_at' => (int) ( time() + $ttl ),
		);
	}
}

if ( ! function_exists( 's8_jit_request' ) ) {
	// Request a JIT session. Human approval happens server-side in central.
	function s8_jit_request( string $reason, int $durationMin ): array {
		$base = s8_jit_central_base();
		if ( $base === '' ) {
			return array( 'ok' => false, 'error' => 'central base url not configured' );
		}
		$url  = $base . '/api/v1/jit/requests';
		$resp = wp_remote_post( $url, array(
			'timeout' => 10,
			'headers' => array( 'Content-Type' => 'application/json' ),
			'body'    => json_encode( array(
				'reason'           => $reason,
				'duration_minutes' => $durationMin,
				'site_id'          => function_exists( 's8_site_id' ) ? s8_site_id() : '',
			) ),
		) );
		if ( is_wp_error( $resp ) ) {
			return array( 'ok' => false, 'error' => $resp->get_error_message() );
		}
		$code = (int) wp_remote_retrieve_response_code( $resp );
		$body = json_decode( (string) wp_remote_retrieve_body( $resp ), true );
		if ( $code !== 202 && $code !== 200 ) {
			return array( 'ok' => false, 'error' => 'request not accepted', 'code' => $code );
		}
		return array( 'ok' => true, 'request_id' => $body['request_id'] ?? null );
	}
}
