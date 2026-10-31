import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders } from "./helpers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

test("a news item's html has the html/body the game's renderer requires (C7606 otherwise)", async () => {
    const player = await createTestPlayer(fastify)
    const response = await fastify.inject({
        method: "POST",
        url: "/latest/api/index.php/news/get_info",
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ api_count: 1, viewer_id: player.viewerId, news_id: 7 })
    })
    assert.equal(response.statusCode, 200)
    const data = decodeGameBody(response.body).data
    assert.equal(data.id, 7)
    assert.match(data.html, /^<html><body>.*<\/body><\/html>$/s)
})
