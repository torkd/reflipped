import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer, readCapturedRoute } from "./helpers";
import { gameRequest as coopRequest, newViewer } from "./coopHelpers";

// Co-op recruiting (src/lib/coop/recruitment.ts): share_room recruits, attention/check offers the room to other
// players in data.multi, attention/action records declines, and the AI summon wait depends on who could still join.
// Field names and types are the client's (AttentionCheckRealRemoteService, docs/coop-research.md "Recruitment").

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

const signUp = () => newViewer(fastify)
const gameRequest = (route: string, body: Record<string, unknown>) => coopRequest(fastify, route, body)

const check = (viewerId: number, holding = 0) => gameRequest("attention/check", { viewer_id: viewerId, holding_number: holding, request_number: 3 })

async function openRoom(hostId: number, questId = 1001001): Promise<string> {
    const created = await gameRequest("multi_battle_quest/create_room", { viewer_id: hostId, quest_id: questId, party_id: 11, category: 2 })
    return created.data.room_number
}

const share = (hostId: number, roomNumber: string, types: number[] = [3]) =>
    gameRequest("multi_battle_quest/share_room", { viewer_id: hostId, quest_id: 1001001, category: 2, room_number: roomNumber, share_type_list: types })

test("co-op recruiting: invitations, AI wait and declines", async (t) => {
    const { resetRecruitment } = await import("../src/lib/coop/recruitment")
    const capturedConfig = readCapturedRoute("attention_check").responseBody.data.config

    await t.test("attention/check with nothing to offer has only the captured config", async () => {
        resetRecruitment()
        const reply = await check(await signUp())
        assert.deepEqual(reply.data, { config: capturedConfig })
    })

    await t.test("nobody online: the host's AI wait is the short one", async () => {
        resetRecruitment()
        const host = await signUp()
        const shared = await share(host, await openRoom(host))
        assert.deepEqual(shared.data.config, { ...capturedConfig, summon_com_seconds: 15 })
    })

    await t.test("a player online: the long wait, and the room is offered to them once", async () => {
        resetRecruitment()
        const host = await signUp()
        const guest = await signUp()
        await check(guest) // online and free
        const roomNumber = await openRoom(host)

        const shared = await share(host, roomNumber)
        assert.equal(shared.data.config.summon_com_seconds, 60)

        const offered = await check(guest)
        assert.equal(offered.data.multi.length, 1)
        const [attention] = offered.data.multi
        assert.equal(typeof attention.attention_key, "string")
        const info = attention.quest_info
        assert.deepEqual(Object.keys(info).sort(), [
            "category_id", "establisher_character", "establisher_character_evolution_img_level", "establisher_follow",
            "establisher_rank", "host_entry_time", "quest_id", "room_number"
        ])
        assert.equal(info.room_number, roomNumber)
        assert.equal(typeof info.room_number, "string", "the client requires a String")
        assert.equal(info.quest_id, 1001001)
        assert.equal(info.category_id, 2)
        for (const key of ["establisher_character", "establisher_character_evolution_img_level", "establisher_follow", "establisher_rank"]) {
            assert.ok(Number.isInteger(info[key]), `${key} must be an Int`)
        }

        assert.equal((await check(guest, 1)).data.multi, undefined, "a room is offered once")
        assert.equal((await check(host)).data.multi, undefined, "never the host's own room")

        // a re-sent share_room (every 15 s on the client) refreshes the same recruitment
        assert.equal((await share(host, roomNumber)).data.config.summon_com_seconds, 60)
        assert.equal((await check(guest)).data.multi, undefined)
    })

    await t.test("once everyone who could join declined or let it expire, the wait is short again", async () => {
        resetRecruitment()
        const host = await signUp()
        const first = await signUp()
        const second = await signUp()
        await check(first)
        await check(second)
        const roomNumber = await openRoom(host)
        assert.equal((await share(host, roomNumber)).data.config.summon_com_seconds, 60)
        await check(first)
        await check(second)

        const declined = await gameRequest("attention/action", { viewer_id: first, priority_factors: ["Decline"] })
        assert.deepEqual(declined.data, { priority_action_score: 0, priority_playing_score: 0 })
        assert.equal((await share(host, roomNumber)).data.config.summon_com_seconds, 60, "one player can still join")

        await gameRequest("attention/action", { viewer_id: second, priority_factors: ["Expire"] })
        assert.equal((await share(host, roomNumber)).data.config.summon_com_seconds, 15)
    })

    await t.test("browsing the room list counts as online", async () => {
        resetRecruitment()
        const host = await signUp()
        const browser = await signUp()
        await gameRequest("multi_battle_quest/get_rooms", { viewer_id: browser, category_id: 2 })
        assert.equal((await share(host, await openRoom(host))).data.config.summon_com_seconds, 60)
    })

    await t.test("sharing only with follows recruits nobody (no follow system yet)", async () => {
        resetRecruitment()
        const host = await signUp()
        const guest = await signUp()
        await check(guest)
        const shared = await share(host, await openRoom(host), [1, 2])
        assert.deepEqual(shared.data.config, capturedConfig, "no summon_com_seconds: the client only auto-summons for random recruiting")
        assert.equal((await check(guest)).data.multi, undefined)
    })

    await t.test("a started room is no longer offered", async () => {
        resetRecruitment()
        const host = await signUp()
        const guest = await signUp()
        const roomNumber = await openRoom(host)
        await share(host, roomNumber)
        await gameRequest("multi_battle_quest/start", { viewer_id: host, quest_id: 1001001, category: 2, party_id: 11, room_number: roomNumber, play_id: "RECRUIT", use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: true, mate_player_ids: [] })
        assert.equal((await check(guest)).data.multi, undefined)
    })

    await t.test("attention/logger accepts the client's log batch", async () => {
        const viewer = await signUp()
        const reply = await gameRequest("attention/logger", { viewer_id: viewer, client_logs: [{ log_type: "Receive", scene_view: "Home", attention_key: "1-1", category_id: 2, quest_id: 1001001, room_number: "123456", timestamp: 1 }] })
        assert.equal(reply.data_headers.result_code, 1)
    })

    await t.test("the Settings page sets the AI waits and the client timings", async () => {
        resetRecruitment()
        const saved = await admin.inject({
            method: "POST", url: "/api/server/settings",
            payload: { "coop.companion_delay_seconds": "20", "coop.companion_delay_players_seconds": "90", "client.attention_polling_seconds": "5" }
        })
        assert.equal(saved.statusCode, 302)
        assert.equal(saved.headers.location, "/settings?message=settings_saved")
        const host = await signUp()
        assert.equal((await share(host, await openRoom(host))).data.config.summon_com_seconds, 20)
        const config = (await check(host)).data.config
        assert.equal(config.attention_polling_interval_seconds_normal, 5, "the polling interval reaches the client")
        assert.deepEqual(Object.keys(config).sort(), Object.keys(capturedConfig).sort(), "the client needs all 22 fields")

        const page = await admin.inject({ method: "GET", url: "/settings" })
        assert.equal(page.statusCode, 200)
        assert.match(page.body, /name="coop\.companion_delay_seconds" [^>]*value="20"/)
        assert.match(page.body, /name="coop\.companion_delay_players_seconds" [^>]*value="90"/)
        assert.match(page.body, /name="coop\.lobby_keepalive_seconds" type="number" min="2" max="25" [^>]*value="10"/)

        // out of range or not whole seconds: nothing is saved
        for (const bad of [{ "coop.companion_delay_seconds": "-1" }, { "coop.companion_delay_players_seconds": "601" }, { "coop.lobby_keepalive_seconds": "30" }, { "coop.companion_delay_seconds": "1.5", "client.attention_polling_seconds": "7" }]) {
            const response = await admin.inject({ method: "POST", url: "/api/server/settings", payload: bad })
            assert.equal(response.headers.location, "/settings?error=invalid_setting", JSON.stringify(bad))
        }
        assert.equal((await check(host)).data.config.attention_polling_interval_seconds_normal, 5)

        assert.equal((await admin.inject({ method: "POST", url: "/api/server/resetSettings" })).statusCode, 302)
        resetRecruitment() // the first host polled above, so it would count as a player who could join
        const again = await signUp()
        assert.equal((await share(again, await openRoom(again))).data.config.summon_com_seconds, 15)
        assert.deepEqual((await check(again)).data.config, capturedConfig)
    })
})

