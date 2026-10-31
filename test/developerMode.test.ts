import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { createTestServer, encodeGameBody, readCapturedRoute } from "./helpers";

// Developer mode (admin page): on unlocks everything for one player, off restores their own save.

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

/** The admin page's buttons are forms: a browser posts them as multipart with an empty body. */
function pressButton(url: string) {
    return admin.inject({ method: "POST", url, headers: { "content-type": "multipart/form-data; boundary=----form" }, payload: "------form--\r\n" })
}

/** Signs up a guest player and returns its player id. */
async function signUpPlayer(): Promise<number> {
    const deviceId = randomUUID()
    const login = await fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        payload: { ...readCapturedRoute("service_v4_auth_loginDevice").requestBody, deviceId, idpId: deviceId, whiteKey: randomUUID(), accessToken: "" }
    })
    const captured = readCapturedRoute("load").requestBody
    const signup = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/tool/signup`,
        headers: { "content-type": "application/x-www-form-urlencoded", "udid": randomUUID().toUpperCase() },
        payload: encodeGameBody({
            app_secret: captured.app_secret, access_token: login.json().zat, storage_directory_path: captured.storage_directory_path,
            app_admin: captured.app_admin, kakao_pid: captured.kakao_pid, device_id: captured.device_id, idp_code: "zd3"
        })
    })
    assert.equal(signup.statusCode, 200, signup.body)
    const { getAllPlayersSync } = await import("../src/data/wdfpData")
    const players = getAllPlayersSync()
    return players[players.length - 1].id
}

test("developer mode: on unlocks everything, off restores the player's own progress", async () => {
    const data = await import("../src/data/wdfpData")
    const { isUnlocked } = await import("../src/lib/developerMode")
    const { tutorialFinishedTriggerId } = await import("../src/data/utils")
    const playerId = await signUpPlayer()

    const before = {
        tutorialFinished: data.getPlayerTriggeredTutorialsSync(playerId).includes(tutorialFinishedTriggerId),
        characters: Object.keys(data.getPlayerCharactersSync(playerId)).length,
        equipment: Object.keys(data.getPlayerEquipmentListSync(playerId)).length,
        items: Object.keys(data.getPlayerItemsSync(playerId)).length,
        beads: data.getPlayerSync(playerId)!.freeVmoney,
        rankPoint: data.getPlayerSync(playerId)!.rankPoint,
        bossQuest: data.getPlayerSingleQuestProgressSync(playerId, 2, 1001001)
    }
    assert.equal(isUnlocked(playerId), false)

    // the admin page's "Unlock everything" button
    const unlocked = await pressButton(`/api/player/developer-mode?id=${playerId}&state=on`)
    assert.equal(unlocked.statusCode, 302)
    assert.match(String(unlocked.headers.location), new RegExp(`^/player/${playerId}\\?message=dev-on$`))
    assert.equal(isUnlocked(playerId), true)
    assert.ok(data.getPlayerTriggeredTutorialsSync(playerId).includes(tutorialFinishedTriggerId), "the tutorial counts as finished")

    const characters = data.getPlayerCharactersSync(playerId)
    assert.ok(Object.keys(characters).length > 400, "every playable character")
    const fiveStar = data.getPlayerCharacterSync(playerId, 151165)!
    assert.deepEqual([fiveStar.exp, fiveStar.overLimitStep, fiveStar.evolutionLevel], [379988, 4, 1], "max level, over-limit and evolution")
    assert.ok(data.getPlayerCharacterManaNodesSync(playerId, 151165).length > 0, "mana nodes unlocked")
    assert.equal(data.getPlayerCharacterSync(playerId, 999999), null, "no placeholder character")
    assert.equal(data.getPlayerCharacterSync(playerId, 700000), null, "no 7xxxxx event units")
    assert.equal(data.getPlayerCharacterSync(playerId, 700001), null, "none without skills (C8601 in the unit list)")

    assert.ok(Object.keys(data.getPlayerEquipmentListSync(playerId)).length > 50, "equipment")
    // every armament at its own maximum level: most go to 5, Durendal (an exchange item) only has level 1
    assert.equal(data.getPlayerEquipmentSync(playerId, 5010004)!.level, 5)
    assert.equal(data.getPlayerEquipmentSync(playerId, 5010005)!.level, 1)
    assert.ok(data.getPlayerItemSync(playerId, 40000)! >= 9999, "boss coins")
    // score reward pool numbers (score_reward type 1) are not items: granting them broke the unit list (C8601)
    assert.equal(data.getPlayerItemSync(playerId, 2101), null, "no rare pool number granted as an item")
    assert.ok(data.getPlayerSync(playerId)!.freeVmoney >= 500000, "beads")
    assert.equal(data.getPlayerSync(playerId)!.rankPoint, 666297, "rank 100")
    assert.equal(data.getPlayerSingleQuestProgressSync(playerId, 2, 1001001)?.finished, true, "boss battle cleared")
    assert.equal(data.getPlayerSingleQuestProgressSync(playerId, 8, 1002)?.clearRank, 5, "advent event quest cleared")

    // the page shows the state and enables Revert
    const page = await admin.inject({ method: "GET", url: `/player/${playerId}` })
    assert.match(page.body, /class="badge-on">On</)
    assert.match(page.body, /state=off/)

    // unlocking again keeps the first (real) save
    await pressButton(`/api/player/developer-mode?id=${playerId}&state=on`)

    // "Revert": back to the player's own progress
    const reverted = await pressButton(`/api/player/developer-mode?id=${playerId}&state=off`)
    assert.equal(reverted.statusCode, 302)
    assert.match(String(reverted.headers.location), /message=dev-off$/)
    assert.equal(isUnlocked(playerId), false)
    assert.equal(data.getPlayerTriggeredTutorialsSync(playerId).includes(tutorialFinishedTriggerId), before.tutorialFinished, "the tutorial is as it was")
    assert.equal(Object.keys(data.getPlayerCharactersSync(playerId)).length, before.characters)
    assert.equal(Object.keys(data.getPlayerEquipmentListSync(playerId)).length, before.equipment)
    assert.equal(Object.keys(data.getPlayerItemsSync(playerId)).length, before.items)
    assert.equal(data.getPlayerSync(playerId)!.freeVmoney, before.beads)
    assert.equal(data.getPlayerSync(playerId)!.rankPoint, before.rankPoint, "rank restored")
    assert.deepEqual(data.getPlayerSingleQuestProgressSync(playerId, 2, 1001001), before.bossQuest)

    // nothing left to revert
    const again = await pressButton(`/api/player/developer-mode?id=${playerId}&state=off`)
    assert.match(String(again.headers.location), /message=dev-already-off$/)
})

test("player admin: reset starts over on the same account, delete removes the account", async () => {
    const data = await import("../src/data/wdfpData")
    const { isUnlocked } = await import("../src/lib/developerMode")

    // reset: a fresh player on the same account, developer mode backup dropped
    const playerId = await signUpPlayer()
    const accountId = data.getAccountFromPlayerIdSync(playerId)!.id
    await pressButton(`/api/player/developer-mode?id=${playerId}&state=on`)
    assert.equal(isUnlocked(playerId), true)
    const reset = await pressButton(`/api/player/reset?id=${playerId}`)
    assert.equal(reset.statusCode, 302)
    const newPlayerId = Number(String(reset.headers.location).match(/^\/player\/(\d+)\?message=reset$/)?.[1])
    assert.ok(newPlayerId > 0, String(reset.headers.location))
    assert.equal(data.getPlayerSync(playerId), null, "old player gone")
    assert.equal(data.getAccountFromPlayerIdSync(newPlayerId)!.id, accountId, "same account")
    assert.ok(Object.keys(data.getPlayerCharactersSync(newPlayerId)).length < 10, "fresh progress")
    assert.equal(isUnlocked(playerId), false, "no stale backup")

    // delete: the account and its player are gone
    const deleted = await pressButton(`/api/player/delete?id=${newPlayerId}`)
    assert.equal(deleted.statusCode, 302)
    assert.equal(deleted.headers.location, "/player")
    assert.equal(data.getPlayerSync(newPlayerId), null)
    assert.equal(data.getPlayerFromAccountIdSync(accountId), null)

    // the page has both buttons behind a confirmation
    const other = await signUpPlayer()
    const page = await admin.inject({ method: "GET", url: `/player/${other}` })
    assert.match(page.body, /action="\/api\/player\/reset\?id=\d+"[^>]*\n?[^>]*data-confirm="Reset this player/)
    assert.match(page.body, /action="\/api\/player\/delete\?id=\d+"/)
})

// The client throws C2284 for an armament saved above its own maximum level (most go to 5, orbs and some
// others stop at 1) and C8601 for an armament the game doesn't know.
test("developer mode never saves an armament above its maximum level", async () => {
    const data = await import("../src/data/wdfpData")
    const { getClientSerializedData } = await import("../src/data/utils")
    const { getEquipmentMaxLevelSync } = await import("../src/lib/assets")
    const playerId = await signUpPlayer()

    const pressed = await pressButton(`/api/player/developer-mode?id=${playerId}&state=on`)
    assert.ok(pressed.statusCode < 400, pressed.body)

    const stored = data.getPlayerEquipmentListSync(playerId)
    const tooHigh = Object.entries(stored).filter(([id, equipment]) => equipment.level > (getEquipmentMaxLevelSync(id) ?? 5))
    assert.deepEqual(tooHigh.map(([id]) => id), [], "stored above the maximum level")
    const unknown = Object.keys(stored).filter(id => getEquipmentMaxLevelSync(id) === null)
    assert.deepEqual(unknown, [], "armaments the game has no data for")

    // a save that already has the bad levels is repaired on the way to the client
    data.updatePlayerEquipmentSync(playerId, 100001, { level: 5 })
    const sent = getClientSerializedData(playerId, {})!.user_equipment_list as Record<string, { level: number }>
    assert.equal(sent["100001"].level, 1)
    assert.ok(Object.entries(sent).every(([id, equipment]) => equipment.level >= 1 && equipment.level <= (getEquipmentMaxLevelSync(id) ?? 5)))
})
