<?php
/**
 * S8-D4 signing primitives for WordPress mutation events.
 *
 * Canonical scheme (mirrors apps/api/src/routes/webhooks.ts so the central
 * ingest — Jim's S8-D1 — can verify with node:crypto createHmac):
 *   signature = HMAC-SHA256( rawJsonBody, S8_WP_EVENT_SECRET )   (hex, lowercase)
 *   header    = "X-WP-Signature: sha256=<hex>"
 * Replay protection is twofold: an advisory freshness window on `occurred_at`
 * (central rejects stale deliveries) and authoritative dedup on
 * (site_id, delivery_id) server-side. WP stores nothing but the signature.
 *
 * Pure functions only — safe to require standalone (no WordPress ABSPATH guard
 * needed) so a future PHPUnit harness can exercise them without a live site.
 */

if ( ! function_exists( 's8_event_secret' ) ) {
	function s8_event_secret(): string {
		if ( defined( 'S8_WP_EVENT_SECRET' ) ) {
			return (string) S8_WP_EVENT_SECRET;
		}
		$v = getenv( 'S8_WP_EVENT_SECRET' );
		return $v === false ? '' : (string) $v;
	}
}

if ( ! function_exists( 's8_canonical_body' ) ) {
	function s8_canonical_body( array $event ): string {
		return (string) json_encode( $event, JSON_UNESCAPED_SLASHES );
	}
}

if ( ! function_exists( 's8_sign_event' ) ) {
	// Returns the lowercase hex HMAC (no "sha256=" prefix).
	function s8_sign_event( string $secret, array $event ): string {
		return (string) hash_hmac( 'sha256', s8_canonical_body( $event ), $secret, false );
	}
}

if ( ! function_exists( 's8_signature_header' ) ) {
	function s8_signature_header( string $secret, array $event ): string {
		return 'sha256=' . s8_sign_event( $secret, $event );
	}
}

if ( ! function_exists( 's8_verify_event' ) ) {
	// Verify a RAW received body string against a hex signature (no prefix).
	// Uses hash_equals (constant-time) to avoid timing leaks.
	function s8_verify_event( string $secret, string $body, string $sigHex ): bool {
		$expected = (string) hash_hmac( 'sha256', $body, $secret, false );
		if ( ! is_string( $expected ) || ! is_string( $sigHex ) ) {
			return false;
		}
		if ( strlen( $expected ) !== strlen( $sigHex ) ) {
			return false;
		}
		return hash_equals( $expected, $sigHex );
	}
}

if ( ! function_exists( 's8_event_is_fresh' ) ) {
	// Advisory freshness check. Central is authoritative; this mirrors the
	// WEBHOOK_MAX_AGE_MIN window used by the git webhook ingress.
	function s8_event_is_fresh( string $occurredAt, int $maxAgeMs = 600000 ): bool {
		$ts = strtotime( $occurredAt );
		if ( $ts === false ) {
			return false;
		}
		$ageMs = (int) ( microtime( true ) * 1000 ) - (int) ( $ts * 1000 );
		return $ageMs >= 0 && $ageMs <= $maxAgeMs;
	}
}
