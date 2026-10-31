// Device identity at the openapi login (SEC-5, docs/hardening.md).
//
// The device secret is what proves a device owns its account. The shell sends a random per-install UUID as
// `whiteKey`; the Kakao SDK sends its own `whiteKey` (derived from the advertising ID, and empty when the user
// opted out of ad tracking), in which case the SDK's per-install `deviceId` is the fallback. Reflipped stores
// only a SHA-256 of it (`accounts.device_secret_hash`). The `playerid` header never selects an account.

import { createHash, randomInt } from "crypto"

/** Shortest secret accepted; the shell's UUIDs are 36 characters. */
export const MIN_DEVICE_SECRET_LENGTH = 16

/** The device secret of an openapi login body: `whiteKey`, or `deviceId` when the SDK sent no whiteKey. Null when neither is usable. */
export function deviceSecretFromBody(body: { whiteKey?: unknown, deviceId?: unknown } | undefined): string | null {
    for (const value of [body?.whiteKey, body?.deviceId]) {
        if (typeof value === "string" && value.length >= MIN_DEVICE_SECRET_LENGTH) return value
    }
    return null
}

/** What `accounts.device_secret_hash` stores: hex SHA-256 of the secret. The secrets are random, so no salt or KDF. */
export function hashDeviceSecret(secret: string): string {
    return createHash("sha256").update(secret, "utf8").digest("hex")
}

/**
 * A public `idpId` for a new device account. The real server answers with a 10-digit number (`docs/routes/
 * service_v4_auth_loginDevice.md`), so this does too; it is not a secret and is never used to look an account up.
 */
export function generatePublicIdpId(): string {
    return String(randomInt(1_000_000_000, 9_999_999_999))
}
