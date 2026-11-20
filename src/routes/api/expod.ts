// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerCharactersSync, getPlayerCharacterSync, getPlayerItemSync, getPlayerSync, updatePlayerCharacterSync, updatePlayerSync } from "../../data/wdfpData";
import { givePlayerCharactersExpSync } from "../../lib/character";
import { generateDataHeaders, getServerDate, getServerTime } from "../../utils";
import { getCharacterDataSync } from "../../lib/assets";
import { clientSerializeDate } from "../../data/utils";
import { gameBody, ignoredBody, integer } from "../schemas";
import { conversionYield, creditStarSpecksSync, STAR_SPECK_ITEM_ID } from "../../lib/duplicates";
import { characterMaxOverLimits } from "./character";
import { atomicHandler } from "../../lib/atomic";
import { collectionUpdatesSync, MissionPattern, missionReplyFields, updateMissionsSync } from "../../lib/missions";

interface InjectExpBody {
    character_id: number,
    viewer_id: number,
    exp: number,
    api_count: number
}

interface StackToExpBody {
    character_id: number,
    api_count: number,
    number: number,
    viewer_id: number
}

// The pooled EXP and Star Specks a converted duplicate gives come from the master (src/lib/duplicates.ts,
// `character/experience_conversion_rate`: 100/300/500/2000/10000 EXP by rarity, Star Specks 0/0/2/10/30 for units from
// portals). They were 500/500/500 EXP and 2/2/2 Star Specks for every 1-3★ unit before FT-40.

const injectExpSchema = gameBody({
    character_id: integer,
    exp: integer,
    api_count: integer
}, ["character_id", "exp"])

const stackToExpSchema = gameBody({
    character_id: integer,
    number: integer,
    api_count: integer
}, ["character_id", "number"])

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/stack_to_exp", { schema: stackToExpSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as StackToExpBody

        const viewerId = request.viewer.viewerId
        const characterId = body.character_id
        const convertCount = body.number
        if (isNaN(characterId) || !Number.isSafeInteger(convertCount) || convertCount < 1) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get character asset data
        const characterAssetData = getCharacterDataSync(characterId)
        if (characterAssetData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Character does not exist."
        })

        // get character
        const character = getPlayerCharacterSync(playerId, characterId)
        if (character === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Player does not own character."
        })
        
        // a locked unit's duplicates aren't converted one by one (the client's Protected)
        if (character.protection) return reply.status(400).send({
            "error": "Bad Request",
            "message": "The unit is locked."
        })

        const afterStack = character.stack - convertCount
        if (0 > afterStack) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough stack."
        })

        const converted = conversionYield(characterId, convertCount)!
        const afterExp = player.expPool + converted.exp

        // the converted copies are used up (SEC-12: they weren't, so the same stack paid out forever)
        updatePlayerCharacterSync(playerId, characterId, { stack: afterStack })
        updatePlayerSync({ id: playerId, expPool: afterExp })
        const itemList: Record<string, number> = {}
        creditStarSpecksSync(playerId, converted.starSpecks, itemList)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "exp_pool": afterExp,
                    "exp_pooled_time": getServerTime(player.expPooledTime)
                },
                "character_list": [
                    {
                        "viewer_id": viewerId,
                        "character_id": characterId,
                        "stack": afterStack,
                        "exp": character.exp,
                        "exp_total": character.exp,
                        "create_time": clientSerializeDate(character.joinTime),
                        "update_time": clientSerializeDate(character.updateTime),
                        "join_time": clientSerializeDate(character.joinTime)
                    }
                ],
                "converted_exp_info": {
                    "add_exp": converted.exp
                },
                "item_list": itemList,
                "mail_arrived": false
            }
        })
    }))

    // "Convert All to EXP" (FT-40): every duplicate of every fully uncapped unit becomes pooled EXP (and Star Specks for
    // units from portals); locked units too, as the client lists them. The client shows the units' count and the EXP
    // added (`converted_exp_info.add_exp`, required), and reads the Star Specks from `item_list`.
    fastify.post("/bulk_stack_to_exp", { schema: ignoredBody }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = request.viewer.viewerId
        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)
        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        let addExp = 0
        let starSpecks = 0
        const characterList: Object[] = []
        for (const [id, character] of Object.entries(getPlayerCharactersSync(playerId))) {
            const characterId = Number(id)
            const rarity = getCharacterDataSync(characterId)?.rarity
            if (rarity === undefined || character.stack < 1 || character.overLimitStep < characterMaxOverLimits[rarity]) continue
            const converted = conversionYield(characterId, character.stack)
            if (converted === null) continue
            addExp += converted.exp
            starSpecks += converted.starSpecks
            updatePlayerCharacterSync(playerId, characterId, { stack: 0 })
            characterList.push({
                "viewer_id": viewerId,
                "character_id": characterId,
                "stack": 0,
                "exp": character.exp,
                "exp_total": character.exp,
                "create_time": clientSerializeDate(character.joinTime),
                "update_time": clientSerializeDate(character.updateTime),
                "join_time": clientSerializeDate(character.joinTime)
            })
        }
        const afterExp = player.expPool + addExp
        if (addExp > 0) updatePlayerSync({ id: playerId, expPool: afterExp })
        const itemList: Record<string, number> = {}
        creditStarSpecksSync(playerId, starSpecks, itemList)
        if (itemList[String(STAR_SPECK_ITEM_ID)] === undefined) itemList[String(STAR_SPECK_ITEM_ID)] = getPlayerItemSync(playerId, STAR_SPECK_ITEM_ID) ?? 0

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": {
                    "exp_pool": afterExp,
                    "exp_pooled_time": getServerTime(player.expPooledTime)
                },
                "character_list": characterList,
                "converted_exp_info": {
                    "add_exp": addExp
                },
                "item_list": itemList,
                "mail_arrived": false
            }
        })
    }))

    fastify.post("/inject_exp", { schema: injectExpSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as InjectExpBody

        const viewerId = request.viewer.viewerId

        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // increase character exp
        const characterId = body.character_id
        const character = getPlayerCharacterSync(playerId, characterId)
        if (character === null) return reply.status(400).send({
            "error": "Internal Server Error",
            "message": "Player does not own character."
        })

        // make sure that the player has enough exp
        const addExp = Math.abs(body.exp)
        const playerExpPool = player.expPool
        if (addExp > playerExpPool) return reply.status(400).send({
            "error": "Internal Server Error",
            "message": "Not enough exp."
        })
        
        const playerAfterExpPool = player.expPool - addExp

        // decrease player exp
        updatePlayerSync({
            id: playerId,
            expPool: playerAfterExpPool
        })

        // add exp to the character
        const rewardResult = givePlayerCharactersExpSync(playerId, [characterId], addExp, false)
        const missionResult = updateMissionsSync(playerId, getServerDate(), [
            { pattern: MissionPattern.INJECTED_EXP_FIRST_TIME, value: 1 },
            ...collectionUpdatesSync(playerId)
        ])

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "add_exp_list": rewardResult.add_exp_list,
                "character_list": rewardResult.character_list,
                "user_info": {
                    "exp_pool": rewardResult.exp_pool,
                    "exp_pooled_time": getServerTime(player.expPooledTime)
                },
                ...missionReplyFields(missionResult)
            }
        })
    }))
}

export default routes;