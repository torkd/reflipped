// lounge/*: the multi special exchange lounge (CO-3, docs/coop-polish-spec.md §3.2). Three players gather for a
// campaign (FT-13) and the host's Go decides everyone's ticket, which each then draws with
// `multi_special_exchange/multi_draw_ticket`. The registry is src/lib/coop/lounges.ts, the socket side
// src/lib/coop/loungeHub.ts. `use_case` 1 is the only lounge the client has.
//
// Host: create → prepare → select → socket. Guest: get_list or search → select → socket. After a restart or the
// background: restore → socket. `raising_state` in select and restore: 2 = in, 95 = not a member, 99 = not found or
// disbanded. A guest's select handler also knows 94 Barred, 97 Spent and 98 Filled (and throws 5001 on 95); the host's
// throws 5001 on every value from 92 to 98, so the host only ever gets 2 or 99 (docs/coop-research.md, "Lounge").

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders, getServerDate } from "../../utils";
import { gameBody, integer, number, stringOrInteger, string, any } from "../schemas";
import { admitToLounge, createLounge, findLounge, getLoungeByNumber, listLounges, Lounge, LOUNGE_CAPACITY, sweepUnusedLounges, TooManyLoungesError } from "../../lib/coop/lounges";
import { coopSocketHost, coopSocketPort, coopSocketServer } from "../../lib/coop/socketServer";
import { getMultiSpecialExchangeCampaign, isWithinCampaignPeriod, MultiSpecialExchangeStatus } from "../../lib/multiSpecialExchange";
import { getPlayerMultiSpecialExchangeCampaignSync, getPlayerSync } from "../../data/wdfpData";
import { notePresence } from "../../lib/coop/recruitment";
import { joinRefusedFor, roomHiddenFrom } from "../../lib/coop/restricted";
import { establisherFollowSync } from "../../lib/follows";

/** `data_headers.result_code` of the lounge routes (the client's lounge error handlers). */
const LoungeResultCode = {
    DataNotFound: 4511,
    Failure: 4512,
    OutOfPeriod: 4513,
    /** the player's ticket is decided or drawn: the client goes on to the draw and the exchange */
    TicketAlreadyDrawn: 4902
}
const RaisingState = { Ready: 2, Barred: 94, NotMate: 95, Spent: 97, Filled: 98, NotFound: 99 }

const loungeKey = { use_case: integer, lounge_id: number, advice: string, establisher_viewer_id: number, api_count: integer }
const loungeKeyRequired = ["lounge_id", "advice"]

const getListSchema = gameBody({ use_case: integer, api_count: integer }, ["use_case"])
const searchSchema = gameBody({ use_case: integer, lounge_number: stringOrInteger, api_count: integer }, ["lounge_number"])
const createSchema = gameBody({ use_case: integer, campaign_id: integer, api_count: integer }, ["campaign_id"])
const prepareSchema = gameBody(loungeKey, loungeKeyRequired)
const selectSchema = gameBody({ ...loungeKey, accepted_type: integer, campaign_id: integer }, loungeKeyRequired)
const restoreSchema = gameBody(loungeKey, loungeKeyRequired)
const shareSchema = gameBody({ ...loungeKey, share_type_list: any }, loungeKeyRequired)
const failureSchema = gameBody({ type: any, api_count: integer })

interface LoungeKeyBody { use_case?: number, lounge_id: number, advice: string, establisher_viewer_id?: number }

function send(reply: FastifyReply, viewerId: number, data: unknown, resultCode?: number) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        "data_headers": generateDataHeaders(resultCode === undefined ? { viewer_id: viewerId } : { viewer_id: viewerId, result_code: resultCode }),
        "data": data
    })
}

/** Whether the player can still take part: the campaign is open and their ticket not yet decided or drawn. */
function campaignStatus(playerId: number, campaignId: number): "open" | "period" | "taken" | "unknown" {
    const campaign = getMultiSpecialExchangeCampaign(campaignId)
    if (campaign === null) return "unknown"
    if (!isWithinCampaignPeriod(campaign, getServerDate())) return "period"
    const current = getPlayerMultiSpecialExchangeCampaignSync(playerId, campaignId)
    return current === null || current.status === MultiSpecialExchangeStatus.NOT_PARTICIPATED ? "open" : "taken"
}

