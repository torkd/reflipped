// Password hashing on crypto.argon2 (src/lib/password.ts, SH-13) must keep reading the hashes the npm `argon2`
// module wrote, so existing portal and admin accounts keep signing in. The fixtures were made with argon2 0.44.0.

import assert from "node:assert/strict"
import { test } from "node:test"
import { hashPassword, passwordNeedsRehash, verifyPassword } from "../src/lib/password"

// argon2.hash("fixture-password-1", { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
const CURRENT = "$argon2id$v=19$m=19456,t=2,p=1$/3TLryZuZ9Pk7BtyTW0XkA$qVQuCiriRX/PNLTXQzRKKEV/J0yyQ62V0V9ynhpro38"
// argon2.hash("old-params", { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 }): the module's defaults
const OLD_PARAMETERS = "$argon2id$v=19$m=65536,t=3,p=4$Mbl4vWiXGSKhJJxXtMv+UA$rO7pSDPKJzIHDkJNRiS/t/bHFGUY5T/V177Y/KsXbeo"
// argon2.hash("argon2i-pw", { type: argon2i, memoryCost: 19456, timeCost: 2, parallelism: 1 })
const ARGON2I = "$argon2i$v=19$m=19456,t=2,p=1$BdS4iuCw3wwbaSWRLxGgKw$u+LjtKXfaqB3st+Cmec7FbRlzV+zIrBqEJgjBtF2YkM"

test("hashes written by the argon2 module still verify", async () => {
    assert.equal(await verifyPassword(CURRENT, "fixture-password-1"), true)
    assert.equal(await verifyPassword(CURRENT, "fixture-password-2"), false)
    assert.equal(await verifyPassword(CURRENT, ""), false)
    assert.equal(passwordNeedsRehash(CURRENT), false)

    // other parameters (several lanes) and another variant are read from the string
    assert.equal(await verifyPassword(OLD_PARAMETERS, "old-params"), true)
    assert.equal(await verifyPassword(OLD_PARAMETERS, "old-param"), false)
    assert.equal(passwordNeedsRehash(OLD_PARAMETERS), true)
    assert.equal(await verifyPassword(ARGON2I, "argon2i-pw"), true)
    assert.equal(await verifyPassword(ARGON2I, "argon2id-pw"), false)
})

test("new hashes have the argon2 module's format", async () => {
    const hash = await hashPassword("pässword ✓")
    // 16-byte salt and 32-byte tag, base64 without padding
    assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/)
    assert.equal(await verifyPassword(hash, "pässword ✓"), true)
    assert.equal(await verifyPassword(hash, "password ✓"), false)
    assert.equal(passwordNeedsRehash(hash), false)
    assert.notEqual(await hashPassword("pässword ✓"), hash)
})

test("a damaged hash never verifies", async () => {
    const damaged = [
        "",
        "x",
        "not a hash",
        "$argon2id$v=19$m=19456,t=2,p=1$abc",
        CURRENT.slice(0, -3),
        CURRENT.replace("qVQu", "qVQv"),
        CURRENT.replace("v=19", "v=16"),
        CURRENT.replace("$v=19", ""),
        CURRENT.replace("m=19456", "m=19457"),
        CURRENT.replace("m=19456", "m=abc"),
        CURRENT.replace("m=19456,", ""),
        CURRENT.replace("t=2", "t=0"),
        CURRENT.replace("argon2id", "bcrypt"),
        CURRENT.replace("/3TL", "=3TL"),
        CURRENT + "$extra",
    ]
    for (const hash of damaged) assert.equal(await verifyPassword(hash, "fixture-password-1"), false, hash)
    for (const hash of ["", "not a hash", CURRENT.replace("v=19", "v=16"), CURRENT.replace("m=19456", "m=abc")])
        assert.equal(passwordNeedsRehash(hash), true, hash)
})
