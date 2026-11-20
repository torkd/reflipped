// The Start Dash bundle (FT-44, src/lib/startDash.ts): buying it during the player's own days and trading its ticket for
// a unit. Shapes from the client's remotes (no captures); both replies carry `start_dash_exchange_campaign_list`.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MailType } from "../../data/types";
import {
    getPlayerItemSync, getPlayerReceivableMailCountSync, getPlayerSync, givePlayerItemSync, updatePlayerItemSync,
    updatePlayerStartDashExchangeStatusSync, updatePlayerSync
} from "../../data/wdfpData";
import { generateDataHeaders, getServerDate } from "../../utils";
import { atomicHandler } from "../../lib/atomic";
import { payBeads } from "../../lib/beads";
import { campaignMode } from "../../lib/campaignModes";
import { givePlayerCharacterSync } from "../../lib/character";
import { sendPlayerMailSync } from "../../lib/mail";
import { collectionUpdatesSync, missionReplyFields, updateMissionsSync } from "../../lib/missions";
import {
    getStartDashCampaign, isWithinStartDashPeriod, START_DASH_BUNDLE_REASON, START_DASH_GACHA_TICKET, START_DASH_OUT_OF_PERIOD,
    START_DASH_STAR_SLIVERS, startDashCampaignListSync, startDashEntrySync, StartDashStatus, startDashTargets
} from "../../lib/startDash";
import { gameBody, integer } from "../schemas";

const buySchema = gameBody({ campaign_id: integer }, ["campaign_id"])
const exchangeSchema = gameBody({ campaign_id: integer, character_id: integer }, ["campaign_id", "character_id"])

function send(reply: FastifyReply, viewerId: number, data: unknown, resultCode?: number) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        "data_headers": generateDataHeaders(resultCode === undefined ? { viewer_id: viewerId } : { viewer_id: viewerId, result_code: resultCode }),
        "data": data
    })
}

const routes = async (fastify: FastifyInstance) => {
    // The bundle, once, during the player's own days, for its price in any beads, free ones first: the exchange ticket
    // and the 10-Pull Summoning Ticket join the inventory, the Star Slivers arrive by mail. 4802 (PeriodError) outside, and
    // when the bundle is free (src/lib/campaignModes.ts: mailed instead, src/lib/campaignGifts.ts).
    fastify.post("/buy_ticket", { schema: buySchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const { campaign_id: campaignId } = request.body as { campaign_id: number }
        const { viewerId, playerId } = request.viewer
        const now = getServerDate()
        const campaign = getStartDashCampaign(campaignId)
        const entry = startDashEntrySync(playerId, campaignId)
        if (campaign === null || entry === null || !isWithinStartDashPeriod(entry, now) || campaignMode("startDash", campaignId) === "free") return send(reply, viewerId, [], START_DASH_OUT_OF_PERIOD)
        // once: bought or exchanged, or its ticket held (e.g. mailed while the bundle was free). PeriodError, the only
        // refusal the client handles, as in special_exchange/buy_ticket (FT-91)
        if (entry.status !== StartDashStatus.ENTERED || (getPlayerItemSync(playerId, campaign.ticketItemId) ?? 0) > 0)
            return send(reply, viewerId, [], START_DASH_OUT_OF_PERIOD)
        const player = getPlayerSync(playerId)!
        const paid = payBeads({ free: player.freeVmoney, paid: player.vmoney }, campaign.price)
        if (paid === null) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough beads." })

        updatePlayerSync({ id: playerId, freeVmoney: paid.free, vmoney: paid.paid })
        givePlayerItemSync(playerId, campaign.ticketItemId, 1)
        givePlayerItemSync(playerId, START_DASH_GACHA_TICKET, 1)
        updatePlayerStartDashExchangeStatusSync(playerId, campaignId, StartDashStatus.HAS_TICKET)
        sendPlayerMailSync(playerId, {
            type: MailType.STAR_CRUMB, number: START_DASH_STAR_SLIVERS, reasonId: START_DASH_BUNDLE_REASON, durableReward: true,
            subject: campaign.bundleName, description: `A bonus for ${campaign.bundleName}.`
        })
        return send(reply, viewerId, {
            "start_dash_exchange_campaign_list": startDashCampaignListSync(playerId),
            "user_info": { "free_vmoney": paid.free, "vmoney": paid.paid },
            "item_list": {
                [campaign.ticketItemId]: getPlayerItemSync(playerId, campaign.ticketItemId) ?? 1,
                [START_DASH_GACHA_TICKET]: getPlayerItemSync(playerId, START_DASH_GACHA_TICKET) ?? 1
            },
            "mail_arrived": getPlayerReceivableMailCountSync(playerId, now) > 0
        })
    }))

    // Trading the ticket for a 4- or 5-star unit of the entry's portal, once, during the player's days
    fastify.post("/exchange_character", { schema: exchangeSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const { campaign_id: campaignId, character_id: characterId } = request.body as { campaign_id: number, character_id: number }
        const { viewerId, playerId } = request.viewer
        const now = getServerDate()
        const campaign = getStartDashCampaign(campaignId)
        const entry = startDashEntrySync(playerId, campaignId)
        const refusal = campaign === null || entry === null ? "Unknown campaign."
            : !isWithinStartDashPeriod(entry, now) ? "The exchange period is over."
                : entry.status === StartDashStatus.EXCHANGED ? "Already exchanged."
                    : (getPlayerItemSync(playerId, campaign.ticketItemId) ?? 0) < 1 ? "No ticket to exchange."
                        : !startDashTargets(entry).includes(characterId) ? "Not in the list." : null
        if (refusal !== null) return reply.status(400).send({ "error": "Bad Request", "message": refusal })

        const tickets = getPlayerItemSync(playerId, campaign!.ticketItemId)!
        updatePlayerItemSync(playerId, campaign!.ticketItemId, tickets - 1)
        const given = givePlayerCharacterSync(playerId, characterId)
        if (given === null) return reply.status(400).send({ "error": "Bad Request", "message": "Could not give the unit." })
        updatePlayerStartDashExchangeStatusSync(playerId, campaignId, StartDashStatus.EXCHANGED)

        const itemList: Record<string, number> = { [campaign!.ticketItemId]: tickets - 1 }
        if (given.item !== undefined) itemList[given.item.id] = getPlayerItemSync(playerId, given.item.id) ?? given.item.count
        return send(reply, viewerId, {
            "start_dash_exchange_campaign_list": startDashCampaignListSync(playerId),
            "character_list": [given.isNew ? { ...given.character, "viewer_id": viewerId } : given.character],
            "item_list": itemList,
            ...missionReplyFields(updateMissionsSync(playerId, now, collectionUpdatesSync(playerId)), getPlayerReceivableMailCountSync(playerId, now) > 0)
        })
    }))
}

export default routes;
