// One-time device link codes (ACC-1 stores them, ACC-4 delivers them; docs/accounts.md "Device linking").
// A code is short enough to type on a phone; only its SHA-256 is stored (`link_codes.code_hash`).

import { createHash, randomInt } from "crypto"

/** Digits and capitals without 0/O, 1/I/L: 31 symbols, so 8 of them are about 40 bits. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

export const LINK_CODE_LENGTH = 8

/** How long a code stays redeemable. */
export const LINK_CODE_LIFETIME_MS = 10 * 60 * 1000

export function generateLinkCode(): string {
    let code = ""
    for (let i = 0; i < LINK_CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)]
    return code
}

/** A code as typed: case, spaces and dashes don't matter. Null when it can't be a code. */
export function normalizeLinkCode(input: string): string | null {
    const code = input.replace(/[\s-]/g, "").toUpperCase()
    if (code.length !== LINK_CODE_LENGTH) return null
    for (const symbol of code) if (!ALPHABET.includes(symbol)) return null
    return code
}

/** What `link_codes.code_hash` stores: hex SHA-256 of the normalized code. */
export function hashLinkCode(code: string): string {
    return createHash("sha256").update(code, "utf8").digest("hex")
}
