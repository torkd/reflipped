import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";
import { pack, unpack } from "msgpackr";
import { admit, admitToBattle, CoopRoom, createRoom, getRoom, getRoomByAccessToken, listRooms, noteRoundEnded, openRound, roomsHostedBy, startRound, TooManyRoomsError } from "../../lib/coop/rooms";
import { coopSocketPort, coopSocketServer, ROOM_CAPACITY } from "../../lib/coop/socketServer";
import { COMPANION_NAMES, balancedCompanions, toMateParty } from "../../lib/coop/companions";
import { any, arrayOf, boolean, gameBody, integer, number, string, stringOrInteger } from "../schemas";
import { markActiveQuestCoop, statisticsSchema } from "./singleBattleQuest";
import { computeRequestParam } from "../../lib/gameAuth";
import { joinCandidates, notePresence, SHARE_TYPE_RANDOM, shareRoom, stopRecruiting } from "../../lib/coop/recruitment";
import { attentionConfig } from "../../lib/coop/attentionConfig";
import { closeRoom } from "../../lib/coop/closeRoom";
import { establisherOf, FOLLOW_STATE_NONE } from "../../lib/coop/mates";

interface GetRoomsBody {
    event_id: number,
    viewer_id: number,
    category_id: number
}

const getRoomsSchema = gameBody({ event_id: integer, category_id: integer }, ["category_id"])

interface CreateRoomBody {
    viewer_id: number,
    quest_id: number,
    party_id: number,
    category: number
}

const createRoomSchema = gameBody({ quest_id: integer, party_id: integer, category: integer }, ["quest_id", "party_id", "category"])

interface PrepareBody {
    viewer_id: number,
    quest_id: number,
    /** the room is named by its number or, for a room known only by its link, by `access_token` */
    room_number?: string,
    access_token?: string,
    category: number
}

const prepareSchema = gameBody({ quest_id: integer, room_number: stringOrInteger, access_token: string, category: integer }, ["quest_id", "category"])

interface ShareRoomBody {
    viewer_id: number,
    quest_id: number,
    category: number,
    room_number: string,
    /** who may see the room, e.g. [3]; meanings not mapped yet */
    share_type_list: number[]
}

const shareRoomSchema = gameBody({
    quest_id: integer,
    category: integer,
    room_number: stringOrInteger,
    share_type_list: arrayOf(integer)
}, ["quest_id", "category", "room_number", "share_type_list"])


// room_number, or access_token when the player came through a room link (RoomIdKind.AccessToken)
const selectRoomSchema = gameBody({
    party_id: integer,
    room_number: stringOrInteger,
    access_token: string,
    quest_id: integer,
    accepted_type: integer,
    category: integer,
    api_count: integer
}, ["party_id", "quest_id", "category"])

// a room link was opened (wdfp://social-room?k=<access_token>)
const verifyAccessTokenSchema = gameBody({ access_token: string }, ["access_token"])



interface SummonBody {
    viewer_id: number,
    category_id: number,
    room_number: string,
    quest_id: number
}

const summonSchema = gameBody({
    category_id: integer,
    room_number: stringOrInteger,
    quest_id: integer
}, ["category_id", "room_number", "quest_id"])


/** Players per co-op room, AI companions included. */

interface StartBody {
    viewer_id: number,
    quest_id: number,
    category: number,
    party_id: number,
    room_number: string,
    play_id: string,
    use_boost_point: boolean,
    use_boss_boost_point: boolean,
    is_auto_start_mode: boolean,
    /** per-player ids of the other mates in the room, e.g. [1, 2] */
    mate_player_ids: number[]
}

const startSchema = gameBody({
    quest_id: integer,
    category: integer,
    party_id: integer,
    room_number: stringOrInteger,
    play_id: string,
    use_boost_point: boolean,
    use_boss_boost_point: boolean,
    is_auto_start_mode: boolean,
    mate_player_ids: arrayOf(integer),
    client_battle_party: any
}, ["quest_id", "category", "party_id", "room_number"])

interface FinishBody {
    viewer_id: number,
    quest_id: number,
    category: number,
    score: number,
    add_mana: number,
    elapsed_time_ms: number,
    is_accomplished: boolean,
    /** per mate: {viewer_id, com_id, score, contribution_score} */
    mate_player_result: unknown[]
}