/** Players holding a slot on the lounge's socket. */
function memberCount(lounge: Lounge): number {
    return coopSocketServer?.lounges.memberCount(lounge.loungeId) ?? 0
}

/** LoungeInformation for the list: the host as it entered the lounge, else as its save has it. */
function loungeInformation(lounge: Lounge, viewerId: number) {
    const detail = coopSocketServer?.lounges.hostDetail(lounge.loungeId) ?? null
    const host = detail === null ? getPlayerSync(lounge.members.get(lounge.hostViewerId) ?? -1) : null
    return {
        "advice": lounge.advice,
        "establisher_character": detail?.characterId ?? host?.leaderCharacterId ?? 0,
        "establisher_character_evolution_img_level": detail?.evolutionLevel ?? 0,
        "establisher_follow": establisherFollowSync(viewerId, lounge.hostViewerId),
        "establisher_name": detail?.name ?? host?.name ?? "",
        "establisher_viewer_id": lounge.hostViewerId,
        "lounge_id": lounge.loungeId,
        "mates": memberCount(lounge),
        "raising_state": RaisingState.Ready,
        "use_case": lounge.useCase
    }
}

const routes = async (fastify: FastifyInstance) => {
    // the campaign scene's lounge list: open lounges of other hosts with a free slot
    fastify.post("/get_list", { schema: getListSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { use_case: number }
        const { viewerId } = request.viewer
        notePresence(viewerId)
        const now = getServerDate()
        const lounges = listLounges()
            .filter(lounge => lounge.useCase === Number(body.use_case) && !lounge.started && lounge.hostViewerId !== viewerId)
            .filter(lounge => coopSocketServer?.lounges.isMember(lounge.loungeId, lounge.hostViewerId) === true)
            .filter(lounge => memberCount(lounge) < LOUNGE_CAPACITY)
            .filter(lounge => {
                const campaign = getMultiSpecialExchangeCampaign(lounge.campaignId)
                return campaign !== null && isWithinCampaignPeriod(campaign, now)
            })
            .filter(lounge => !roomHiddenFrom(lounge, viewerId))
            .map(lounge => loungeInformation(lounge, viewerId))
        return send(reply, viewerId, { "lounge_list": lounges })
    })

    // a lounge by the number its host shared
    fastify.post("/search", { schema: searchSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { lounge_number: string | number }
        const { viewerId } = request.viewer
        const lounge = getLoungeByNumber(String(body.lounge_number))
        // the client's search handler reads the other fields only when `lounge_exists` is true, else "not found"
        if (!lounge || lounge.started) return send(reply, viewerId, { "lounge_exists": false })
        return send(reply, viewerId, {
            "lounge_exists": true,
            "advice": lounge.advice,
            "establisher_follow": establisherFollowSync(viewerId, lounge.hostViewerId),
            "establisher_viewer_id": lounge.hostViewerId,
            "lounge_id": lounge.loungeId
        })
    })

    fastify.post("/create", { schema: createSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { use_case?: number, campaign_id: number }
        const { viewerId, playerId } = request.viewer
        const campaignId = Number(body.campaign_id)
        const status = campaignStatus(playerId, campaignId)
        if (status === "unknown") return send(reply, viewerId, [], LoungeResultCode.Failure)
        if (status === "period") return send(reply, viewerId, [], LoungeResultCode.OutOfPeriod)
        if (status === "taken") return send(reply, viewerId, [], LoungeResultCode.TicketAlreadyDrawn)
        const server = coopSocketServer
        if (server) sweepUnusedLounges(id => server.lounges.inUse(id))
        let lounge: Lounge
        try {
            lounge = createLounge(viewerId, campaignId, Number(body.use_case ?? 1))
        } catch (error) {
            if (error instanceof TooManyLoungesError) return send(reply, viewerId, [], LoungeResultCode.Failure)
            throw error
        }
        lounge.members.set(viewerId, playerId)
        request.log.info({ loungeId: lounge.loungeId, campaignId }, "lounge created")
        return send(reply, viewerId, { "advice": lounge.advice, "lounge_id": lounge.loungeId })
    })

    // the host's step between create and select
    fastify.post("/prepare", { schema: prepareSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as LoungeKeyBody
        const { viewerId } = request.viewer
        const lounge = findLounge(body.lounge_id, body.advice, body.establisher_viewer_id)
        if (!lounge || lounge.started) return send(reply, viewerId, [], LoungeResultCode.DataNotFound)
        return send(reply, viewerId, [])
    })

    // joining (host and guests alike): the socket's address once there is a slot
    fastify.post("/select", { schema: selectSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as LoungeKeyBody & { accepted_type?: number, campaign_id?: number }
        const { viewerId, playerId } = request.viewer
        const lounge = findLounge(body.lounge_id, body.advice, body.establisher_viewer_id)
        const isMember = lounge !== undefined && coopSocketServer?.lounges.isMember(lounge.loungeId, viewerId) === true
        const refusal = !lounge || lounge.started ? RaisingState.NotFound
            : !isMember && memberCount(lounge) >= LOUNGE_CAPACITY ? RaisingState.Filled
            // a player whose ticket is already decided or drawn has nothing to gain, and would block the Go
            : campaignStatus(playerId, lounge.campaignId) !== "open" ? RaisingState.Spent
            // a restricted player stays out of strangers' lounges (SEC-18)
            : joinRefusedFor(lounge, viewerId) ? RaisingState.Barred
            : null
        request.log.info({ loungeId: body.lounge_id, acceptedType: body.accepted_type, refusal }, "lounge select")
        if (refusal !== null || !lounge) {
            // only the guest's handler knows the specific refusals; the host's crashes on them
            const host = lounge !== undefined && viewerId === lounge.hostViewerId
            return send(reply, viewerId, {
                "application_update_url": "", "ip_address": "", "lounge_number": "", "port": 0,
                "raising_state": host ? RaisingState.NotFound : refusal ?? RaisingState.NotFound
            })
        }
        admitToLounge(lounge, viewerId, playerId)
        return send(reply, viewerId, {
            "application_update_url": "",
            "ip_address": coopSocketHost(request.hostname),
            "lounge_number": lounge.loungeNumber,
            "port": coopSocketPort(),
            "raising_state": RaisingState.Ready
        })
    })

    // back after a restart or the background
    fastify.post("/restore", { schema: restoreSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as LoungeKeyBody
        const { viewerId, playerId } = request.viewer
        const lounge = findLounge(body.lounge_id, body.advice, body.establisher_viewer_id)
        const noSocket = { "ip_address": "", "port": 0 }
        if (!lounge) return send(reply, viewerId, { ...noSocket, "raising_state": RaisingState.NotFound })
        if (!lounge.members.has(viewerId)) return send(reply, viewerId, { ...noSocket, "raising_state": RaisingState.NotMate })
        // the Go went through: the ticket waits in multi_draw_ticket
        if (lounge.started) return send(reply, viewerId, [], LoungeResultCode.TicketAlreadyDrawn)
        admitToLounge(lounge, viewerId, playerId)
        return send(reply, viewerId, {
            "ip_address": coopSocketHost(request.hostname),
            "port": coopSocketPort(),
            "raising_state": RaisingState.Ready
        })
    })

    // the Recruit button: no invitations for lounges yet, so nothing to do but answer
    fastify.post("/share", { schema: shareSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as LoungeKeyBody
        const { viewerId } = request.viewer
        const lounge = findLounge(body.lounge_id, body.advice, body.establisher_viewer_id)
        if (!lounge) return send(reply, viewerId, [], LoungeResultCode.DataNotFound)
        return send(reply, viewerId, [])
    })

    // the client reports a lounge it couldn't set up
    fastify.post("/create_lounge_failure", { schema: failureSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        request.log.info({ type: (request.body as { type?: unknown }).type }, "lounge: the client couldn't set up its lounge")
        return send(reply, request.viewer.viewerId, [])
    })
}

export default routes;
