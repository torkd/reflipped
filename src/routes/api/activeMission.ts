// Handles Step Up Missions (FT-2): claiming the rewards of cleared stages.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders, getServerDate } from "../../utils";
import { arrayOf, gameBody, integer, object } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import { missionResourcesSync, resourceMissionUpdatesSync, updateMissionsSync, missionReplyFields, receiveActiveMissionsSync } from "../../lib/missions";

interface ReceiveBody {
    viewer_id: number,
    api_count: number,
    active_mission_list: {
        mission_id: number,
        stages: number[]
    }[]
}

const receiveSchema = gameBody({
    api_count: integer,
    active_mission_list: arrayOf(object({ mission_id: integer, stages: arrayOf(integer) }, ["mission_id", "stages"]))
}, ["active_mission_list"])

const incentiveSchema = gameBody({ mission_id: integer }, ["mission_id"])
const transitionedUrlSchema = gameBody({ event_id: integer })

/**
 * receive_incentive's result code for a campaign that is over: the client says the reward's period has ended
 * (`ActiveMissionReceiveIncentiveRealRemote`, `OutOfPeriod`, text `active_mission_receive_ingame_reward_expired`).
 */
const INCENTIVE_OUT_OF_PERIOD = 2479

const routes = async (fastify: FastifyInstance) => {
    // The "real incentive" campaign missions (active mission event 3, the real-prize lottery, docs/missions.md) are
    // left out, so the client never lists one; a stray claim is told the campaign is over.
    fastify.post("/receive_incentive", { schema: incentiveSchema }, (request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: request.viewer.viewerId, result_code: INCENTIVE_OUT_OF_PERIOD }),
            "data": []
        })
    })

    // Sent without waiting for the reply when the player opens a real-prize campaign's web page; nothing to record.
    fastify.post("/real_incentive_transitioned_url", { schema: transitionedUrlSchema }, (request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: request.viewer.viewerId }),
            "data": []
        })
    })

    // The client claims every cleared stage of a phase at once; the rewards are granted here, not mailed.
    fastify.post("/receive", { schema: receiveSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBody

        const viewerId = request.viewer.viewerId
        const claims = body.active_mission_list.map(entry => ({ missionId: entry.mission_id, stages: entry.stages }))
        const resourcesBefore = missionResourcesSync(request.viewer.playerId)
        const result = receiveActiveMissionsSync(request.viewer.playerId, claims, getServerDate())
        if (result === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player data."
        })

        const progress = updateMissionsSync(request.viewer.playerId, getServerDate(), resourceMissionUpdatesSync(request.viewer.playerId, resourcesBefore))

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                ...missionReplyFields(progress, result.mailArrived),
                "active_mission_list": [...result.activeMissions, ...progress.activeMissions],
                "user_info": result.userInfo,
                "item_list": result.itemList
            }
        })
    }))
}

export default routes;