const finishSchema = gameBody({
    quest_id: integer,
    category: integer,
    score: number,
    add_mana: integer,
    elapsed_time_ms: integer,
    is_accomplished: boolean,
    is_restored: boolean,
    continue_count: integer,
    play_id: string,
    contribution_score: number,
    mate_player_result: arrayOf(any),
    statistics: statisticsSchema,
    api_count: integer,
    reproduce_log_data: any
}, ["quest_id", "category", "score", "statistics"])

interface DisbandRoomBody {
    viewer_id: number,
    room_number: string
}

const disbandRoomSchema = gameBody({ room_number: stringOrInteger, api_count: integer }, ["room_number"])

const abortSchema = gameBody({
    category: integer,
    room_number: stringOrInteger,
    quest_id: integer,
    play_id: string,
    finish_kind: integer,
    statistics: any,
    api_count: integer
})

// buying a continue (rebirth) after Game Over; no capture, so only the fields single_battle_quest/play_continue reads
const playContinueSchema = gameBody({
    category: integer,
    room_number: stringOrInteger,
    quest_id: integer,
    play_id: string,
    payment_type: integer,
    statistics: any,
    api_count: integer
})

// no capture yet; the handler copes with missing fields (no match, so the client is told the room is gone)
const restoreRoomSchema = gameBody({ room_number: stringOrInteger, room_sequence: integer })

const searchRoomSchema = gameBody({ room_number: stringOrInteger })

interface SelectRoomBody {
    viewer_id: number,
    party_id: number,
    room_number?: string,
    access_token?: string,
    quest_id: number,
    accepted_type?: number,
    category: number
}

/**
 * select_room `accepted_type`: how the player reached the room (RoomAcceptedType in the client). Only Rejoin changes
 * what the server does.
 */
const ACCEPTED_TYPE = { Host: 1, Attention: 2, RoomNumber: 3, Link: 4, RoomList: 5, Rejoin: 6 }

/** The room a request names: by `access_token` (room links) or by `room_number`. */
function requestedRoom(body: { room_number?: string | number, access_token?: string }): CoopRoom | undefined {
    if (body.access_token) return getRoomByAccessToken(body.access_token)
    return body.room_number === undefined ? undefined : getRoom(String(body.room_number))
}

/** Where a room link points: the page the shared link opens (src/routes/api/multiInvitation.ts). */
function roomUrl(request: FastifyRequest, room: CoopRoom): string {
    // the client keeps only the part from "/multi_invitation/join" on and puts its own urlFriendFollowServer +
    // "/latest/api/index.php" in front (the room scene's shareUrl), so the host here only matters to other clients
    return `${request.protocol}://${request.host}/latest/api/index.php/multi_invitation/join?k=${room.accessToken}`
}

/**
 * Runs a single_battle_quest route internally with the same body, encoded like a client request
 * (base64 msgpack). Co-op battles reuse the single-player quest logic: start registers the active
 * quest, finish computes rewards, experience, drops and missions. Returns the decoded reply.
 */
/** select_room `raising_state` values, from the client's selectRoomSuccessHandler. */
const RAISING_STATE = { Ready: 1, Filled: 3, Battle: 4, Disbanded: 9 }

/** Room codes may be typed with spaces or dashes. */
function normaliseRoomNumber(text: string): string {
    return text.replace(/\D/g, "")
}

/** A get_rooms entry (pinball.remote.multiBattleQuest.RoomInformation), from the host's lobby mate. */
function roomInformation(room: CoopRoom) {
    const establisher = establisherOf(coopSocketServer?.hostMate(room.roomNumber) ?? null)
    return {
        "room_number": room.roomNumber,
        "category_id": room.category,
        "quest_id": room.questId,
        "establisher_name": establisher.name,
        "establisher_character": establisher.characterId,
        "establisher_character_evolution_img_level": establisher.evolutionLevel,
        "establisher_follow": FOLLOW_STATE_NONE,
        "host_entry_time": room.createdAt,
        "is_pickup": false,
        "mates": Math.max(1, coopSocketServer?.memberCount(room.roomNumber) ?? 1),
        "raising_state": RAISING_STATE.Ready
    }
}

