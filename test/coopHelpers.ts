// Shared helpers for the co-op tests: a socket client speaking the XMLSocket framing, the lobby mate the client sends,
// signed-up players and game requests. Message shapes follow docs/coop-protocol.md (enums are [index, ...args]).
import assert from "node:assert/strict";
import net from "net";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, decodeGameBody, encodeGameBody } from "./helpers";

export const apiPrefix = "/latest/api/index.php"

/** A socket client speaking the XMLSocket framing: JSON + NUL. */
export class Client {
    private socket!: net.Socket
    private buffer = Buffer.alloc(0)
    private queue: any[] = []
    private waiters: ((value: any) => void)[] = []

    /** `localAddress`: connect from another loopback address (127.0.0.2, …), as a phone that changed networks */
    async connect(port: number, localAddress?: string) {
        this.socket = net.connect({ port, host: "127.0.0.1", localAddress })
        await new Promise<void>((resolve, reject) => {
            this.socket.once("connect", () => resolve())
            this.socket.once("error", reject)
        })
        this.socket.on("data", chunk => {
            this.buffer = Buffer.concat([this.buffer, chunk])
            let end: number
            while ((end = this.buffer.indexOf(0)) !== -1) {
                const value = JSON.parse(this.buffer.subarray(0, end).toString("utf8"))
                this.buffer = this.buffer.subarray(end + 1)
                const waiter = this.waiters.shift()
                if (waiter) waiter(value)
                else this.queue.push(value)
            }
        })
    }

    send(value: unknown) {
        this.socket.write(JSON.stringify(value) + "\0")
    }

    next(timeoutMs = 2000): Promise<any> {
        if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timed out waiting for a socket message")), timeoutMs)
            this.waiters.push(value => { clearTimeout(timer); resolve(value) })
        })
    }

    /** Nothing arrives within `ms`. */
    async silent(ms = 150): Promise<boolean> {
        if (this.queue.length > 0) return false
        await new Promise(resolve => setTimeout(resolve, ms))
        return this.queue.length === 0
    }

    isOpen(): boolean {
        return !this.socket.destroyed && !this.socket.readableEnded
    }

    close() {
        this.socket.destroy()
    }
}

/** The lobby mate a client sends in Enter / ChangeParty, with one leader character. */
export function lobbyMate(name: string, characterId: number, options: { rank?: number, evolutionLevel?: number } = {}) {
    return {
        allowHealFromOtherPlayers: true, autoSpeedLevel: 0, autoStart: false, autoplayMode: false, autoskillMode: 0,
        comId: null, connectionId: "", dashBehaviorMode: 0, degreeId: 0, entryTime: 0, name,
        party: {
            abilitySoulIds: [], equipments: [], unison_characters: [], options: null,
            characters: [[0, { id: characterId, evolution_level: options.evolutionLevel ?? 0, exp: 0, mana_node_ids: [], over_limit_step: 0, ex_boost: [1], illustration_settings: [1] }]]
        },
        playerRoleKind: 0, rank: options.rank ?? 1, skillAbilityBehaviorMode: 0, state: [0], viewerId: 0
    }
}

/** A new signed-up player's viewer id. */
export async function newViewer(fastify: FastifyInstance): Promise<number> {
    return (await createTestPlayer(fastify)).viewerId
}

/** A game API request (the test server only logs unsigned requests); asserts a 200 and returns the decoded reply. */
export async function gameRequest(fastify: FastifyInstance, route: string, body: Record<string, unknown>): Promise<any> {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeGameBody(body)
    })
    assert.equal(response.statusCode, 200, `${route}: ${response.body}`)
    return decodeGameBody(response.body)
}

/**
 * Lobby handshake + Enter; returns the client, its connection id and the Welcome. The socket takes only players a route
 * admitted (SEC-12), so this admits the viewer itself; test/coopAdmission.test.ts covers the routes' admissions.
 */
export async function enterLobby(port: number, viewerId: number, roomNumber: string, name: string, mate = lobbyMate(name, 111)) {
    const { admit, getRoom } = await import("../src/lib/coop/rooms")
    const room = getRoom(roomNumber)
    if (room) admit(room, viewerId)
    const client = new Client()
    await client.connect(port)
    client.send({ reconnected: 0, socklet: "cooperation_room", viewerId, roomNumber, questCategory: 2, questId: 1001001 })
    const accept = await client.next()
    assert.equal(accept[0], 0, `${name} accepted: ${JSON.stringify(accept)}`)
    client.send([0, [0, mate, 1]])
    const welcome = await client.next()
    assert.deepEqual([welcome[0], welcome[1][0]], [1, 0], "Welcome")
    return { client, id: accept[1] as string, welcome }
}

/** Battle handshake with the lobby's connection id. */
export async function enterBattle(port: number, connectionId: string, roomNumber: string) {
    const client = new Client()
    await client.connect(port)
    client.send({ reconnected: 0, socklet: "cooperation_battle", connectionId, roomNumber })
    assert.equal((await client.next())[0], 0, "battle Accept")
    return client
}
