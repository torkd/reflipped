import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isGachaCampaignOpen } from "../../lib/gachaCampaigns";
import { getPlayerGachaCampaignSync, getPlayerGachaInfoListSync, getPlayerGachaInfoSync, getPlayerItemSync, getPlayerSync, insertPlayerGachaCampaignSync, insertPlayerGachaInfoSync, updatePlayerGachaCampaignSync, updatePlayerGachaInfoSync, updatePlayerItemSync, updatePlayerSync } from "../../data/wdfpData";
import { generateDataHeaders, getServerDate } from "../../utils";
import { drawGachaSync, rewardPlayerGachaDrawResultSync } from "../../lib/gacha";
import { campaignPulls, ticketDraw } from "../../lib/gachaDraws";
import { comebackGachaPeriodSync, isComebackGacha, serializeComebackCampaign } from "../../lib/comebackGacha";
import { payBeads, starCrumbForPull } from "../../lib/beads";
import { clampCount, playerLimits } from "../../lib/limits";
import { getGachaCampaignIdSync, getGachaSync, isInGachaPoolSync } from "../../lib/assets";
import { GachaType } from "../../lib/types";
import { serializeGachaCampaign } from "../../data/utils";
import { UserGachaCampaign } from "../../data/types";
import { givePlayerCharacterSync } from "../../lib/character";
import { givePlayerEquipmentSync } from "../../lib/equipment";
import { gameBody, integer } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import { collectionUpdatesSync, missionReplyFields, updateMissionsSync } from "../../lib/missions";
import { gachaDrawPeriodSync, isOwnTicketDraw } from "../../lib/gachaDraws";

/** gacha/exec on a portal outside its period (the client's GachaInvalidPeriodError; 7004 shows the same dialog). */
const GACHA_OUT_OF_PERIOD = 1351

interface ExecBody {
    api_count: number,
    payment_type: number,
    number_of_exec: number,
    viewer_id: number,
    gacha_id: number,
    type: number
}

interface ExchangeCharacterBody {
    character_id: number,
    api_count: number,
    gacha_id: number,
    viewer_id: number
}

interface ExchangeEquipmentBody {
    equipment_id: number,
    gacha_id: number,
    viewer_id: number,
    api_count: number
}

enum GachaPaymentType {
    EMPTY,
    FREE_VMONEY,
    VMONEY,
    TICKET,
    CAMPAIGN
}

/** The client's GachaDrawKind (FT-14; src/lib/gachaDraws.ts has what each costs). */
enum GachaExecType {
    VMONEY_SINGLE = 1,
    VMONEY_MULTI = 2,
    OWN_TICKET_SINGLE = 3,
    OWN_TICKET_MULTI = 4,
    DAILY_SINGLE = 5,
    TEN_TIMES_PER_ACCOUNT = 7,
    CAMPAIGN = 8,
    MULTI_TICKET = 9,
    SINGLE_TICKET = 10,
    CAMPAIGN_OTHER = 11,
    SINGLE_WEAPON_TICKET = 12,
    MULTI_WEAPON_TICKET = 13,
    RARE4_TICKET = 20
}

const exchangeRequiredPoints = 250

const exchangeEquipmentSchema = gameBody({
    equipment_id: integer,
    gacha_id: integer,
    api_count: integer
})

const exchangeCharacterSchema = gameBody({
    character_id: integer,
    gacha_id: integer,
    api_count: integer
}, ["character_id", "gacha_id"])

const execSchema = gameBody({
    api_count: integer,
    payment_type: integer,
    number_of_exec: integer,
    gacha_id: integer,
    type: integer
}, ["payment_type", "number_of_exec", "gacha_id", "type"])

/** Missions (FT-2) count the units and armaments a draw or an exchange added. */
function collectionMissionFields(playerId: number): Record<string, unknown> {
    return missionReplyFields(updateMissionsSync(playerId, getServerDate(), collectionUpdatesSync(playerId)))
}

