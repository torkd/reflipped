// TOTP second factor for portal users (ACC-2): RFC 6238 with the parameters every authenticator app supports
// (HMAC-SHA1, 6 digits, 30 s steps). A code is accepted one step early or late for clock drift; the caller stores the
// accepted step (`useUserTotpStepSync`) so the same code can't be used twice.

import { createHmac, randomBytes, timingSafeEqual } from "crypto"

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const STEP_SECONDS = 30
const DIGITS = 6
/** Steps accepted on either side of the current one. */
const DRIFT_STEPS = 1

export function base32Encode(bytes: Buffer): string {
    let bits = 0, value = 0, out = ""
    for (const byte of bytes) {
        value = (value << 8) | byte
        bits += 8
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31]
            bits -= 5
        }
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
    return out
}

/** Decodes base32, ignoring case, spaces and padding; null on any other character. */
export function base32Decode(text: string): Buffer | null {
    const clean = text.replace(/[\s=]/g, "").toUpperCase()
    let bits = 0, value = 0
    const bytes: number[] = []
    for (const symbol of clean) {
        const index = BASE32.indexOf(symbol)
        if (index < 0) return null
        value = (value << 5) | index
        bits += 5
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255)
            bits -= 8
        }
    }
    return Buffer.from(bytes)
}

/** A new secret: 160 bits (RFC 4226's recommendation), as base32. */
export function generateTotpSecret(): string {
    return base32Encode(randomBytes(20))
}

export function totpStep(now: Date = new Date()): number {
    return Math.floor(now.getTime() / 1000 / STEP_SECONDS)
}

/** The code of a time step. */
export function totpCode(secret: string, step: number): string {
    const key = base32Decode(secret)
    if (key === null) throw new Error("invalid TOTP secret")
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(step))
    const hmac = createHmac("sha1", key).update(counter).digest()
    const offset = hmac[hmac.length - 1] & 15
    const binary = hmac.readUInt32BE(offset) & 0x7fffffff
    return String(binary % 10 ** DIGITS).padStart(DIGITS, "0")
}

/** The time step whose code this is (within the drift window), or null. Spaces in the typed code are ignored. */
export function matchTotp(secret: string, input: string, now: Date = new Date()): number | null {
    const code = input.replace(/\s/g, "")
    if (!/^\d{6}$/.test(code)) return null
    const current = totpStep(now)
    let matched: number | null = null
    // every step is checked, so the time taken doesn't tell which one matched
    for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
        if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code)) && matched === null) matched = step
    }
    return matched
}

/** The `otpauth://` URI authenticator apps read from the QR code. */
export function totpUri(issuer: string, account: string, secret: string): string {
    const label = encodeURIComponent(`${issuer}:${account}`)
    const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) })
    return `otpauth://totp/${label}?${params.toString()}`
}
