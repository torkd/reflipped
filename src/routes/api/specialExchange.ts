// Special exchange campaigns (FT-39, src/lib/specialExchange.ts): the Scouting and Dream Armament Selection screens.
// Shapes from the client's remotes (no captures): every reply carries `special_exchange_campaign_list`, the exchanges
// also the unit or armament they gave.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerItemSync, getPlayerReceivableMailCountSync, getPlayerSpecialExchangeSync, getPlayerSync, givePlayerItemSync, setPlayerSpecialExchangeSync, updatePlayerItemSync, updatePlayerSync } from "../../data/wdfpData";
import { payBeads } from "../../lib/beads";
import { specialExchangeBonusMail } from "../../lib/campaignGifts";
import { campaignMode } from "../../lib/campaignModes";
import { sendPlayerMailSync } from "../../lib/mail";
import { generateDataHeaders, getServerDate } from "../../utils";
import { atomicHandler } from "../../lib/atomic";
import { givePlayerCharacterSync } from "../../lib/character";
import { givePlayerEquipmentSync } from "../../lib/equipment";
import { collectionUpdatesSync, missionReplyFields, updateMissionsSync } from "../../lib/missions";
import {
    BUY_TICKET_OUT_OF_PERIOD, ENTER_OUT_OF_PERIOD, EXCHANGE_OUT_OF_PERIOD, EXCHANGE_PERIOD_OVER, exchangeRefusalSync, getSpecialExchangeCampaign, isExchangeOpen, isSaleOpen, specialExchangeBundlePrice,
    SpecialExchangeStatus, specialExchangeCampaignListSync
} from "../../lib/specialExchange";
import { gameBody, integer } from "../schemas";

const campaignSchema = gameBody({ campaign_id: integer }, ["campaign_id"])
const exchangeCharacterSchema = gameBody({ campaign_id: integer, character_id: integer }, ["campaign_id", "character_id"])
const exchangeEquipmentSchema = gameBody({ campaign_id: integer, equipment_id: integer }, ["campaign_id", "equipment_id"])

function send(reply: FastifyReply, viewerId: number, data: unknown, resultCode?: number) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        "data_headers": generateDataHeaders(resultCode === undefined ? { viewer_id: viewerId } : { viewer_id: viewerId, result_code: resultCode }),
        "data": data
    })
}

