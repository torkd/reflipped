import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, signedGameHeaders, TestPlayer } from "./helpers";

// A new player earns the day's login rewards at the first /load, during the tutorial, when the game doesn't show the
// calendar; it goes home without another /load. The tutorial's last step reply carries them, as on the original server
// (docs/routes/tutorial_update_step.md), so the calendar plays right after the tutorial and the rewards come once.

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let clock: typeof import("../src/utils")
let apiCount = 0

before(async () => {
    ({ fastify, cleanup } = await createTestServer({ paramCheck: "enforce" }))
    data = await import("../src/data/wdfpData")
    clock = await import("../src/utils")
    clock.setServerTime(new Date("2025-01-03T12:00:00Z"))
})
after(async () => {
    clock.setServerTime(null)
    await cleanup?.()
})

async function post(player: TestPlayer, route: string, body: Record<string, unknown> = {}) {
    const url = `/latest/api/index.php/${route}`
    const payload = encodeGameBody({ ...body, viewer_id: player.viewerId, api_count: ++apiCount })
    const response = await fastify.inject({ method: "POST", url, payload, headers: signedGameHeaders(player.udid, player.viewerId, url, payload) })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

async function bonusMailCount(player: TestPlayer): Promise<number> {
    const session = await data.getSession(String(player.viewerId))
    const id = (await data.getAccountPlayers(session!.accountId))[0]
    return data.getPlayerAllMailSync(id).filter(mail => mail.reasonId === 55).length
}

for (const [name, lastStep, skip] of [["full", 16, false], ["shortened", 5, true]] as const) {
    test(`the ${name} tutorial's last step presents the login rewards the first /load earned`, async () => {
        const player = await createTestPlayer(fastify)
        const first = await post(player, "load", { access_token: player.zat })
        assert.ok(first.bonus_index_list.length > 0, "the first /load earns the day's rewards")
        const mails = await bonusMailCount(player)

        // a step before the last one carries nothing
        const middle = await post(player, "tutorial/update_step", { step: 3, skip, name: "Tester" })
        assert.equal(middle.bonus_index_list, undefined)

        const end = await post(player, "tutorial/update_step", { step: lastStep, skip, name: "Tester" })
        assert.deepEqual(end.bonus_index_list, first.bonus_index_list)
        assert.equal(typeof end.login_bonus_received_at, "number")
        assert.deepEqual(end.premium_bonus_index_list, [])
        assert.deepEqual(end.premium_bonus_mailed_item_list, [])
        assert.equal(await bonusMailCount(player), mails, "presented again, not earned again")

        // once the game has shown it, the next /load doesn't present it again
        await post(player, "bonus/shown")
        const next = await post(player, "load", { access_token: player.zat })
        assert.deepEqual(next.bonus_index_list, [])
        assert.equal(await bonusMailCount(player), mails)
    })
}
