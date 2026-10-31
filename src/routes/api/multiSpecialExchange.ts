// multi_special_exchange/*: the multi special exchange campaign (FT-13, src/lib/multiSpecialExchange.ts).
// The lounge it shares with co-op (`lounge/*` and its socket) is CO-3.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerItemSync, getPlayerReceivableMailCountSync, getPlayerMultiSpecialExchangeCampaignSync, givePlayerItemSync, updatePlayerItemSync, upsertPlayerMultiSpecialExchangeCampaignSync } from "../../data/wdfpData";
import { serializeMultiSpecialExchangeCampaign } from "../../data/utils";
import { MailType, PlayerMultiSpecialExchangeCampaign } from "../../data/types";
import { sendPlayerMailSync } from "../../lib/mail";
import { mailLimits } from "../../lib/limits";
import { generateDataHeaders, getServerDate } from "../../utils";
import { atomicHandler } from "../../lib/atomic";
import { collectionUpdatesSync, missionReplyFields, updateMissionsSync } from "../../lib/missions";
import { givePlayerCharacterSync } from "../../lib/character";
import { bonusUnitMailDescription, bonusUnitMailReasonId, bonusUnitMailSubject, drawBonusCharacterIds, drawTicketItemId, getExchangeCharacterIds, getMultiSpecialExchangeCampaign, isWithinCampaignPeriod, isWithinExchangePeriod, MultiSpecialExchangeResultCode, MultiSpecialExchangeStatus } from "../../lib/multiSpecialExchange";
import { gameBody, integer } from "../schemas";

interface DrawTicketBody {
    campaign_id: number
    viewer_id: number
    api_count: number
}

interface ExchangeCharacterBody {
    campaign_id: number
    character_id: number
    ticket_item_id: number
    viewer_id: number
    api_count: number
}

const drawTicketSchema = gameBody({
    campaign_id: integer,
    api_count: integer
}, ["campaign_id"])

const exchangeCharacterSchema = gameBody({
    campaign_id: integer,
    character_id: integer,
    ticket_item_id: integer,
    api_count: integer
}, ["campaign_id", "character_id", "ticket_item_id"])

function badRequest(reply: FastifyReply, message: string) {
    return reply.status(400).send({
        "error": "Bad Request",
        "message": message
    })
}

/** A refusal the client handles by its result code (`data_headers.result_code`), with an HTTP 200. */
function resultCodeReply(reply: FastifyReply, viewerId: number, resultCode: number) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        "data_headers": generateDataHeaders({
            viewer_id: viewerId,
            result_code: resultCode
        }),
        "data": []
    })
}

/** Gives the player one of `ticketItemId`, records it as drawn and replies with the new state and ticket count. */
function giveTicketReply(reply: FastifyReply, viewerId: number, playerId: number, campaignId: number, ticketItemId: number) {
    const count = givePlayerItemSync(playerId, ticketItemId, 1)
    const drawn = { campaignId, status: MultiSpecialExchangeStatus.TICKET_DRAWN, ticketItemId }
    upsertPlayerMultiSpecialExchangeCampaignSync(playerId, drawn)
    return drawTicketReply(reply, viewerId, drawn, { [ticketItemId]: count })
}

function drawTicketReply(reply: FastifyReply, viewerId: number, campaign: PlayerMultiSpecialExchangeCampaign, itemList: Record<string, number>) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        "data_headers": generateDataHeaders({
            viewer_id: viewerId
        }),
        "data": {
            "multi_special_exchange_campaign_list": [serializeMultiSpecialExchangeCampaign(campaign)],
            "item_list": Object.keys(itemList).length > 0 ? itemList : [],
            "mail_arrived": false
        }
    })
}

