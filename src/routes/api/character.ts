// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerCharactersSync, getPlayerCharacterManaNodesSync, getPlayerCharacterSync, getPlayerCharactersManaNodesSync, getPlayerItemSync, getPlayerSync, givePlayerItemSync, hasPlayerUnlockedCharacterManaNodeSync, insertPlayerCharacterManaNodesSync, updatePlayerCharacterBondTokenSync, updatePlayerCharacterSync, updatePlayerItemSync, updatePlayerSync } from "../../data/wdfpData";
import { board2Available } from "../../lib/balance";
import { generateDataHeaders, getServerDate } from "../../utils";
import { getCharacterDataSync, getCharacterManaNodeSync, getCharacterManaNodesSync } from "../../lib/assets";
import { clientSerializeDate } from "../../data/utils";
import { arrayOf, boolean, gameBody, ignoredBody, integer } from "../schemas";

interface SetCharacterProtectionBody {
    protect_character_ids: number[]
    unprotect_character_ids: number[]
    viewer_id: number
}

// character/set_protection (FT-40): the units whose lock changed while the unit growth screen was in lock mode
const setCharacterProtectionSchema = gameBody({
    protect_character_ids: arrayOf(integer, 5000),
    unprotect_character_ids: arrayOf(integer, 5000)
}, ["protect_character_ids", "unprotect_character_ids"])
import { atomicHandler } from "../../lib/atomic";
import { collectionUpdatesSync, MissionPattern, missionReplyFields, updateMissionsSync } from "../../lib/missions";
import { characterEncyclopediaKey, givePlayerCharacterSync } from "../../lib/character";
import { townJoinCheckSync } from "../../lib/storyJoin";

const addCharacterFromTownSchema = gameBody({ character_id: integer }, ["character_id"])

interface OverLimitBody {
    viewer_id: number
    character_id: number
    api_count: number
    use_stack: boolean
    item_id: number,
    over_limit_count: number
}

const overLimitSchema = gameBody({
    character_id: integer,
    api_count: integer,
    use_stack: boolean,
    item_id: integer,
    over_limit_count: integer
}, ["character_id"])

interface LearnManaNodeBody {
    viewer_id: number,
    character_id: number,
    api_count: number,
    mana_node_multiplied_id_list: number[]
}

const learnManaNodeSchema = gameBody({
    character_id: integer,
    api_count: integer,
    mana_node_multiplied_id_list: arrayOf(integer)
}, ["character_id", "mana_node_multiplied_id_list"])

interface SetIllustrationSettingsBody {
    character_id: number,
    api_count: number,
    illustration_settings: number[],
    viewer_id: number
}

const setIllustrationSettingsSchema = gameBody({
    character_id: integer,
    api_count: integer,
    illustration_settings: arrayOf(integer)
}, ["character_id", "illustration_settings"])

interface ReceiveBondTokenBody {
    character_id: number,
    mana_board_index: number,
    api_count: number,
    viewer_id: number
}

const receiveBondTokenSchema = gameBody({
    character_id: integer,
    mana_board_index: integer,
    api_count: integer
}, ["character_id", "mana_board_index"])

const openManaBoardSchema = gameBody({
    character_id: integer,
    mana_board_index: integer,
    api_count: integer
}, ["character_id", "mana_board_index"])

export const characterMaxOverLimits: Record<number, number> = {
    [1]: 12, // 1* max over limit count
    [2]: 10, // 2* max over limit count
    [3]: 8,  // 3* max over limit count 
    [4]: 6,  // 4* max over limit count
    [5]: 4,  // 5* max over limit count 
}