const routes = async (fastify: FastifyInstance) => {
    // Sent without waiting for the reply after the dialog saying a closed portal's leftover exchange points became Star
    // Specks. The server never converts them, so the client never shows that dialog; there is nothing to record.
    fastify.post("/shown_converted", { schema: gameBody({ gacha_id: integer }) }, (request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: request.viewer.viewerId }),
            "data": []
        })
    })

    fastify.post("/exchange_equipment", { schema: exchangeEquipmentSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ExchangeEquipmentBody

        const equipmentId = body.equipment_id
        const gachaId = body.gacha_id
        const viewerId = request.viewer.viewerId
        if (isNaN(equipmentId) || isNaN(gachaId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // get gacha info
        const gachaInfo = getPlayerGachaInfoSync(playerId, gachaId)
        if (gachaInfo === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "No data for gacha with provided id."
        })

        const newExchangePoints = (gachaInfo.gachaExchangePoint ?? 0) - exchangeRequiredPoints
        if (0 > newExchangePoints) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough exchange points."
        })

        // only what the gacha itself offers (SEC-15)
        if (!isInGachaPoolSync(gachaId, GachaType.WEAPON, equipmentId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not in this gacha's pool."
        })

        // reward equipment
        const giveResult = givePlayerEquipmentSync(playerId, equipmentId, 1)

        // update gacha info
        updatePlayerGachaInfoSync(playerId, {
            gachaId: gachaId,
            gachaExchangePoint: newExchangePoints
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "equipment_list": [
                    giveResult
                ],
                "gacha_info_list": [
                    {
                        "gacha_id": gachaId,
                        "is_account_first": gachaInfo.isAccountFirst,
                        "is_daily_first": gachaInfo.isDailyFirst,
                        "gacha_exchange_point": newExchangePoints
                    }
                ],
                "encyclopedia_info": [],
                ...collectionMissionFields(playerId)
            }
        })

    }))

    fastify.post("/exchange_character", { schema: exchangeCharacterSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ExchangeCharacterBody

        const characterId = body.character_id
        const gachaId = body.gacha_id
        const viewerId = request.viewer.viewerId
        if (isNaN(characterId) || isNaN(gachaId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // get gacha info
        const gachaInfo = getPlayerGachaInfoSync(playerId, gachaId)
        if (gachaInfo === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "No data for gacha with provided id."
        })

        const newExchangePoints = (gachaInfo.gachaExchangePoint ?? 0) - exchangeRequiredPoints
        if (0 > newExchangePoints) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough exchange points."
        })

        // only what the gacha itself offers (SEC-15)
        if (!isInGachaPoolSync(gachaId, GachaType.CHARACTER, characterId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not in this gacha's pool."
        })

        // reward character
        const giveResult = givePlayerCharacterSync(playerId, characterId)
        if (giveResult === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Could not give player character."
        })

        // update gacha info
        updatePlayerGachaInfoSync(playerId, {
            gachaId: gachaId,
            gachaExchangePoint: newExchangePoints
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "character_list": [
                    giveResult?.character
                ],
                "item_list": giveResult.item !== undefined ? {
                    [giveResult.item.id]: giveResult.item.count
                } : [],
                "gacha_info_list": [
                    {
                        "gacha_id": gachaId,
                        "is_account_first": gachaInfo.isAccountFirst,
                        "is_daily_first": gachaInfo.isDailyFirst,
                        "gacha_exchange_point": newExchangePoints
                    }
                ],
                "encyclopedia_info": [],
                ...collectionMissionFields(playerId)
            }
        })

    }))

    fastify.post("/exec", { schema: execSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ExecBody

        const viewerId = request.viewer.viewerId
        const gachaId = body.gacha_id
        const paymentType = body.payment_type
        const numberOfExec = body.number_of_exec
        const type = body.type
        if (isNaN(gachaId) || isNaN(paymentType) || isNaN(numberOfExec) || isNaN(type)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId
        const player = isNaN(playerId) ? null : getPlayerSync(playerId)
        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get the gacha
        const gachaData = getGachaSync(gachaId)
        if (gachaData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Gacha doesn't exist."
        })
        const isCharacterGacha = gachaData.type == GachaType.CHARACTER
        // a ticket portal (assets/ticket_gacha.json, the client's GachaPageKind 2 to 4: TicketOnly, OneTimeTicketOnly,
        // TenTimesTicketOnly) takes only its tickets: it has no bead cost, so a bead or campaign draw there would be free
        if (gachaData.paymentType >= 2 && gachaData.paymentType <= 4 && paymentType !== GachaPaymentType.TICKET) return reply.status(400).send({
            "error": "Bad Request",
            "message": "This portal takes only its ticket."
        })
        // a Star Heroes portal (assets/star_heroes_gacha.json, the client's GachaPageKind.TenTimesPerAccount) has only its
        // once-per-account 10-pull, and that draw kind only it
        const tenTimesPerAccount = gachaData.paymentType === 1
        if (tenTimesPerAccount !== (type === GachaExecType.TEN_TIMES_PER_ACCOUNT)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "This draw isn't available."
        })
        // a Welcome Back Portal (src/lib/comebackGacha.ts) opens only to a returning player, for a few days
        const comebackPeriod = isComebackGacha(gachaId) ? comebackGachaPeriodSync(playerId, getServerDate()) : null
        if (isComebackGacha(gachaId) && comebackPeriod?.gachaId !== gachaId) return reply.status(400).send({
            "error": "Bad Request",
            "message": "This portal isn't open to the player."
        })

        // the portal's period, as the client shows it from its (projected) master (FT-52): past its end only its own
        // tickets still draw, until their expiry. A Welcome Back Portal's period is the player's own (checked above): the
        // client ignores its master dates
        const period = comebackPeriod !== null ? "open" : gachaDrawPeriodSync(gachaId, getServerDate())
        if (period === "closed" || (period === "own-ticket" && !(paymentType === GachaPaymentType.TICKET && isOwnTicketDraw(type)))) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: GACHA_OUT_OF_PERIOD }),
                "data": []
            })
        }

        // get player gacha data
        let playerGachaData = getPlayerGachaInfoSync(playerId, gachaId)
        const insertPlayerGachaData = playerGachaData === null
        playerGachaData = playerGachaData ?? {
            gachaId: gachaId,
            isAccountFirst: true,
            isDailyFirst: true,
            gachaExchangePoint: 0
        }

        // determine & validate cost
        let pullCount = 0
        let playerPaidVmoney = player.vmoney
        let playerFreeVmoney = player.freeVmoney
        let gachaCampaigns: UserGachaCampaign[] = []

        let items: Record<number, number> = {}
        // every pull at least 4 stars (the 4 & 5-Star Portal Ticket)
        let guaranteedDraws = false
        // the daily discounted pull was used: only it spends the day's one
        let usedDailyPull = false
        // Star Slivers for the beads a pull cost (FT-61, src/lib/beads.ts); tickets and free pulls give none
        let starCrumbGained = 0

        switch (paymentType) {
            // beads, free ones first then paid, for every bead draw (src/lib/beads.ts): the daily discounted pull (5) took
            // paid beads only in the original (payment type 2); this server sells none, so it takes any beads, whichever
            // payment type the client sends (the AIR shell's any-beads-portal patch sends 1, the original app 2)
            case GachaPaymentType.FREE_VMONEY:
            case GachaPaymentType.VMONEY: {
                let cost: number
                if (type === GachaExecType.VMONEY_SINGLE) {
                    cost = gachaData.singleCost
                    pullCount = 1
                } else if (type === GachaExecType.VMONEY_MULTI) {
                    cost = gachaData.multiCost
                    pullCount = 10
                } else if (type === GachaExecType.DAILY_SINGLE) {
                    // a portal without one (the Welcome Back Portals, GachaPageKind.WithoutDaily) would draw it for free
                    if (!(gachaData.discountCost > 0)) return reply.status(400).send({
                        "error": "Bad Request",
                        "message": "This portal has no daily discounted pull."
                    })
                    if (!playerGachaData.isDailyFirst) return reply.status(400).send({
                        "error": "Bad Request",
                        "message": "Already did the daily discounted pull."
                    })
                    cost = gachaData.discountCost
                    pullCount = 1
                    usedDailyPull = true
                } else if (type === GachaExecType.TEN_TIMES_PER_ACCOUNT) {
                    // the Star Heroes portals' 10-pull (one guaranteed 5-star pull, from the portal's guarantee): once per
                    // account, for 1500 beads that took paid ones only in the original; here any beads, free ones first,
                    // like the daily discounted pull (FT-46; the AIR shell's any-beads-portal patch sends payment type 1)
                    if (!playerGachaData.isAccountFirst) return reply.status(400).send({
                        "error": "Bad Request",
                        "message": "Already did this portal's 10-pull."
                    })
                    cost = gachaData.multiCost
                    pullCount = 10
                } else {
                    return reply.status(400).send({
                        "error": "Bad Request",
                        "message": "This draw isn't available."
                    })
                }
                const paid = payBeads({ free: playerFreeVmoney, paid: playerPaidVmoney }, cost)
                if (paid === null) return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "Not enough beads."
                })
                playerFreeVmoney = paid.free
                playerPaidVmoney = paid.paid
                starCrumbGained = starCrumbForPull(cost, usedDailyPull)
                break;
            }

            // tickets (FT-14, src/lib/gachaDraws.ts): the draw kind names the ticket: the portal's own (3, 4), the
            // wildcard unit (9, 10) or armament (12, 13) tickets, or the 4 & 5-Star Portal Ticket (20)
            case GachaPaymentType.TICKET: {
                const ticket = ticketDraw(gachaId, gachaData.type, type)
                if (ticket === null) return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "This portal doesn't take that ticket."
                })
                const itemId = ticket.itemId

                const itemCount = getPlayerItemSync(playerId, itemId)
                const useTicketCount = Math.max(1, numberOfExec) 
                const newItemCount = (itemCount ?? -1) - useTicketCount
                if (0 > newItemCount) return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "Not enough tickets."
                })

                pullCount = useTicketCount * ticket.pulls
                guaranteedDraws = ticket.guaranteed

                items[itemId] = newItemCount
                updatePlayerItemSync(playerId, itemId, newItemCount);
                break;
            }

            // free pulls
            case GachaPaymentType.CAMPAIGN: {
                const gachaCampaignId = getGachaCampaignIdSync(gachaId)
                if (gachaCampaignId === null) return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "No gacha campaign assigned to gacha."
                })
                // only while the campaign is open (src/lib/gachaCampaigns.ts)
                if (!isGachaCampaignOpen(gachaCampaignId, getServerDate())) return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "This free pull campaign isn't open."
                })

                // get player campaign data
                let playerCampaignData = getPlayerGachaCampaignSync(playerId, gachaId, gachaCampaignId)
                const insertCampaignData = playerCampaignData === null;
                playerCampaignData = playerCampaignData  ?? {
                    gachaId: gachaId,
                    campaignId: gachaCampaignId,
                    count: 1
                }

                if (0 >= playerCampaignData.count) return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "Already redeemed campaign for this period."
                })

                // update campaign
                playerCampaignData.count = 0
                if (insertCampaignData) {
                    insertPlayerGachaCampaignSync(playerId, playerCampaignData)
                } else {
                    updatePlayerGachaCampaignSync(playerId, gachaId, gachaCampaignId, 0)
                }

                gachaCampaigns.push(serializeGachaCampaign(playerCampaignData))

                // the campaign's own size (a free pull or a free 10-pull a day), whichever free kind (8, 11) was sent
                pullCount = campaignPulls(gachaCampaignId)
                break;
            }
        }

        if (pullCount === 0) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid payment type."
        })

        if ((0 > playerFreeVmoney) || (0 > playerPaidVmoney)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough beads."
        })

        const drawResult = drawGachaSync(gachaData, pullCount, guaranteedDraws)
        const rewardResult = rewardPlayerGachaDrawResultSync(playerId, gachaData, drawResult)

        const isDailyFirst = playerGachaData.isDailyFirst && !usedDailyPull
        const newGachaExchangePoint = (playerGachaData.gachaExchangePoint ?? 0) + pullCount
        if (insertPlayerGachaData) {
            playerGachaData.isAccountFirst = false
            playerGachaData.isDailyFirst = isDailyFirst
            playerGachaData.gachaExchangePoint = newGachaExchangePoint
            insertPlayerGachaInfoSync(playerId, playerGachaData)
        } else {
            updatePlayerGachaInfoSync(playerId, {
                gachaId: gachaId,
                ...(usedDailyPull ? { isDailyFirst: false } : {}),
                isAccountFirst: false,
                gachaExchangePoint: newGachaExchangePoint
            })
        }

        // up to the client's limit, from the balance it was shown (an imported save may hold more); the client shows the
        // difference to its last balance on the result screen ("You received ::point:: Star Slivers!")
        const starCrumb = starCrumbGained > 0
            ? Math.min(clampCount(player.starCrumb, playerLimits.starCrumb) + starCrumbGained, playerLimits.starCrumb)
            : null
        updatePlayerSync({
            id: playerId,
            vmoney: playerPaidVmoney,
            freeVmoney: playerFreeVmoney,
            ...(starCrumb !== null ? { starCrumb } : {})
        })
        const userInfo = {
            "free_vmoney": playerFreeVmoney,
            "vmoney": playerPaidVmoney,
            ...(starCrumb !== null ? { "star_crumb": starCrumb } : {})
        }

        reply.header("content-type", "application/x-msgpack")
        if (isCharacterGacha) {
            return reply.status(200).send({
                "data_headers": generateDataHeaders({
                    viewer_id: viewerId
                }),
                "data": {
                    "user_info": userInfo,
                    "draw": rewardResult.draw,
                    "character_list": rewardResult.characters,
                    "item_list": {
                        ...items,
                        ...rewardResult.items
                    },
                    "gacha_campaign_list": gachaCampaigns,
                    "gacha_info_list": [
                        {
                            "gacha_id": gachaId,
                            "is_account_first": false,
                            "is_daily_first": isDailyFirst,
                            "gacha_exchange_point": newGachaExchangePoint,
                            // the client keeps a known portal's period, but takes it from here for a new entry
                            ...(comebackPeriod !== null ? { "comeback_campaign": serializeComebackCampaign(comebackPeriod) } : {})
                        }
                    ],
                    "encyclopedia_info": [],
                    ...collectionMissionFields(playerId)
                }
            })
        } else {
            return reply.status(200).send({
                "data_headers": generateDataHeaders({
                    viewer_id: viewerId
                }),
                "data": {
                    "user_info": userInfo,
                    "is_erupt": false,
                    "draw_equipment": rewardResult.draw,
                    "item_list": {
                        ...items,
                        ...rewardResult.items
                    },
                    "equipment_list": rewardResult.equipment,
                    "gacha_info_list": [
                        {
                            "gacha_id": gachaId,
                            "is_account_first": false,
                            "is_daily_first": isDailyFirst,
                            "gacha_exchange_point": newGachaExchangePoint
                        }
                    ],
                    "encyclopedia_info": [],
                    ...collectionMissionFields(playerId)
                }
            })
        }
        
    }))
}

export default routes;