const routes = async (fastify: FastifyInstance) => {
    // draw a ticket alone (the "single" mode of the campaign scene)
    fastify.post("/single_draw_ticket", { schema: drawTicketSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as DrawTicketBody
        const { viewerId, playerId } = request.viewer
        const campaignId = body.campaign_id

        const campaign = getMultiSpecialExchangeCampaign(campaignId)
        if (campaign === null) return badRequest(reply, "Unknown campaign.")
        if (!isWithinCampaignPeriod(campaign, getServerDate()))
            return resultCodeReply(reply, viewerId, MultiSpecialExchangeResultCode.PERIOD_ERROR)

        const current = getPlayerMultiSpecialExchangeCampaignSync(playerId, campaignId)
        if (current !== null && current.status !== MultiSpecialExchangeStatus.NOT_PARTICIPATED)
            return resultCodeReply(reply, viewerId, MultiSpecialExchangeResultCode.TICKET_ALREADY_DRAWN)

        return giveTicketReply(reply, viewerId, playerId, campaignId, drawTicketItemId(campaign))
    }))

    // receive the ticket a lounge battle decided (status 2); also what the client calls after single_draw_ticket
    // answered "already drawn", so a player who already holds the ticket gets the current state back
    fastify.post("/multi_draw_ticket", { schema: drawTicketSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as DrawTicketBody
        const { viewerId, playerId } = request.viewer
        const campaignId = body.campaign_id

        const campaign = getMultiSpecialExchangeCampaign(campaignId)
        if (campaign === null) return badRequest(reply, "Unknown campaign.")

        const current = getPlayerMultiSpecialExchangeCampaignSync(playerId, campaignId)
            ?? { campaignId, status: MultiSpecialExchangeStatus.NOT_PARTICIPATED, ticketItemId: null }
        if (current.status !== MultiSpecialExchangeStatus.TICKET_DECIDED) return drawTicketReply(reply, viewerId, current, {})
        if (!isWithinExchangePeriod(campaign, getServerDate()))
            return resultCodeReply(reply, viewerId, MultiSpecialExchangeResultCode.PERIOD_ERROR)

        const decided = current.ticketItemId
        const ticketItemId = decided !== null && campaign.ticketItemIds.includes(decided) ? decided : drawTicketItemId(campaign)
        return giveTicketReply(reply, viewerId, playerId, campaignId, ticketItemId)
    }))

    // trade the drawn ticket for a character
    fastify.post("/exchange_character", { schema: exchangeCharacterSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ExchangeCharacterBody
        const { viewerId, playerId } = request.viewer
        const campaignId = body.campaign_id
        const characterId = body.character_id
        const ticketItemId = body.ticket_item_id

        const now = getServerDate()
        const campaign = getMultiSpecialExchangeCampaign(campaignId)
        if (campaign === null) return badRequest(reply, "Unknown campaign.")
        if (!isWithinExchangePeriod(campaign, now))
            return resultCodeReply(reply, viewerId, MultiSpecialExchangeResultCode.PERIOD_ERROR)

        const current = getPlayerMultiSpecialExchangeCampaignSync(playerId, campaignId)
        if (current === null || current.status !== MultiSpecialExchangeStatus.TICKET_DRAWN)
            return badRequest(reply, "No ticket drawn in this campaign.")
        const allowedTickets = current.ticketItemId !== null ? [current.ticketItemId] : campaign.ticketItemIds
        if (!allowedTickets.includes(ticketItemId)) return badRequest(reply, "Not this campaign's ticket.")
        if (!getExchangeCharacterIds(ticketItemId).includes(characterId))
            return badRequest(reply, "The ticket can't be exchanged for this character.")

        const owned = getPlayerItemSync(playerId, ticketItemId) ?? 0
        if (owned < 1) return badRequest(reply, "No ticket to exchange.")
        updatePlayerItemSync(playerId, ticketItemId, owned - 1)

        const giveResult = givePlayerCharacterSync(playerId, characterId)
        if (giveResult === null) return badRequest(reply, "Could not give player character.")
        const isNew = giveResult.isNew

        const exchanged = { campaignId, status: MultiSpecialExchangeStatus.EXCHANGED, ticketItemId }
        upsertPlayerMultiSpecialExchangeCampaignSync(playerId, exchanged)

        // the two other units arrive in the gift box (see drawBonusCharacterIds; co-op mates' picks are CO-3). A full
        // gift box doesn't cost the player the exchange: the chosen unit is given and only the mails that fit are sent.
        const freeMailSlots = mailLimits.pendingMails - getPlayerReceivableMailCountSync(playerId, now)
        for (const bonusCharacterId of drawBonusCharacterIds(ticketItemId).slice(0, Math.max(0, freeMailSlots))) {
            sendPlayerMailSync(playerId, {
                type: MailType.CHARACTER,
                typeId: bonusCharacterId,
                number: 1,
                reasonId: bonusUnitMailReasonId,
                subject: bonusUnitMailSubject,
                description: bonusUnitMailDescription
            })
        }

        const itemList: Record<string, number> = { [ticketItemId]: owned - 1 }
        if (giveResult.item !== undefined) itemList[giveResult.item.id] = getPlayerItemSync(playerId, giveResult.item.id) ?? giveResult.item.count

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "multi_special_exchange_campaign_list": [serializeMultiSpecialExchangeCampaign(exchanged)],
                "character_list": [
                    isNew ? { ...giveResult.character, "viewer_id": viewerId } : giveResult.character
                ],
                "item_list": itemList,
                "encyclopedia_info": isNew ? { [`1${characterId}01`]: { "read": false } } : [],
                "mission_info": [], // the multi special exchange missions (pattern 66) aren't counted
                // lights the gift box badge, as /load does
                ...missionReplyFields(updateMissionsSync(playerId, now, collectionUpdatesSync(playerId)), getPlayerReceivableMailCountSync(playerId, now) > 0)
            }
        })
    }))
}

export default routes;
