// FT-2: the unit poll (character election 1, 2022-12-28 to 2023-01-08, Japan time). One vote per player, during the
// period only (result code 11003 outside it); a vote counts for mission 2389 ("Vote in the WF Unit Poll", pattern 65).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const ELECTION = 1
const DURING = "2023-01-02T03:00:00Z"
const AFTER = "2023-01-20T03:00:00Z"
const VOTE_MISSION = 2389

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

async function setClock(date: string) {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(date))
}

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    return { statusCode: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : response.body }
}

test("a player votes once during the poll, and the vote counts for its mission", async () => {
    await setClock(DURING)
    const player = await createTestPlayer(fastify)
    assert.equal((await post(player, "character_election/get_vote_status", { election_id: ELECTION })).body.data.is_voted, false)

    const voted = await post(player, "character_election/vote", { election_id: ELECTION, keyword_id: 1000001 })
    assert.equal(voted.statusCode, 200)
    const cleared = voted.body.data.mission_info as { mission_id: number }[]
    assert.ok(cleared.some(info => info.mission_id === VOTE_MISSION), "mission 2389 cleared")

    assert.equal((await post(player, "character_election/get_vote_status", { election_id: ELECTION })).body.data.is_voted, true)
    assert.equal((await post(player, "character_election/vote", { election_id: ELECTION, keyword_id: 2000001 })).statusCode, 400)
})

test("outside the poll: result code 11003", async () => {
    await setClock(AFTER)
    const player = await createTestPlayer(fastify)
    const status = await post(player, "character_election/get_vote_status", { election_id: ELECTION })
    assert.equal(status.body.data_headers.result_code, 11003)
    const vote = await post(player, "character_election/vote", { election_id: ELECTION, keyword_id: 1000001 })
    assert.equal(vote.body.data_headers.result_code, 11003)
})