const openManaBoardRequiredUncaps: Record<number, number> = {
    [1]: 10,
    [2]: 8,
    [3]: 6,
    [4]: 4,
    [5]: 2
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/set_illustration_settings", { schema: setIllustrationSettingsSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SetIllustrationSettingsBody

        const viewerId = request.viewer.viewerId
        const characterId = body.character_id
        const illustration_settings = body.illustration_settings
        if (isNaN(characterId) || !illustration_settings) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // update character
        updatePlayerCharacterSync(playerId, characterId, {
            illustrationSettings: illustration_settings.slice(0, 6)
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {}
        }) 
    }))

    fastify.post("/receive_bond_token", { schema: receiveBondTokenSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBondTokenBody

        const viewerId = request.viewer.viewerId
        const characterId = body.character_id
        const manaBoardIndex = body.mana_board_index
        if (isNaN(characterId) || isNaN(manaBoardIndex)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get character data
        const characterData = getPlayerCharacterSync(playerId, characterId)
        if (characterData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Character not owned."
        })

        // a second board that isn't out yet on the shared timeline (FT-47, src/lib/balance.ts)
        const board2Out = board2Available(characterId)
        if (manaBoardIndex >= 2 && !board2Out) return reply.status(400).send({
            "error": "Bad Request",
            "message": "This unit's second mana board isn't out yet."
        })
        const bondTokenReceivable = characterData.bondTokenList[manaBoardIndex - 1]?.status === 1
        if (!bondTokenReceivable) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Cannot receive bond token."
        })

        // reward the bond token
        const newBondTokens = player.bondToken + 1
        updatePlayerSync({
            id: playerId,
            bondToken: newBondTokens
        })

        // update bond token status
        updatePlayerCharacterBondTokenSync(playerId, characterId, {
            manaBoardIndex: manaBoardIndex,
            status: 2
        });

        // build bond token list for response
        let bondTokenList: Object[] = []
        for (const entry of characterData.bondTokenList) {
            const entryIndex = entry.manaBoardIndex
            bondTokenList.push({
                "mana_board_index": entryIndex,
                "status": entryIndex === manaBoardIndex ? 2 : entryIndex >= 2 && !board2Out ? 0 : entry.status
            })
        }

        const missionResult = updateMissionsSync(playerId, getServerDate(), [
            { pattern: MissionPattern.TOTAL_OBTAINED_BOND_TOKEN_COUNT, amount: 1 },
            ...collectionUpdatesSync(playerId)
        ])

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "bond_token": newBondTokens
                },
                "character_list": [
                    {
                        "character_id": characterId,
                        "bond_token_list": bondTokenList,
                        "create_time": clientSerializeDate(characterData.joinTime),
                        "update_time": clientSerializeDate(characterData.updateTime),
                        "join_time": clientSerializeDate(characterData.joinTime)
                    }
                ],
                ...missionReplyFields(missionResult)
            }
        }) 
    }))

    fastify.post("/open_mana_board", { schema: openManaBoardSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBondTokenBody
        
        const viewerId = request.viewer.viewerId
        const characterId = body.character_id
        const manaBoardIndex = body.mana_board_index
        if (isNaN(characterId) || isNaN(manaBoardIndex)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // get character data
        const characterData = getPlayerCharacterSync(playerId, characterId)
        if (characterData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Character not owned."
        })

        // get character asset data
        const characterAssetData = getCharacterDataSync(characterId)
        if (characterAssetData === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No character asset data found."
        })

        // make sure that the mana board index is valid: the unit has nodes on that board (a unit with 3 skills or fewer has
        // only board 1, though its bond token list names board 2 too)
        if (!characterData.bondTokenList[manaBoardIndex - 1] || getCharacterManaNodesSync(characterId, manaBoardIndex) === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": `Character does not have mana board with index ${manaBoardIndex}.`
        })

        // a second board that isn't out yet on the shared timeline (FT-47, src/lib/balance.ts)
        if (manaBoardIndex >= 2 && !board2Available(characterId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "This unit's second mana board isn't out yet."
        })

        // ensure that the mana board can be opened
        // TODO: Add level check.  5*: Level 80, 4*: Level 70, 3*: Level 60.
        if (openManaBoardRequiredUncaps[characterAssetData.rarity] > characterData.overLimitStep) return reply.status(400).send({
            "error": "Bad Request",
            "message": `Character is not uncapped enough to unlock mana board.`
        })
        if (1 > characterData.bondTokenList[manaBoardIndex - 2]?.status) return reply.status(400).send({
            "error": "Bad Request",
            "message": `Must unlock all previous mana board nodes.`
        })

        updatePlayerCharacterSync(playerId, characterId, {
            manaBoardIndex: manaBoardIndex
        })
        const missionResult = updateMissionsSync(playerId, getServerDate(), manaBoardIndex === 2 ? [{ pattern: MissionPattern.MANA_BOARD_2ND_OPEN_COUNT, amount: 1 }] : [])

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "character_list": [
                    {
                        "viewer_id": viewerId,
                        "character_id": characterId,
                        "mana_board_index": manaBoardIndex,
                        "create_time": clientSerializeDate(characterData.joinTime),
                        "update_time": clientSerializeDate(characterData.updateTime),
                        "join_time": clientSerializeDate(characterData.joinTime)
                    }
                ],
                ...missionReplyFields(missionResult)
            }
        }) 
    }))

    fastify.post("/learn_mana_node", { schema: learnManaNodeSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as LearnManaNodeBody

        const viewerId = request.viewer.viewerId
        const characterId = body.character_id
        const toUnlockNodeIds = body.mana_node_multiplied_id_list
        if (!characterId || isNaN(characterId) || !toUnlockNodeIds) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get character data
        const characterData = getPlayerCharacterSync(playerId, characterId)
        if (characterData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Character not owned."
        })

        // compute the combined cost of each node
        let manaCost = 0
        const itemsCosts: Record<string, number> = {}

        const userCharacterManaNodeListItem: Object[] = []

        // get mana node data from assets
        // a unit on a second board that is hidden again (the shared timeline went back, FT-47) is on its first board for
        // the client: only that board's nodes can be learnt
        const board2Out = board2Available(characterId)
        const currentManaNodeIndex = board2Out ? characterData.manaBoardIndex : Math.min(characterData.manaBoardIndex, 1);
        const characterManaNodes = getCharacterManaNodesSync(characterId, currentManaNodeIndex)
        if (characterManaNodes === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": `Character does not have mana nodes of index '${currentManaNodeIndex}'.`
        })

        // get currently unlocked nodes
        const unlockedManaNodes = getPlayerCharacterManaNodesSync(playerId, characterId);
        const unlockedManaNodesRecord: Record<string, boolean> = {}
        let indexUnlockedNodesCount = 0 // the number of nodes that have been unlocked for the selected index
        for (const manaNodeId of unlockedManaNodes) {
            unlockedManaNodesRecord[manaNodeId] = true
            indexUnlockedNodesCount += characterManaNodes[manaNodeId] === undefined ? 0 : 1
        }
        
        for (const manaNodeId of toUnlockNodeIds) {
            if (unlockedManaNodesRecord[manaNodeId]) return reply.status(400).send({
                "error": "Bad Request",
                "message": `Mana node '${manaNodeId}' already unlocked.`
            })

            const nodeData = characterManaNodes[manaNodeId];
            if (nodeData === undefined) return reply.status(400).send({
                "error": "Bad Request",
                "message": `Mana node '${manaNodeId}' does not exist.`
            })

            if (nodeData !== null) {
                manaCost += nodeData.manaCost

                for (const [itemId, itemCost] of Object.entries(nodeData.items)) {
                    const existing = itemsCosts[itemId]
                    itemsCosts[itemId] = existing ? existing + itemCost : itemCost
                }

                userCharacterManaNodeListItem.push({
                    "mana_node_multiplied_id": manaNodeId
                })
            }
        }

        // validate that the player has enough materials to unlock these nodes
        // TODO: Allow the usage of paidMana
        const newMana = player.freeMana - manaCost
        if (0 > newMana) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough mana."
        })

        for (const [itemId, itemCost] of Object.entries(itemsCosts)) {
            const item = getPlayerItemSync(playerId, itemId)
            const newAmount = item === null ? -1 : item - itemCost
            if (0 > newAmount) return reply.status(400).send({
                "error": "Bad Request",
                "message": `Not enough of item with id ${itemId}`
            })

            // replace the object value with the newAmount for deduction later
            itemsCosts[itemId] = newAmount
        }

        // deduct mana
        updatePlayerSync({
            id: playerId,
            freeMana: newMana
        })

        // deduct item amounts
        for (const [itemId, newAmount] of Object.entries(itemsCosts)) {
            updatePlayerItemSync(playerId, itemId, newAmount)
        }

        // increase evolution level
        let characterEvolutionLevel = characterData.evolutionLevel
        let evolutionData: Object = []
        if (characterEvolutionLevel === 0) {
            characterEvolutionLevel = 1
            updatePlayerCharacterSync(playerId, characterId, {
                evolutionLevel: characterEvolutionLevel
            })

            evolutionData = {
                "character_id": characterId,
                "level": 1,
                "img_level": 1
            }
        }

        // give bond reward, if available
        const amityScrollReceivable = characterData.bondTokenList[currentManaNodeIndex - 1]?.status === 0
        const bondTokenList: Object[] = []
        if (amityScrollReceivable && (indexUnlockedNodesCount + toUnlockNodeIds.length) === Object.keys(characterManaNodes).length) {
            updatePlayerCharacterBondTokenSync(playerId, characterId, {
                manaBoardIndex: currentManaNodeIndex,
                status: 1
            });

            for (const entry of characterData.bondTokenList) {
                const entryIndex = entry.manaBoardIndex
                bondTokenList.push({
                    "mana_board_index": entryIndex,
                    "status": entryIndex === currentManaNodeIndex ? 1 : entryIndex >= 2 && !board2Out ? 0 : entry.status
                })
            }
        }

        // insert new mana nodes
        insertPlayerCharacterManaNodesSync(playerId, characterId, toUnlockNodeIds)

        // missions (FT-2): nodes learned, a unit evolved by its first node, and the ability nodes unlocked
        const missionResult = updateMissionsSync(playerId, getServerDate(), [
            { pattern: MissionPattern.TOTAL_RELEASED_MANA_NODE_COUNT, amount: toUnlockNodeIds.length },
            { pattern: MissionPattern.TOTAL_USED_MANA_COUNT, amount: manaCost },
            ...(characterData.evolutionLevel === 0 ? [{ pattern: MissionPattern.EVOLVED_CHARACTER_COUNT, amount: 1 }] : []),
            ...collectionUpdatesSync(playerId)
        ])

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "free_mana": newMana
                },
                "character_list": [
                    {
                        "evolution_level": characterEvolutionLevel,
                        "evolution_img_level": characterEvolutionLevel,
                        "character_id": characterId,
                        "create_time": clientSerializeDate(characterData.joinTime),
                        "update_time": clientSerializeDate(characterData.updateTime),
                        "join_time": clientSerializeDate(characterData.joinTime),
                        "bond_token_list": bondTokenList
                    }
                ],
                "evolution": evolutionData,
                "item_list": itemsCosts,
                "user_character_mana_node_list": {
                    [String(characterId)]: userCharacterManaNodeListItem
                },
                ...missionReplyFields(missionResult)
            }
        }) 
    }))

    fastify.post("/over_limit", { schema: overLimitSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as OverLimitBody

        const viewerId = request.viewer.viewerId

        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // get character data
        const characterId = body.character_id
        const playerCharacterData = getPlayerCharacterSync(playerId, characterId)
        if (playerCharacterData === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Character not owned."
        })

        // get character asset data
        const characterAssetData = getCharacterDataSync(characterId)
        if (characterAssetData === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No character asset data found."
        })

        // calculate new over limit
        const overLimitCount = body.over_limit_count
        // a negative count paid the player instead (SEC-12)
        if (!Number.isSafeInteger(overLimitCount) || overLimitCount < 1) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid over limit count."
        })
        const newOverLimit = playerCharacterData.overLimitStep + overLimitCount
        const characterRarity = characterAssetData.rarity
        if (newOverLimit > characterMaxOverLimits[characterRarity]) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Character cannot be uncapped further."
        })

        let stack = playerCharacterData.stack
        const item_list: Record<number, number> = {}

        if (body.use_stack) {
            // stack uncapping
            
            // ensure that the character has enough stack
            stack = stack - overLimitCount
            if (0 > stack) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Character does not have enough duplicates to uncap."
            })

            // update the character
            updatePlayerCharacterSync(playerId, characterId, {
                overLimitStep: newOverLimit,
                stack: stack
            })
        } else {
            // item uncapping
            const itemId = body.item_id

            // ensure that the item trying to be used is valid
            // 5* characters can only be uncapped by item 10003 (awaking_crystal_5)
            // 4* characters and below can only be uncapped by items 10002 (awaking_crystal_4) and 10001 (awaking_crystal_3)
            if ( (characterRarity === 5 && itemId !== 10003) 
                || ( 4 >= characterRarity && (itemId !== 10002 && itemId !== 10001)) 
            ) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Attempted to use invalid item."
            })

            const itemData = getPlayerItemSync(playerId, itemId)
            if (itemData === null) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Attempted to use unowned item."
            })

            // make sure that the player has enough of the item
            const newAmount = itemData - overLimitCount
            if (0 > newAmount) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Not enough of item to uncap."
            })

            // update the item count
            updatePlayerItemSync(playerId, itemId, newAmount)
            item_list[itemId] = newAmount // add to items table

            // update the character
            updatePlayerCharacterSync(playerId, characterId, {
                overLimitStep: newOverLimit
            })
        }

        const missionResult = updateMissionsSync(playerId, getServerDate(), [{ pattern: MissionPattern.OVER_LIMIT_TOTAL_COUNT, amount: overLimitCount }])

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "character_list": [
                    {
                        "over_limit_step": newOverLimit,
                        "character_id": characterId,
                        "stack": stack,
                        "create_time": clientSerializeDate(playerCharacterData.joinTime),
                        "update_time": clientSerializeDate(new Date()),
                        "join_time": clientSerializeDate(playerCharacterData.joinTime)
                    }
                ],
                "item_list": item_list,
                ...missionReplyFields(missionResult)
            }
        })
    }))

    // "Uncap All" (FT-40): every unit below its highest uncap with duplicates uses them, `min(stack, max - step)` each
    // (no Astral Gems; locked units too, as the client lists them). The reply lists only the units uncapped: the
    // client shows their count ("N unit(s) have been uncapped!").
    fastify.post("/bulk_over_limit", { schema: ignoredBody }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = request.viewer.viewerId
        const playerId = request.viewer.playerId
        const now = new Date()
        const characterList: Object[] = []
        let total = 0
        for (const [id, character] of Object.entries(getPlayerCharactersSync(playerId))) {
            const characterId = Number(id)
            const rarity = getCharacterDataSync(characterId)?.rarity
            const max = rarity === undefined ? undefined : characterMaxOverLimits[rarity]
            if (max === undefined || character.stack < 1 || character.overLimitStep >= max) continue
            const count = Math.min(character.stack, max - character.overLimitStep)
            const step = character.overLimitStep + count
            const stack = character.stack - count
            updatePlayerCharacterSync(playerId, characterId, { overLimitStep: step, stack })
            total += count
            characterList.push({
                "over_limit_step": step,
                "character_id": characterId,
                "stack": stack,
                "create_time": clientSerializeDate(character.joinTime),
                "update_time": clientSerializeDate(now),
                "join_time": clientSerializeDate(character.joinTime)
            })
        }

        const missionResult = updateMissionsSync(playerId, getServerDate(), total > 0 ? [{ pattern: MissionPattern.OVER_LIMIT_TOTAL_COUNT, amount: total }] : [])
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "character_list": characterList,
                ...missionReplyFields(missionResult)
            }
        })
    }))

    // A unit that waits in the town (FT-16, src/lib/storyJoin.ts): tapping it after its story quest makes it join. The
    // client asks only while the player doesn't have it; if it already joined, nothing changes.
    fastify.post("/add_character_from_town", { schema: addCharacterFromTownSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const { character_id: characterId } = request.body as { character_id: number }
        const { viewerId, playerId } = request.viewer
        const check = townJoinCheckSync(playerId, characterId)
        if (check === "not-a-story-character") return reply.status(400).send({ "error": "Bad Request", "message": "This unit doesn't join through the story." })
        if (check === "story-not-read") return reply.status(400).send({ "error": "Bad Request", "message": "The unit's story isn't read yet." })

        const joined = check === "ok" ? givePlayerCharacterSync(playerId, characterId) : null
        if (check === "ok" && joined === null) return reply.status(400).send({ "error": "Bad Request", "message": "Could not give player character." })
        const missionResult = updateMissionsSync(playerId, getServerDate(), joined !== null ? collectionUpdatesSync(playerId) : [])

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "character_list": joined !== null ? [{ ...joined.character, "viewer_id": viewerId }] : [],
                "encyclopedia_info": joined !== null ? { [characterEncyclopediaKey(characterId)]: { "read": false } } : [],
                ...missionReplyFields(missionResult)
            }
        })
    }))

    // Locking units (FT-40): a locked unit's duplicates can't be converted one by one. Unknown ids are skipped, as the
    // armament lock does.
    fastify.post("/set_protection", { schema: setCharacterProtectionSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SetCharacterProtectionBody
        const playerId = request.viewer.playerId
        for (const [ids, protection] of [[body.protect_character_ids, true], [body.unprotect_character_ids, false]] as const) {
            for (const characterId of new Set(ids)) {
                if (getPlayerCharacterSync(playerId, characterId) !== null) updatePlayerCharacterSync(playerId, characterId, { protection })
            }
        }
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: request.viewer.viewerId }),
            "data": []
        })
    }))
}

export default routes;