const routes = async (fastify: FastifyInstance) => {
    // Opening a campaign's screen: the player has entered it (status 1, or 2 with its ticket); 4715 ("Availability period
    // has ended") outside its exchange period
    fastify.post("/enter_campaign", { schema: campaignSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const { campaign_id: campaignId } = request.body as { campaign_id: number }
        const { viewerId, playerId } = request.viewer
        const campaign = getSpecialExchangeCampaign(campaignId)
        if (campaign === null || !isExchangeOpen(campaign, getServerDate())) return send(reply, viewerId, [], ENTER_OUT_OF_PERIOD)
        if (!getPlayerSpecialExchangeSync(playerId).has(campaignId)) setPlayerSpecialExchangeSync(playerId, campaignId, SpecialExchangeStatus.ENTERED)
        return send(reply, viewerId, { "special_exchange_campaign_list": specialExchangeCampaignListSync(playerId, getServerDate()) })
    }))

    // The ticket bundle, during its sale period, for its price in any beads, free ones first (the original took paid
    // beads only; the AIR shell's any-beads-ticket patch lets the client offer it): the ticket joins the inventory and
    // a paid bundle's Star Slivers arrive by mail, as the purchase dialog says. Once per campaign, before an exchange.
    // Outside the sale period, and for a free campaign (src/lib/campaignModes.ts: by default the ticket gift promos,
    // whose ticket comes by mail, src/lib/campaignGifts.ts), the client's "This item is no longer available for
    // purchase" (PeriodError).
    fastify.post("/buy_ticket", { schema: campaignSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const { campaign_id: campaignId } = request.body as { campaign_id: number }
        const { viewerId, playerId } = request.viewer
        const now = getServerDate()
        const campaign = getSpecialExchangeCampaign(campaignId)
        if (campaign === null || campaignMode("specialExchange", campaignId) === "free" || !isSaleOpen(campaign, now)) return send(reply, viewerId, [], BUY_TICKET_OUT_OF_PERIOD)
        const status = getPlayerSpecialExchangeSync(playerId).get(campaignId)
        // once per campaign: a ticket held (bought, or from the campaign's gift or an admin mail) or already exchanged.
        // The client may still offer the bundle: it learns a ticket that came by mail only at the next /load (the mail
        // replies carry no campaign list), and it handles no refusal but PeriodError, so that one (FT-91)
        if (status === SpecialExchangeStatus.EXCHANGED || (getPlayerItemSync(playerId, campaign.ticketItemId) ?? 0) > 0)
            return send(reply, viewerId, [], BUY_TICKET_OUT_OF_PERIOD)
        const player = getPlayerSync(playerId)!
        const paid = payBeads({ free: player.freeVmoney, paid: player.vmoney }, specialExchangeBundlePrice(campaign))
        if (paid === null) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough beads." })

        updatePlayerSync({ id: playerId, freeVmoney: paid.free, vmoney: paid.paid })
        givePlayerItemSync(playerId, campaign.ticketItemId, 1)
        if (status === undefined) setPlayerSpecialExchangeSync(playerId, campaignId, SpecialExchangeStatus.ENTERED)
        sendPlayerMailSync(playerId, specialExchangeBonusMail(campaign))
        return send(reply, viewerId, {
            "special_exchange_campaign_list": specialExchangeCampaignListSync(playerId, getServerDate()),
            "user_info": { "free_vmoney": paid.free, "vmoney": paid.paid },
            "item_list": { [campaign.ticketItemId]: getPlayerItemSync(playerId, campaign.ticketItemId) ?? 1 },
            "mail_arrived": getPlayerReceivableMailCountSync(playerId, now) > 0
        })
    }))

    // Trading the ticket for a unit of the campaign's list: the unit joins directly (a duplicate stacks, as from a
    // portal) and the campaign is exchanged (status 3)
    fastify.post("/exchange_character", { schema: exchangeCharacterSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const { campaign_id: campaignId, character_id: characterId } = request.body as { campaign_id: number, character_id: number }
        const { viewerId, playerId } = request.viewer
        const now = getServerDate()
        const refusal = exchangeRefusalSync(playerId, campaignId, "character", characterId, now)
        if (refusal === EXCHANGE_PERIOD_OVER) return send(reply, viewerId, [], EXCHANGE_OUT_OF_PERIOD)
        if (refusal !== null) return reply.status(400).send({ "error": "Bad Request", "message": refusal })

        const ticketItemId = getSpecialExchangeCampaign(campaignId)!.ticketItemId
        const tickets = getPlayerItemSync(playerId, ticketItemId) ?? 0
        updatePlayerItemSync(playerId, ticketItemId, tickets - 1)
        const given = givePlayerCharacterSync(playerId, characterId)
        if (given === null) return reply.status(400).send({ "error": "Bad Request", "message": "Could not give the unit." })
        setPlayerSpecialExchangeSync(playerId, campaignId, SpecialExchangeStatus.EXCHANGED)

        const itemList: Record<string, number> = { [ticketItemId]: tickets - 1 }
        if (given.item !== undefined) itemList[given.item.id] = getPlayerItemSync(playerId, given.item.id) ?? given.item.count
        return send(reply, viewerId, {
            "special_exchange_campaign_list": specialExchangeCampaignListSync(playerId, getServerDate()),
            "character_list": [given.isNew ? { ...given.character, "viewer_id": viewerId } : given.character],
            "item_list": itemList,
            ...missionReplyFields(updateMissionsSync(playerId, now, collectionUpdatesSync(playerId)), getPlayerReceivableMailCountSync(playerId, now) > 0)
        })
    }))

    // Trading the ticket for an armament of the campaign's list; the client reads back only the campaign list
    fastify.post("/exchange_equipment", { schema: exchangeEquipmentSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const { campaign_id: campaignId, equipment_id: equipmentId } = request.body as { campaign_id: number, equipment_id: number }
        const { viewerId, playerId } = request.viewer
        const now = getServerDate()
        const refusal = exchangeRefusalSync(playerId, campaignId, "equipment", equipmentId, now)
        if (refusal === EXCHANGE_PERIOD_OVER) return send(reply, viewerId, [], EXCHANGE_OUT_OF_PERIOD)
        if (refusal !== null) return reply.status(400).send({ "error": "Bad Request", "message": refusal })

        const ticketItemId = getSpecialExchangeCampaign(campaignId)!.ticketItemId
        updatePlayerItemSync(playerId, ticketItemId, (getPlayerItemSync(playerId, ticketItemId) ?? 0) - 1)
        givePlayerEquipmentSync(playerId, equipmentId, 1)
        setPlayerSpecialExchangeSync(playerId, campaignId, SpecialExchangeStatus.EXCHANGED)
        updateMissionsSync(playerId, now, collectionUpdatesSync(playerId))
        return send(reply, viewerId, { "special_exchange_campaign_list": specialExchangeCampaignListSync(playerId, getServerDate()) })
    }))
}

export default routes;
