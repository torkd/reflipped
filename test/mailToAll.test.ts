// FT-4: one mail to every player at once (the Players page, POST /api/player/mail/all).
import { test } from "node:test";
import assert from "node:assert/strict";
import { admin, data, fillGiftBox, gift, itemId, newPlayer, pendingMail, sendMail, sendToAll, setupMailTests } from "./mailHelpers";

setupMailTests()

/** The result's counts add up to every player on the server, whichever other tests made players. */
function assertCountsAddUp(result: Record<string, number>) {
    assert.equal(result.players, data.getAllPlayersSync().length)
    assert.equal(result.sent + result.skippedFull + result.skippedLimit + result.skippedExpired, result.players)
}

// the first test of the file: its server has no players yet
test("with no players, nothing is sent and the Players page has no form", async () => {
    assert.equal(data.getAllPlayersSync().length, 0)
    const response = await sendToAll({ type: "FREE_MANA", number: 100 })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json(), { players: 0, sent: 0, skippedFull: 0, skippedLimit: 0, skippedExpired: 0 })
    const page = await admin.inject({ method: "GET", url: "/player" })
    assert.doesNotMatch(page.body, /id="send-mail"/)
})

test("send to all players", async (t) => {
    const [a, b, full, rich] = [await newPlayer(), await newPlayer(), await newPlayer(), await newPlayer()]

    await t.test("the Players page has the send to all form", async () => {
        const page = await admin.inject({ method: "GET", url: "/player" })
        assert.match(page.body, /<form id="send-mail" class="card" data-player-id="all" data-reward-locked="false" data-confirm-send="[^"]+">/)
        assert.match(page.body, /Send to all players/)
        // the player page keeps its own form
        const playerPage = await admin.inject({ method: "GET", url: `/player/${a.playerId}` })
        assert.match(playerPage.body, new RegExp(`<form id="send-mail" class="card" data-player-id="${a.playerId}" data-reward-locked="false">`))
        assert.doesNotMatch(playerPage.body, /\{\{/, "no placeholder left")
    })

    await t.test("an invalid mail is refused and nobody gets anything", async () => {
        const before = await pendingMail(a)
        const invalid: Record<string, unknown>[] = [
            { type: "ITEM", number: 1 }, // no type id
            { type: "ITEM", typeId: 999999, number: 1 }, // no such item
            { type: "FREE_MANA", typeId: 5, number: 1 }, // currency with a type id
            { type: "FREE_MANA", number: 0 },
            { type: "FREE_VMONEY", number: 1_000_000 }, // more than the game allows
            { type: "NOPE", number: 1 },
            { type: "FREE_MANA", number: 1, subject: "" },
            { type: "FREE_MANA", number: 1, description: "a\u0000b" },
            { type: "FREE_MANA", number: 1, rewardLimitTime: "not a date" },
            { type: "FREE_MANA", number: 1, rewardLimitTime: "2200-01-01T00:00Z" }
        ]
        for (const mail of invalid) {
            const response = await sendToAll(mail)
            assert.equal(response.statusCode, 400, JSON.stringify(mail))
            assert.equal(typeof response.json().message, "string")
        }
        assert.equal((await pendingMail(a)).length, before.length)
    })

    await t.test("skips full gift boxes and players the mail would take past a limit, and counts them", async () => {
        await fillGiftBox(full)
        // 999,999 beads paid and free together: 900,000 more would pass the limit for a player who has 150,000
        data.updatePlayerSync({ id: rich.playerId, freeVmoney: 150_000 })
        data.updatePlayerSync({ id: a.playerId, freeVmoney: 0 })
        data.updatePlayerSync({ id: b.playerId, freeVmoney: 0 })

        const response = await sendToAll({ type: "FREE_VMONEY", number: 900_000 })
        assert.equal(response.statusCode, 200, response.body)
        assertCountsAddUp(response.json())
        assert.ok(response.json().skippedFull >= 1 && response.json().skippedLimit >= 1)

        for (const player of [a, b]) {
            const [mail] = await pendingMail(player)
            assert.equal(mail.type, 4)
            assert.equal(mail.number, 900_000)
            assert.equal(mail.subject, gift.subject)
        }
        assert.equal((await pendingMail(rich)).some(mail => mail.number === 900_000), false)
        assert.equal((await pendingMail(full)).some(mail => mail.number === 900_000), false)
    })

    await t.test("an item, armament, unit or title goes to everyone too", async () => {
        const response = await sendToAll({ type: "ITEM", typeId: itemId, number: 2 })
        assertCountsAddUp(response.json())
        for (const player of [a, b, rich]) assert.equal((await pendingMail(player))[0].type_id, itemId)
        assert.equal((await pendingMail(full)).some(mail => mail.type_id === itemId), false, "the full box is skipped")
    })

    await t.test("a failure part way rolls everything back", async () => {
        const { default: getDatabase, Database } = await import("../src/data/index")
        const db = getDatabase(Database.WDFP_DATA)
        const counts = () => [a, b, rich].map(player => data.getPlayerReceivableMailCountSync(player.playerId, new Date(0)))
        const before = counts()
        // the second player's insert fails, after the first player's went in
        db.prepare(`CREATE TEMP TRIGGER fail_mail BEFORE INSERT ON players_mail WHEN NEW.player_id = ${b.playerId} BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`).run()
        try {
            const response = await sendToAll({ type: "FREE_MANA", number: 1 })
            assert.equal(response.statusCode, 500)
            assert.doesNotMatch(response.body, /disk on fire/, "no exception text on the page")
            // the shared error handler's answer, with the request ID to find it in the log
            assert.equal(response.json().requestId, response.headers["x-request-id"])
        } finally {
            db.prepare(`DROP TRIGGER fail_mail`).run()
        }
        assert.deepEqual(counts(), before)
    })
})

test("a mail whose expiry has passed on a player's clock is refused, and skipped and counted when sent to all", async () => {
    const { setPlayerClockSync } = await import("../src/lib/playerClock")
    const [here, ahead] = [await newPlayer(), await newPlayer()]
    // the test server's clock stands at 2025-01-03 12:00 UTC: expiring then or earlier, it could never be received
    for (const rewardLimitTime of ["2025-01-03T12:00:00Z", "2000-01-01T00:00Z", "1970-01-01T00:00Z"]) {
        const response = await sendMail(here, { type: "FREE_MANA", number: 1, rewardLimitTime })
        assert.equal(response.statusCode, 400, rewardLimitTime)
        assert.match(response.json().message, /expiry date has passed/)
    }
    const expired = await sendToAll({ type: "FREE_MANA", number: 1, rewardLimitTime: "2000-01-01T00:00Z" })
    assert.equal(expired.statusCode, 200, expired.body)
    assertCountsAddUp(expired.json())
    assert.deepEqual([expired.json().sent, expired.json().skippedExpired], [0, expired.json().players])
    assert.deepEqual(await pendingMail(here), [])

    // a week ahead, a mail expiring in two days has expired for that player only
    setPlayerClockSync(ahead.playerId, new Date("2025-01-10T00:00:00Z"))
    try {
        assert.equal((await sendMail(ahead, { type: "FREE_MANA", number: 2, rewardLimitTime: "2025-01-05T00:00Z" })).statusCode, 400)
        const response = await sendToAll({ type: "FREE_MANA", number: 2, rewardLimitTime: "2025-01-05T00:00Z" })
        assertCountsAddUp(response.json())
        assert.ok(response.json().skippedExpired >= 1)
        assert.deepEqual((await pendingMail(here)).map(mail => mail.number), [2])
        assert.deepEqual(await pendingMail(ahead), [])
    } finally {
        setPlayerClockSync(ahead.playerId, null)
    }
})

test("a single send that fails for another reason than the mail answers the shared 500, not the exception text", async () => {
    const player = await newPlayer()
    const { default: getDatabase, Database } = await import("../src/data/index")
    const db = getDatabase(Database.WDFP_DATA)
    db.prepare(`CREATE TEMP TRIGGER fail_one_mail BEFORE INSERT ON players_mail WHEN NEW.player_id = ${player.playerId} BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`).run()
    try {
        const response = await sendMail(player, { type: "FREE_MANA", number: 1 })
        assert.equal(response.statusCode, 500)
        assert.doesNotMatch(response.body, /disk on fire/)
        assert.equal(response.json().requestId, response.headers["x-request-id"])
    } finally {
        db.prepare(`DROP TRIGGER fail_one_mail`).run()
    }
})
