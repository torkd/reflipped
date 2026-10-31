import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { clientSerializeDate, tutorialFinishedTriggerId, tutorialGachaCharacterIds } from "../../data/utils";
import { getPlayerCharactersSync, getPlayerSync, getPlayerTriggeredTutorialsSync, insertDefaultPlayerCharacterSync, insertPlayerTriggeredTutorialSync, updatePlayerSync } from "../../data/wdfpData";
import { generateDataHeaders, getServerDate, getServerTime } from "../../utils";
import { getFallbackGachaSync, getGachaSync } from "../../lib/assets";
import { randomPoolItem, rewardPlayerGachaDrawResultSync } from "../../lib/gacha";
import { randomInt } from "crypto";
import { GachaCharacterDraw } from "../../lib/types";
import { arrayOf, boolean, gameBody, integer, playerText, string } from "../schemas";
import { atomicHandler } from "../../lib/atomic";

interface UpdateStepBody {
    viewer_id: number
    step: number
    api_count: number
    skip: boolean
    statistics: Object
    name?: string
    gacha_id?: number
}

interface FinishTriggerBody {
    api_count: number,
    tutorial_ids: number[],
    viewer_id: number
}

const freeTutorialCharacterId = 243001

const updateStepSchema = gameBody({
    step: integer,
    api_count: integer,
    skip: boolean,
    name: playerText,
    gacha_id: integer
}, ["step"])

const finishTriggerSchema = gameBody({
    api_count: integer,
    tutorial_ids: arrayOf(integer)
}, ["tutorial_ids"])

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/finish_trigger", { schema: finishTriggerSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as FinishTriggerBody

        const viewerId = request.viewer.viewerId
        const tutorialIds = body.tutorial_ids
        if (!tutorialIds || !(tutorialIds instanceof Array)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // mark tutorial as having been completed
        // ids the player already has are skipped: a resent report must not fail on the primary key (500), because
        // the client retries it forever
        const alreadyTriggered = new Set(getPlayerTriggeredTutorialsSync(playerId))
        for (const tutorialId of new Set(tutorialIds)) {
            if (!alreadyTriggered.has(tutorialId)) insertPlayerTriggeredTutorialSync(playerId, tutorialId)
        }

        reply.header("content-type", "application/x-msgpack")
        reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": []
        })
    }))

    fastify.post("/update_step", { schema: updateStepSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UpdateStepBody

        const viewerId = request.viewer.viewerId
        const completedStep = body.step
        const skip = body.skip || false
        if (isNaN(completedStep)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        // check if tutorial is already completed
        const completedTutorial = getPlayerTriggeredTutorialsSync(playerId)
        if (completedTutorial.find((value: number) => value === tutorialFinishedTriggerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Tutorial already completed"
        })

        // update player
        const currentStep = player.tutorialStep
        let nextStep = completedStep + 1
        // whether this request moves the tutorial on, or repeats the step it is at
        const firstTime = (currentStep || 0) < nextStep

        if ((currentStep || 0) > nextStep) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Attempt to redo previous tutorial step."
        })

        updatePlayerSync({
            id: playerId,
            tutorialStep: nextStep,
            tutorialSkipFlag: skip,
            name: body.name
        })
        
        // offset nextStep by 11 if skipped, to keep steps the same.
        nextStep += (body.skip ? 11 : 0)
        
        reply.header("content-type", "application/x-msgpack")
        const headers = generateDataHeaders({
            viewer_id: viewerId
        })
        if (nextStep === 15 && body.gacha_id !== undefined && !isNaN(body.gacha_id)) {
            // the tutorial pull happens once: a repeated step 14 would pull again for every request (a client retry
            // gets the stored reply from the replay guard instead) (SEC-15)
            if (!firstTime) return reply.status(400).send({
                "error": "Bad Request",
                "message": "The tutorial pull was already made."
            })

            // The tutorial pull must never block the tutorial: if the client names a gacha that isn't in the server's
            // table (a portal newer than assets/gacha.json), pull from a regular portal instead.
            const gachaId = body.gacha_id
            const gachaData = getGachaSync(gachaId) ?? getFallbackGachaSync(getServerDate())
            if (gachaData === null) return reply.status(400).send({
                "error": "Bad Request",
                "message": `Gacha with id '${body.gacha_id}' does not exist.`
            })

            // perform pull
            const drawResult: Map<number, number> = new Map()
            const randomCharacterIndex = randomInt(0, tutorialGachaCharacterIds.length)
            const randomCharacterId = tutorialGachaCharacterIds[randomCharacterIndex]
            drawResult.set(randomCharacterId, 1)

            // reward pull
            const rewardResult = rewardPlayerGachaDrawResultSync(playerId, gachaData, drawResult)

            const newFreeVmoney = Math.max(0, player.freeVmoney - gachaData.singleCost)
            updatePlayerSync({
                id: playerId,
                freeVmoney: newFreeVmoney
            })

            const draw = rewardResult.draw[0] as GachaCharacterDraw
            draw.movie_id = "normal_guarantee"
            draw.seed = 10007656

            return reply.status(200).send({
                "data_headers": headers,
                "data": {
                    "step": nextStep,
                    "user_info": {
                        "free_vmoney": newFreeVmoney,
                    },
                    "gacha": {
                        "draw": rewardResult.draw,
                        "gacha_info_list": [
                            {
                                "gacha_id": gachaId,
                                "is_account_first": false,
                                "is_daily_first": false,
                            }
                        ],
                    },
                    "character_list": rewardResult.characters,
                    "item_list": rewardResult.items,
                    "encyclopedia_info": [],
                    "mail_arrived": false,
                    "start_time": getServerTime()
                }
            })
        } else if (nextStep === 16) {
            // The gift is given once: the client resends a step when its reply was lost, and a second grant would
            // either double the vmoney or fail on the character that's already there, leaving the tutorial stuck.
            // Whether it was given is judged by the character (not by the step, which is saved before the gift).
            const alreadyGiven = String(freeTutorialCharacterId) in getPlayerCharactersSync(playerId)

            // give free character
            const serializedDate = clientSerializeDate(new Date())

            if (!alreadyGiven) insertDefaultPlayerCharacterSync(playerId, freeTutorialCharacterId)

            // give 1500 vmoney
            const newVMoney = alreadyGiven ? player.freeVmoney : player.freeVmoney + 1500
            if (!alreadyGiven) updatePlayerSync({
                id: playerId,
                freeVmoney: newVMoney
            })

            reply.status(200).send({
                "data_headers": headers,
                "data": {
                    "step": nextStep,
                    "user_info": {
                        "free_vmoney": newVMoney
                    },
                    "character_list": [
                        {
                            "viewer_id": viewerId,
                            "character_id": freeTutorialCharacterId,
                            "entry_count": 1,
                            "exp": 0,
                            "exp_total": 0,
                            "bond_token_list": [
                                {
                                    "mana_board_index": 1,
                                    "status": 0
                                },
                                {
                                    "mana_board_index": 2,
                                    "status": 0
                                }
                            ],
                            "mana_board_index": 1,
                            "create_time": serializedDate,
                            "update_time": serializedDate,
                            "join_time": serializedDate
                        }
                    ],
                    "encyclopedia_info": {
                        [`1${freeTutorialCharacterId}01`]: {
                            "read": false
                        }
                    },
                    "mail_arrived": true,
                    "start_time": getServerTime()
                }
            })
        } else {
            
            reply.status(200).send({
                "data_headers": headers,
                "data": {
                    "step": nextStep,
                    "mail_arrived": true,
                    "start_time": getServerTime()
                }
            })
        }
        
        
    }))
}

export default routes;