/** What a failed inner single_battle_quest reply logs: its status and error, never the reply's game data (OPS-2). */
function failureSummary(single: { statusCode: number, body: any }) {
    return {
        statusCode: single.statusCode,
        error: single.body?.error,
        message: single.body?.message,
        resultCode: single.body?.data_headers?.result_code
    }
}

async function runSingleBattleQuestRoute(fastify: FastifyInstance, request: FastifyRequest, route: "start" | "finish" | "abort" | "play_continue", body: unknown): Promise<{ statusCode: number, body: any }> {
    // signed like a client request, since the game auth hook checks PARAM (PARAM_CHECK=enforce by default); the
    // outer request already passed that check with this UDID
    const url = `/latest/api/index.php/single_battle_quest/${route}`
    const udid = String(request.headers["udid"] ?? "")
    const viewerId = request.viewer.viewerId
    const payload = pack(body).toString("base64")
    const response = await fastify.inject({
        method: "POST",
        url,
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            "udid": udid,
            "game-app-id": String(viewerId),
            "param": computeRequestParam(udid, viewerId, url, payload)
        },
        payload
    })
    let decoded: any = response.body
    try {
        decoded = unpack(Buffer.from(response.body, "base64"))
    } catch {
        // error replies are plain JSON
    }
    return { statusCode: response.statusCode, body: decoded }
}

/**
 * Host the co-op socket is reached at: COOP_PUBLIC_HOST, or else the host the client used to
 * reach this API (the same machine, as the client sees it).
 */
function coopSocketHost(request: FastifyRequest): string {
    return process.env.COOP_PUBLIC_HOST || request.hostname
}

