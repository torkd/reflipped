import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";

test("real HTTP title responses finish once without duplicate headers or implicit replies", async () => {
    const fixture = await createTestServer()
    const player = await createTestPlayer(fixture.fastify)
    const { buildServer } = await import("../src/app")
    const lines: string[] = []
    const stream = new Writable({ write(chunk, _encoding, done) {
        lines.push(...chunk.toString().split("\n").filter(Boolean))
        done()
    } })
    const app = buildServer({ paramCheck: "off", logger: { level: "info", stream } })
    const previous = process.env.SERVER_CLOCK
    process.env.SERVER_CLOCK = "running"
    try {
        const address = await app.listen({ port: 0, host: "127.0.0.1" })
        const post = async (route: string, body: Record<string, unknown>) => {
            const response = await fetch(`${address}/latest/api/index.php/${route}`, {
                method: "POST", headers: gameHeaders(player.udid), body: encodeGameBody(body), signal: AbortSignal.timeout(5000)
            })
            const text = await response.text()
            assert.equal(response.status, 200, text)
            assert.match(response.headers.get("content-type") ?? "", /application\/x-msgpack/)
            assert.equal(decodeGameBody(text).data_headers.result_code, 1)
        }
        for (let i = 0; i < 2; i++) {
            await post("asset/version_info", { viewer_id: player.viewerId })
            await post("load", { ...readCapturedRoute("load").requestBody, viewer_id: player.viewerId, access_token: player.zat })
        }
        await app.close()
        assert.doesNotMatch(lines.join("\n"), /ERR_HTTP_HEADERS_SENT|FST_ERR_REP_ALREADY_SENT|Reply was already sent/)
        const completions = lines.map(line => JSON.parse(line)).filter(line => line.msg === "request completed")
        assert.equal(completions.length, 4)
        assert.ok(completions.every(line => line.res.statusCode === 200))
    } finally {
        await app.close()
        process.env.SERVER_CLOCK = previous
        await fixture.cleanup()
    }
})
