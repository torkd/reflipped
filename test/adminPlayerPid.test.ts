import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer } from "./helpers";

// ADM-3: the admin site shows each player's PID (the account number the game's Account Info shows) next to the
// player number, the Players list finds a player by either or by name, and a save can be attached by its PID.

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let users: typeof import("../src/data/users")
let playerId: number
let pid: number

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    users = await import("../src/data/users")
    // accounts without a player push the account numbers ahead of the player numbers
    for (let i = 0; i < 3; i++) {
        const deviceId = randomUUID()
        const login = await fastify.inject({
            method: "POST", url: "/openapi/service/v4/auth/loginDevice",
            headers: { "content-type": "application/json" },
            payload: { appId: "561429", deviceId, serialNo: deviceId, whiteKey: randomUUID() }
        })
        assert.equal(login.statusCode, 200, login.body)
    }
    const player = await createTestPlayer(fastify)
    pid = (await data.getSession(String(player.viewerId)))!.accountId
    playerId = data.getPlayerFromAccountIdSync(pid)!.id
    assert.notEqual(pid, playerId)
    data.updatePlayerSync({ id: playerId, name: "Pidfinder" })
})

after(async () => {
    await cleanup()
})

function adminGet(url: string) {
    return admin.inject({ method: "GET", url, headers: { host: "127.0.0.1:8001" } })
}

function adminPost(url: string, form: Record<string, string>) {
    return admin.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded", host: "127.0.0.1:8001", "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:8001" },
        payload: new URLSearchParams(form).toString()
    })
}

test("the Players list and the player page show the PID", async () => {
    const list = await adminGet("/player")
    assert.equal(list.statusCode, 200)
    assert.match(list.body, new RegExp(`PID ${pid} · last login`))
    const page = await adminGet(`/player/${playerId}`)
    assert.match(page.body, new RegExp(`Player #${playerId} · PID ${pid} · last login`))
})

test("the Players list finds a player by PID, player number or part of the name", async () => {
    for (const q of [String(pid), String(playerId), "pidfind"]) {
        const body = (await adminGet(`/player?q=${encodeURIComponent(q)}`)).body
        assert.match(body, new RegExp(`href="/player/${playerId}"`), q)
        assert.match(body, /1 of \d+ players? matches the search\./, q)
    }
    const none = (await adminGet("/player?q=nobody-here")).body
    assert.doesNotMatch(none, new RegExp(`href="/player/${playerId}"`))
    assert.match(none, /No player matches/)
})

test("the search shows only in the search box, escaped", async () => {
    const body = (await adminGet(`/player?q=${encodeURIComponent("<b>x</b>")}`)).body
    assert.doesNotMatch(body, /<b>x<\/b>/)
    assert.equal(body.split("&lt;b&gt;x&lt;/b&gt;").length - 1, 1, "once, as the box's value")
    assert.match(body, /value="&lt;b&gt;x&lt;\/b&gt;"/)
})

test("a name made of digits is found by name too", async () => {
    const digits = await createTestPlayer(fastify)
    const id = data.getPlayerFromAccountIdSync((await data.getSession(String(digits.viewerId)))!.accountId)!.id
    data.updatePlayerSync({ id, name: "777000" })
    assert.match((await adminGet("/player?q=7770")).body, new RegExp(`href="/player/${id}"`))
})

test("a save is attached by its PID; a PID without a save is refused", async () => {
    const user = users.createUserSync({ username: "pidattach", passwordHash: "x" })!
    const missing = await adminPost(`/api/user/save/attach?id=${user.id}`, { playerId: "999999", idKind: "pid" })
    assert.equal(missing.headers.location, `/user/${user.id}?error=save-unknown`)

    const attached = await adminPost(`/api/user/save/attach?id=${user.id}`, { playerId: String(pid), idKind: "pid" })
    assert.equal(attached.headers.location, `/user/${user.id}?message=save-attached`)
    assert.deepEqual(users.getUserAccountIdsSync(user.id), [pid])
    const page = (await adminGet(`/user/${user.id}`)).body
    assert.match(page, new RegExp(`Player #${playerId} \\(Pidfinder\\), PID ${pid}\\.`))
})

test("the attach form names the save before anything changes", async () => {
    const user = users.createUserSync({ username: "pidconfirm", passwordHash: "x" })!
    const other = await createTestPlayer(fastify)
    const otherPid = (await data.getSession(String(other.viewerId)))!.accountId
    const otherPlayer = data.getPlayerFromAccountIdSync(otherPid)!.id
    data.updatePlayerSync({ id: otherPlayer, name: "Confirmed" })

    // by PID: the page names the save and posts its player number; nothing is attached yet
    const page = await adminGet(`/user/${user.id}/attach?playerId=${otherPid}&idKind=pid`)
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Confirmed/)
    assert.match(page.body, new RegExp(`Player #${otherPlayer} · PID ${otherPid}`))
    assert.match(page.body, /It becomes pidconfirm's save/)
    assert.match(page.body, new RegExp(`name="playerId" value="${otherPlayer}"`))
    assert.match(page.body, /name="idKind" value="player"/)
    assert.deepEqual(users.getUserAccountIdsSync(user.id), [])

    // the same number read as a player number is another save, or none
    const asPlayer = await adminGet(`/user/${user.id}/attach?playerId=${otherPid}&idKind=player`)
    if (asPlayer.statusCode === 200) assert.doesNotMatch(asPlayer.body, new RegExp(`Player #${otherPlayer} ·`))
    else assert.equal(asPlayer.headers.location, `/user/${user.id}?error=save-unknown`)

    // with a save already: the page says it is replaced
    await adminPost(`/api/user/save/attach?id=${user.id}`, { playerId: String(otherPlayer) })
    const second = await createTestPlayer(fastify)
    const secondPid = (await data.getSession(String(second.viewerId)))!.accountId
    const replacing = (await adminGet(`/user/${user.id}/attach?playerId=${secondPid}&idKind=pid`)).body
    assert.match(replacing, new RegExp(`It replaces pidconfirm's save, Confirmed \\(player #${otherPlayer}, PID ${otherPid}\\)`))
})

test("the confirmation page sends back what can't be attached", async () => {
    const user = users.createUserSync({ username: "pidrefuse", passwordHash: "x" })!
    for (const [query, location] of [
        ["playerId=999999&idKind=pid", "error=save-unknown"],
        ["playerId=abc", "error=save-unknown"],
        ["", "error=save-unknown"]
    ]) {
        const response = await adminGet(`/user/${user.id}/attach?${query}`)
        assert.equal(response.headers.location, `/user/${user.id}?${location}`, query)
    }
    // a save of another user (the one attached in the PID test), and the user's own
    const owned = users.getUserAccountIdsSync(users.getUserByUsernameSync("pidattach")!.id)[0]
    assert.equal((await adminGet(`/user/${user.id}/attach?playerId=${owned}&idKind=pid`)).headers.location, `/user/${user.id}?error=save-other-user`)
    const ownerId = users.getUserByUsernameSync("pidattach")!.id
    assert.equal((await adminGet(`/user/${ownerId}/attach?playerId=${owned}&idKind=pid`)).headers.location, `/user/${ownerId}?message=save-already`)
})