const routes = async (fastify: FastifyInstance) => {
    // Host flow, as captured: create_room → prepare → select_room → co-op socket (docs/coop-research.md).
    fastify.post("/create_room", { schema: createRoomSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CreateRoomBody
        const viewerId = request.viewer.viewerId

        // one room per host: a host who creates another has left the old one (and can't fill the room registry)
        for (const old of roomsHostedBy(viewerId)) closeRoom(old.roomNumber)
        let room: CoopRoom
        try {
            room = createRoom(viewerId, Number(body.quest_id), Number(body.category))
        } catch (error) {
            if (!(error instanceof TooManyRoomsError)) throw error
            request.log.warn(error.message)
            return reply.status(503).send({ "error": "Service Unavailable", "message": "Too many co-op rooms are open." })
        }
        admit(room, viewerId, request.viewer.playerId)
        request.log.info({ roomNumber: room.roomNumber, questId: room.questId, category: room.category }, "co-op room created")

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                // with room_number the client names the room by number; access_token alone would make a room known
                // only by its link (createRoomSuccessHandler). The link carries the token.
                "room_number": room.roomNumber,
                "room_url": roomUrl(request, room)
            }
        })
    })

    fastify.post("/prepare", { schema: prepareSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PrepareBody
        const viewerId = request.viewer.viewerId

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": []
        })
    })

    // "Open for others": the host makes the room visible to other players.
    fastify.post("/share_room", { schema: shareRoomSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ShareRoomBody
        const viewerId = request.viewer.viewerId

        const room = getRoom(String(body.room_number))
        if (!room || room.hostViewerId !== viewerId) return reply.status(400).send({ "error": "Bad Request", "message": "Room not found." })
        // The share dialog sends random players (3) and follows (1, 2) in separate calls, so keep them all.
        const shareTypes = Array.isArray(body.share_type_list) ? body.share_type_list.map(Number) : []
        room.shareTypes = [...new Set([...room.shareTypes, ...shareTypes])]

        reply.header("content-type", "application/x-msgpack")
        // Follows (1, 2) aren't implemented: nobody to notify. The client only recruits and auto-summons for 3.
        if (!shareTypes.includes(SHARE_TYPE_RANDOM)) return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": { "config": attentionConfig() }
        })

        // Recruiting random players (the host's client re-sends this every 15 s while a slot is free): other players are
        // offered the room through attention/check. The reply's summon_com_seconds is how long the host's client waits
        // before it summons AI companions: longer while somebody who could join is online (admin settings; see
        // src/lib/coop/recruitment.ts). The server fills the room itself a little later if the client doesn't.
        const summonSeconds = shareRoom(room, count => {
            const hostMate = coopSocketServer?.hostMate(room.roomNumber) ?? null
            return balancedCompanions(hostMate, count, room.roomSequence * 10 + 1).map((companion, i) => ({
                comId: companion.com_id,
                degreeId: companion.degree_id,
                name: COMPANION_NAMES[(room.roomSequence + i) % COMPANION_NAMES.length],
                party: toMateParty(companion.party),
                rank: companion.rank
            }))
        })
        request.log.info({ roomNumber: room.roomNumber, summonSeconds, candidates: joinCandidates(room) }, "co-op room recruiting")

        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": { "config": { ...attentionConfig(), "summon_com_seconds": summonSeconds } }
        })
    })

    // "Summon": fill the empty slots with AI companions. The client then sends
    // Notify(EnterComs(...)) over the co-op socket (docs/coop-research.md).
    fastify.post("/summon", { schema: summonSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SummonBody
        const viewerId = request.viewer.viewerId

        const room = getRoom(String(body.room_number))
        if (!room) return reply.status(400).send({ "error": "Bad Request", "message": "Room not found." })

        const humans = coopSocketServer?.humanCount(room.roomNumber) ?? 1
        const free = Math.max(0, ROOM_CAPACITY - humans)
        const hostMate = coopSocketServer?.hostMate(room.roomNumber) ?? null
        const data: Record<string, any> = {}
        balancedCompanions(hostMate, free, room.roomSequence * 10 + 1).forEach((companion, i) => {
            data[`mate${i + 1}`] = companion
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": data
        })
    })

    // Called by every player when the room's battle starts (after the lobby's Start message).
    // Mirrors single_battle_quest/start: no stamina is charged yet.
    fastify.post("/start", { schema: startSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as StartBody
        const viewerId = request.viewer.viewerId

        // only a player the room let in marks it started (and stops its recruiting)
        const room = getRoom(String(body.room_number))
        if (room?.members.has(viewerId)) {
            // the lobby's StartBattle normally began the round (with its players); without it, the first start does
            if (!room.inBattle) startRound(room, [])
            if (!room.lastRoundViewerIds.includes(viewerId)) room.lastRoundViewerIds.push(viewerId)
            stopRecruiting(room.roomNumber)
            // the client opens its battle socket right after this reply: a signed proof that it is this player's
            admitToBattle(room, viewerId)
        }
        request.log.info({ roomNumber: body.room_number, questId: body.quest_id, playId: body.play_id }, "co-op battle started")

        // register the quest like a single-player start, so finish can award it
        const single = await runSingleBattleQuestRoute(fastify, request, "start", body)
        if (single.statusCode !== 200) request.log.warn(failureSummary(single), "co-op start: single_battle_quest/start failed")
        // the finish then counts the co-op missions (host or guest) instead of the solo ones
        else markActiveQuestCoop(request.viewer.playerId, room?.hostViewerId === viewerId)

        const dataHeaders = generateDataHeaders({ viewer_id: viewerId })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": dataHeaders,
            "data": {
                "user_info": {},
                "category_id": Number(body.category),
                "is_multi": "multi",
                "start_time": dataHeaders["servertime"],
                "quest_name": "",
                "mail_arrived": false
            }
        })
    })

    // End of a co-op battle: rewards come from the single-player finish logic.
    fastify.post("/finish", { schema: finishSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as FinishBody
        const viewerId = request.viewer.viewerId

        noteRoundEnded(viewerId)
        const single = await runSingleBattleQuestRoute(fastify, request, "finish", body)
        if (single.statusCode !== 200 || !single.body?.data) {
            request.log.warn(failureSummary(single), "co-op finish: single_battle_quest/finish failed")
            return reply.status(single.statusCode === 200 ? 500 : single.statusCode).send(single.body)
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": single.body.data_headers,
            "data": {
                // co-op-only fields first, so the single-player values win where both exist
                "joined_character_id_list": [],
                "follow_info": [],
                "bond_token_status_list": {},
                // the single-player finish below fills mission_info and mail_arrived
                "mission_info": [],
                "mail_arrived": false,
                ...single.body.data,
                "is_multi": "multi"
            }
        })
    })

    // A lost or abandoned co-op battle (finish_kind, statistics, ...). Mirrors
    // single_battle_quest/abort: drops the active quest, no rewards.
    fastify.post("/abort", { schema: abortSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number, category?: number, room_number?: string | number }
        const viewerId = request.viewer.viewerId

        noteRoundEnded(viewerId)
        const room = body.room_number === undefined ? undefined : getRoom(String(body.room_number))
        const category = Number(body.category ?? room?.category ?? 0)
        const single = await runSingleBattleQuestRoute(fastify, request, "abort", { ...body, category })
        if (single.statusCode !== 200) request.log.warn(failureSummary(single), "co-op abort: single_battle_quest/abort failed")

        const dataHeaders = generateDataHeaders({ viewer_id: viewerId })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": dataHeaders,
            "data": {
                "user_info": single.body?.data?.user_info ?? {},
                "category_id": category,
                "is_multi": "multi",
                // the game clock, like start's start_time (the client keeps it with the drawn-quest data, not for the
                // result screen)
                "start_time": dataHeaders["servertime"],
                "quest_name": "",
                "mail_arrived": false
            }
        })
    })

    // A player buys a continue (rebirth) after Game Over: 50 beads, charged by the single-player route against the
    // quest start registered. The client says nothing else on the wire (the other players' units are healed by
    // the clients themselves); without this route it showed H404 and returned to the title screen.
    fastify.post("/play_continue", { schema: playContinueSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number, category?: number, room_number?: string | number }
        const viewerId = request.viewer.viewerId

        const room = body.room_number === undefined ? undefined : getRoom(String(body.room_number))
        const category = Number(body.category ?? room?.category ?? 0)
        const single = await runSingleBattleQuestRoute(fastify, request, "play_continue", { ...body, category })
        if (single.statusCode !== 200) return reply.status(single.statusCode).send(single.body)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": single.body?.data?.user_info ?? {},
                "is_multi": "multi",
                "mail_arrived": false
            }
        })
    })

    // The host closes the room (also called after a battle). Idempotent: the client retries it.
    fastify.post("/disband_room", { schema: disbandRoomSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as DisbandRoomBody
        const viewerId = request.viewer.viewerId

        const roomNumber = String(body.room_number)
        const room = getRoom(roomNumber)
        if (room && room.hostViewerId === viewerId) closeRoom(roomNumber)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": []
        })
    })

    // After a restart the game rejoins the room it was in (it saves room_number and room_sequence locally) and sends
    // them here. Without this route every launch got a 404 and the game never got out of that restore.
    // The reply is read by restoreSuccessHandler: ip_address, port and raising_state, where 1 = back into the room
    // and 9 = the room is gone, which sends the player on to the home screen. A room that no longer exists (the
    // server restarted, the host disbanded it) or whose number has been reused (another room_sequence) is gone.
    fastify.post("/restore_room", { schema: restoreRoomSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { room_number: string, room_sequence: number }
        const viewerId = request.viewer.viewerId

        const room = getRoom(String(body.room_number))
        const sameRoom = room !== null && room !== undefined && Number(body.room_sequence) === room.roomSequence
        if (sameRoom && room.members.has(viewerId)) admit(room, viewerId, request.viewer.playerId)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "room_number": String(body.room_number),
                "ip_address": coopSocketHost(request),
                "port": coopSocketPort(),
                "raising_state": sameRoom ? RAISING_STATE.Ready : RAISING_STATE.Disbanded
            }
        })
    })

    fastify.post("/select_room", { schema: selectRoomSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SelectRoomBody
        const viewerId = request.viewer.viewerId

        // raising_state tells the client what to do (selectRoomSuccessHandler):
        // 1 = join, 3 = full, 4 = battle already started, 9 = disbanded
        const room = requestedRoom(body)

        // Return to Room on the result screen (accepted_type 6, host and guests alike): a player of the room's last
        // battle opens its lobby again for the next round, until the host's game disbands it (60 s, master data
        // quest_result_room_auto_disband_delay). Anyone else is answered as for any room.
        if (room && Number(body.accepted_type) === ACCEPTED_TYPE.Rejoin
            && room.inBattle && (viewerId === room.hostViewerId || room.lastRoundViewerIds.includes(viewerId))) {
            // only once the battle is over: a player who left early (or a round-1 player while round 2 starts) is
            // told the battle is on (raising_state 4), not let in to a lobby the others still count on
            const reopened = coopSocketServer ? coopSocketServer.reopen(room.roomNumber) : (openRound(room), true)
            if (reopened) request.log.info({ roomNumber: room.roomNumber }, "co-op room: a player returned after the battle")
        }

        const status = room ? coopSocketServer?.joinStatus(room.roomNumber) ?? "open" : null
        const raisingState = status === null ? RAISING_STATE.Disbanded
            : status === "battle" ? RAISING_STATE.Battle
            : status === "filled" ? RAISING_STATE.Filled
            : RAISING_STATE.Ready
        if (room && raisingState === RAISING_STATE.Ready) admit(room, viewerId, request.viewer.playerId)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "room_number": room?.roomNumber ?? String(body.room_number ?? ""),
                "category_id": room?.category ?? Number(body.category ?? 0),
                "quest_id": room?.questId ?? Number(body.quest_id ?? 0),
                "ip_address": coopSocketHost(request),
                "port": coopSocketPort(),
                "application_update_url": "",
                "host_entry_time": room?.createdAt ?? 0,
                "raising_state": raisingState,
                "is_pickup": false,
                "room_sequence": room?.roomSequence ?? 0
            }
        })
    })

    fastify.post("/get_rooms", { schema: getRoomsSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetRoomsBody

        const viewerId = request.viewer.viewerId
        // looking for a room: counts as a player who could join a recruiting one
        notePresence(viewerId)

        // rooms a player can join: same quest category, battle not started, a slot free (or held
        // by an AI companion), not the player's own
        const rooms = listRooms()
            .filter(room => room.hostViewerId !== Number(viewerId))
            .filter(room => body.category_id === undefined || room.category === Number(body.category_id))
            .filter(room => !room.inBattle && (coopSocketServer?.joinStatus(room.roomNumber) ?? "open") === "open")
            .map(room => roomInformation(room))

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "rooms": rooms
            }
        })
    })

    // A room link was opened (wdfp://social-room?k=<token>, MultiBattleRoomTokenSelectFlow). The reply is read by
    // MultiBattleQuestVerifyAccessTokenRealRemote: room_exists false → "room not found"; otherwise every field below is
    // type-checked (a wrong type throws 8700–8702), the quest detail dialog opens and select_room follows with
    // access_token and accepted_type 4. Result code 4020 would mean NotPlayable.
    fastify.post("/verify_access_token", { schema: verifyAccessTokenSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number, access_token: string }
        const viewerId = request.viewer.viewerId

        const room = getRoomByAccessToken(String(body.access_token))
        const establisher = establisherOf(room ? coopSocketServer?.hostMate(room.roomNumber) ?? null : null)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": room ? {
                "room_exists": true,
                "category_id": room.category,
                "quest_id": room.questId,
                "room_number": room.roomNumber,
                // the host's viewer id (a Float in the client)
                "establisher": room.hostViewerId,
                "establisher_name": establisher.name,
                "establisher_rank": establisher.rank,
                "establisher_character": establisher.characterId,
                "establisher_character_evolution_img_level": establisher.evolutionLevel,
                "establisher_follow": FOLLOW_STATE_NONE,
                "host_entry_time": room.createdAt
            } : { "room_exists": false }
        })
    })

    // A player typed a room number. room_exists false → "room not found"; otherwise select_room
    // follows, which also reports full rooms and started battles.
    fastify.post("/search_room", { schema: searchRoomSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number, room_number?: string | number }
        const viewerId = request.viewer.viewerId

        const room = getRoom(normaliseRoomNumber(String(body.room_number ?? "")))
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": room ? {
                "room_exists": true,
                "category_id": room.category,
                "establisher_follow": FOLLOW_STATE_NONE,
                "quest_id": room.questId,
                "room_number": room.roomNumber
            } : { "room_exists": false }
        })
    })
}

export default routes;