test("Settings presets set every performance value at once, leave gameplay alone, and the page marks the one in use", async () => {
    const { SETTING_PRESETS, SETTINGS, presetKeys } = await import("../src/data/serverSettings")
    const keys = presetKeys()
    assert.ok(!keys.includes("coop.companion_delay_seconds"), "AI waits are gameplay, not performance")
    for (const preset of SETTING_PRESETS) {
        assert.deepEqual(Object.keys(preset.values).sort(), [...keys].sort(), `${preset.id} sets exactly the performance settings`)
        for (const setting of SETTINGS.filter(setting => keys.includes(setting.key))) {
            const value = preset.values[setting.key]!
            assert.ok(value >= setting.min && value <= setting.max, `${preset.id}: ${setting.key} = ${value} is out of range`)
        }
    }

    // a gameplay change is not "custom" and survives a preset
    await admin.inject({ method: "POST", url: "/api/server/settings", payload: { "coop.companion_delay_seconds": "25" } })

    const applied = await admin.inject({ method: "POST", url: "/api/server/settingsPreset", payload: { preset: "responsive" } })
    assert.equal(applied.headers.location, "/settings?message=preset_applied")
    const viewer = await signUp()
    assert.equal((await check(viewer)).data.config.attention_polling_interval_seconds_normal, 3)
    let page = (await admin.inject({ method: "GET", url: "/settings" })).body
    assert.match(page, /Current values: <strong[^>]*>Responsive</)
    assert.match(page, /name="coop\.companion_delay_seconds" [^>]*value="25"/, "the preset kept the gameplay value")

    // one value off a preset: custom, based on that preset, which offers to re-apply itself
    await admin.inject({ method: "POST", url: "/api/server/settings", payload: { "coop.lobby_keepalive_seconds": "7" } })
    page = (await admin.inject({ method: "GET", url: "/settings" })).body
    assert.match(page, /Current values: <strong[^>]*>Custom, based on Responsive \(1 change\)</)
    assert.match(page, /badge-off">modified</)
    assert.match(page, /Re-apply Responsive/)
    assert.match(page, /chip-custom">custom<\/span><span class="chip">Responsive: 5 s</)

    await admin.inject({ method: "POST", url: "/api/server/settingsPreset", payload: { preset: "balanced" } })
    assert.deepEqual((await check(viewer)).data.config, readCapturedRoute("attention_check").responseBody.data.config,
        "Balanced is the original server's config")

    const unknown = await admin.inject({ method: "POST", url: "/api/server/settingsPreset", payload: { preset: "turbo" } })
    assert.equal(unknown.headers.location, "/settings?error=unknown_preset")
    await admin.inject({ method: "POST", url: "/api/server/resetSettings" })
})

test("the server clock runs on from the time it was set, and keeps running across a restart", async () => {
    const { setServerTime, getServerDate } = await import("../src/utils")
    const { getStoredText } = await import("../src/data/serverSettings")
    const previous = process.env.SERVER_CLOCK
    process.env.SERVER_CLOCK = "ticking"
    try {
        setServerTime(new Date("2025-01-03T12:00:00Z"))
        const stored = JSON.parse(getStoredText("clock.anchor") ?? "null")
        assert.equal(stored.date, "2025-01-03T12:00:00.000Z", "the anchor is stored for the next start")
        await new Promise(resolve => setTimeout(resolve, 1100))
        const elapsed = getServerDate().getTime() - Date.parse("2025-01-03T12:00:00Z")
        assert.ok(elapsed >= 1000 && elapsed < 5000, `the clock ran ${elapsed} ms`)
    } finally {
        setServerTime(null)
        process.env.SERVER_CLOCK = previous
    }
})
