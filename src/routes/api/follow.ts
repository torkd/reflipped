// Follows (FT-15, src/lib/follows.ts): the Following/Followers screen and its search, following from a profile or a
// co-op result, and bulk edits. Other players are named by viewer ID (follow_id), except in the search
// (search_kakao_pid, search_id), which takes the ID the game shows players or a viewer ID.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deletePlayerFollowSync, getAccountPlayersSync, getPlayerFollowingSync, getViewerPlayerIdSync } from "../../data/wdfpData";
import { generateDataHeaders, getServerDate } from "../../utils";
import { arrayOf, gameBody, ignoredBody, stringOrInteger } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import {
    FOLLOW_COUNT_OVER, followInfoSync, followListsSync, followPlayerSync, MAX_FOLLOWS, PARTNER_FOLLOWED_COUNT_OVER, PLAYER_NOT_FOUND
} from "../../lib/follows";

interface FollowBody {
    viewer_id: number,
    follow_id: number | string
}

const followSchema = gameBody({ follow_id: stringOrInteger }, ["follow_id"])

interface BulkEditBody {
    viewer_id: number,
    add_follow_id_list?: (number | string)[],
    delete_follow_id_list?: (number | string)[]
}

/** A bulk edit names at most a full follow list's worth of players each way. */
const bulkEditSchema = gameBody({
    add_follow_id_list: { ...arrayOf(stringOrInteger), maxItems: MAX_FOLLOWS },
    delete_follow_id_list: { ...arrayOf(stringOrInteger), maxItems: MAX_FOLLOWS }
})

const searchKakaoPidSchema = gameBody({ search_kakao_pid: stringOrInteger }, ["search_kakao_pid"])
const searchIdSchema = gameBody({ search_id: stringOrInteger }, ["search_id"])

/** A viewer ID as the client sends it (a number, or the digits typed into the search box). */
function playerOf(viewerId: unknown): number | null {
    const text = String(viewerId ?? "").trim()
    return /^\d{1,15}$/.test(text) ? getViewerPlayerIdSync(text) : null
}

/**
 * The player a search names. The ID the game shows ("Your ID" on the Following/Followers screen, the account info)
 * (and "ID:" on a profile) is the Kakao player ID, which is Reflipped's account number (openapi's `playerId`, the
 * `kakao_pid` the follow replies carry; FT-82), so that comes first; a viewer ID (9 digits, above any account number) is
 * still accepted. Leading zeros are ignored.
 */
function searchedPlayerOf(searched: unknown): number | null {
    const text = String(searched ?? "").trim()
    if (!/^\d{1,15}$/.test(text)) return null
    const accountPlayers = getAccountPlayersSync(Number(text))
    return accountPlayers.length > 0 ? Math.min(...accountPlayers) : playerOf(text)
}

function send(reply: FastifyReply, viewerId: number, data: unknown, resultCode?: number) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        "data_headers": generateDataHeaders(resultCode === undefined ? { viewer_id: viewerId } : { viewer_id: viewerId, result_code: resultCode }),
        "data": data
    })
}

const routes = async (fastify: FastifyInstance) => {
    // The Following/Followers screen: everyone related to the player, each with their follow state; read-only
    fastify.post("/lists", { schema: ignoredBody }, async (request: FastifyRequest, reply: FastifyReply) => {
        return send(reply, request.viewer.viewerId, followListsSync(request.viewer.playerId))
    })

    // Follow a player (a profile's or a co-op result's Follow button). The client reads nothing from a success.
    fastify.post("/add", { schema: followSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as FollowBody
        const { viewerId, playerId } = request.viewer
        const target = playerOf(body.follow_id)
        if (target === null) return reply.status(400).send({ "error": "Bad Request", "message": "Player not found." })
        const outcome = followPlayerSync(playerId, target, getServerDate())
        if (outcome === "self") return reply.status(400).send({ "error": "Bad Request", "message": "Can't follow yourself." })
        if (outcome === "count-over") return send(reply, viewerId, [], FOLLOW_COUNT_OVER)
        if (outcome === "partner-over") return send(reply, viewerId, [], PARTNER_FOLLOWED_COUNT_OVER)
        return send(reply, viewerId, [])
    }))

    // Unfollow; unfollowing someone the player doesn't follow is a no-op
    fastify.post("/delete", { schema: followSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as FollowBody
        const target = playerOf(body.follow_id)
        if (target !== null) deletePlayerFollowSync(request.viewer.playerId, target)
        return send(reply, request.viewer.viewerId, [])
    }))

    // The follow list's edit mode: unfollows first, then follows. A player who has too many followers is skipped and
    // listed in max_follower_user_viewer_id_list ("Unable to follow player(s) that were at max follower count"); more
    // follows than the list allows are refused as a whole (1451), before anything changes.
    fastify.post("/bulk_edit", { schema: bulkEditSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as BulkEditBody
        const { viewerId, playerId } = request.viewer
        const removals = new Set((body.delete_follow_id_list ?? []).map(playerOf).filter((id): id is number => id !== null))
        const additions = new Map<number, number>()
        for (const id of body.add_follow_id_list ?? []) {
            const target = playerOf(id)
            if (target !== null && target !== playerId && !removals.has(target)) additions.set(target, Number(id))
        }
        // checked before any change, so a refused edit changes nothing
        const kept = getPlayerFollowingSync(playerId).filter(follow => !removals.has(follow.playerId)).map(follow => follow.playerId)
        const newFollows = [...additions.keys()].filter(target => !kept.includes(target))
        if (kept.length + newFollows.length > MAX_FOLLOWS) return send(reply, viewerId, [], FOLLOW_COUNT_OVER)

        for (const target of removals) deletePlayerFollowSync(playerId, target)
        const atMaxFollowers: number[] = []
        const now = getServerDate()
        for (const [target, viewerIdSent] of additions) {
            if (followPlayerSync(playerId, target, now) === "partner-over") atMaxFollowers.push(viewerIdSent)
        }
        return send(reply, viewerId, { "max_follower_user_viewer_id_list": atMaxFollowers })
    }))

    // Search Players by ID: the global client sends the typed ID here (the Kakao player ID it shows players; the AIR
    // shell's search-id-length patch lets it send one shorter than 12 digits). Not found: 1455, which it shows as
    // "Player not found".
    fastify.post("/search_kakao_pid", { schema: searchKakaoPidSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { search_kakao_pid: number | string }
        return searchReply(request, reply, body.search_kakao_pid)
    })

    // The same search under its other name (no screen of the global client calls it)
    fastify.post("/search_id", { schema: searchIdSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { search_id: number | string }
        return searchReply(request, reply, body.search_id)
    })

    // Searching by Twitter friends: there is no Twitter link, so nobody is found
    fastify.post("/search_twitter", { schema: ignoredBody }, async (request: FastifyRequest, reply: FastifyReply) => {
        return send(reply, request.viewer.viewerId, { "search_result": [] })
    })
}

function searchReply(request: FastifyRequest, reply: FastifyReply, searched: unknown) {
    const { viewerId, playerId } = request.viewer
    const target = searchedPlayerOf(searched)
    const info = target === null || target === playerId ? null : followInfoSync(playerId, target)
    if (info === null) return send(reply, viewerId, [], PLAYER_NOT_FOUND)
    return send(reply, viewerId, { "search_result": info })
}


export default routes;
