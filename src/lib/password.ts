// Portal passwords (ACC-1, docs/accounts.md "Data model"): argon2id, stored as the encoded hash string
// (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`), which carries its own parameters and salt.
//
// Hashing is Node's own `crypto.argon2` (Node 24.7+). Until SH-13 it was the npm `argon2` module, a native
// module that can't load where the server runs inside the Android app. The stored strings are the same
// PHC format that module wrote, so its hashes verify here unchanged.

import { argon2, randomBytes, randomUUID, timingSafeEqual } from "crypto"

type Algorithm = "argon2d" | "argon2i" | "argon2id"

/** OWASP's argon2id baseline (19 MiB, 2 passes, 1 lane): cheap enough for a small server behind rate limits. */
const HASH_OPTIONS = Object.freeze({ memoryCost: 19_456, timeCost: 2, parallelism: 1 })
const ALGORITHM: Algorithm = "argon2id"
/** Argon2 version 1.3, the only one `crypto.argon2` computes. */
const VERSION = 0x13
const SALT_BYTES = 16
const HASH_BYTES = 32

/** Longest password hashed; anything longer is refused rather than fed to the KDF. */
export const MAX_PASSWORD_LENGTH = 1024

/** A hash of a random password, verified against when the user doesn't exist so the answer takes as long either way. */
let dummyHash: Promise<string> | null = null

interface EncodedHash {
    algorithm: Algorithm
    version: number
    memoryCost: number
    timeCost: number
    parallelism: number
    /** the `data` parameter (associated data), which our own hashes never have */
    associatedData: Buffer | null
    salt: Buffer
    hash: Buffer
}

const BASE64 = /^[A-Za-z0-9+/]+$/
const DECIMAL = /^(0|[1-9]\d{0,9})$/

/** PHC strings carry base64 without padding. */
function encodeBase64(bytes: Buffer): string {
    return bytes.toString("base64").replace(/=+$/, "")
}

function decodeBase64(text: string): Buffer {
    if (!BASE64.test(text) || text.length % 4 === 1) throw new TypeError("invalid base64 in password hash")
    return Buffer.from(text, "base64")
}

/** Parses `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. Throws on anything else. */
function parseHash(encoded: string): EncodedHash {
    const fields = encoded.split("$")
    // "", algorithm, [v=…], parameters, salt, hash
    if (fields[0] !== "" || (fields.length !== 5 && fields.length !== 6)) throw new TypeError("not a password hash")
    const algorithm = fields[1]
    if (algorithm !== "argon2d" && algorithm !== "argon2i" && algorithm !== "argon2id") throw new TypeError("not an argon2 hash")
    let version = 0x10 // a string without `v=` is version 1.0, as the argon2 module read it
    if (fields.length === 6) {
        const match = /^v=(\d{1,3})$/.exec(fields[2])
        if (!match) throw new TypeError("invalid version in password hash")
        version = Number(match[1])
    }
    const parameters = new Map<string, string>()
    for (const parameter of fields[fields.length - 3].split(",")) {
        const separator = parameter.indexOf("=")
        if (separator < 1 || parameters.has(parameter.slice(0, separator))) throw new TypeError("invalid parameters in password hash")
        parameters.set(parameter.slice(0, separator), parameter.slice(separator + 1))
    }
    const number = (name: string): number => {
        const value = parameters.get(name)
        if (value === undefined || !DECIMAL.test(value)) throw new TypeError(`invalid ${name} in password hash`)
        return Number(value)
    }
    const data = parameters.get("data")
    return {
        algorithm,
        version,
        memoryCost: number("m"),
        timeCost: number("t"),
        parallelism: number("p"),
        associatedData: data === undefined ? null : decodeBase64(data),
        salt: decodeBase64(fields[fields.length - 2]),
        hash: decodeBase64(fields[fields.length - 1]),
    }
}

/** The raw argon2 tag, computed on libuv's thread pool like the argon2 module did. */
function derive(password: string, parameters: Omit<EncodedHash, "hash" | "version">, tagLength: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        argon2(parameters.algorithm, {
            message: Buffer.from(password),
            nonce: parameters.salt,
            parallelism: parameters.parallelism,
            tagLength,
            memory: parameters.memoryCost,
            passes: parameters.timeCost,
            ...(parameters.associatedData?.length ? { associatedData: parameters.associatedData } : {}),
        }, (error, tag) => error ? reject(error) : resolve(Buffer.from(tag.buffer, tag.byteOffset, tag.byteLength)))
    })
}

async function makeHash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES)
    const tag = await derive(password, { algorithm: ALGORITHM, ...HASH_OPTIONS, associatedData: null, salt }, HASH_BYTES)
    const { memoryCost, timeCost, parallelism } = HASH_OPTIONS
    return `$${ALGORITHM}$v=${VERSION}$m=${memoryCost},t=${timeCost},p=${parallelism}$${encodeBase64(salt)}$${encodeBase64(tag)}`
}

async function checkHash(encoded: string, password: string): Promise<boolean> {
    const parsed = parseHash(encoded)
    // crypto.argon2 has no version setting; a 1.0 hash (never written by this server) can't match
    if (parsed.version !== VERSION) return false
    const tag = await derive(password, parsed, parsed.hash.length)
    return tag.length === parsed.hash.length && timingSafeEqual(tag, parsed.hash)
}

export function hashPassword(password: string): Promise<string> {
    if (password.length > MAX_PASSWORD_LENGTH) throw new RangeError("password too long")
    return makeHash(password)
}

/**
 * Whether the password matches the stored hash. With no hash (unknown user) it still runs one verification and
 * answers false, so a login can't tell usernames apart by timing. A malformed hash also answers false.
 */
export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
    if (password.length > MAX_PASSWORD_LENGTH) return false
    if (hash === null) {
        dummyHash ??= makeHash(randomUUID())
        await checkHash(await dummyHash, password)
        return false
    }
    try {
        return await checkHash(hash, password)
    } catch {
        return false
    }
}

/** Whether a hash was made with other parameters than today's, so a login should store a fresh one. */
export function passwordNeedsRehash(hash: string): boolean {
    try {
        const parsed = parseHash(hash)
        return parsed.version !== VERSION
            || parsed.memoryCost !== HASH_OPTIONS.memoryCost
            || parsed.timeCost !== HASH_OPTIONS.timeCost
            || parsed.parallelism !== HASH_OPTIONS.parallelism
    } catch {
        return true
    }
}
