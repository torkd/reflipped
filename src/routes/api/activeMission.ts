// Handles Step Up Missions (FT-2): claiming the rewards of cleared stages.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders, getServerDate } from "../../utils";
import { arrayOf, gameBody, integer, object } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import { receiveActiveMissionsSync } from "../../lib/missions";

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

const routes = async (fastify: FastifyInstance) => {
    // The client claims every cleared stage of a phase at once; the rewards are granted here, not mailed.
    fastify.post("/receive", { schema: receiveSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBody

        const viewerId = request.viewer.viewerId
        const claims = body.active_mission_list.map(entry => ({ missionId: entry.mission_id, stages: entry.stages }))
        const result = receiveActiveMissionsSync(request.viewer.playerId, claims, getServerDate())
        if (result === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player data."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "active_mission_list": result.activeMissions,
                "user_info": result.userInfo,
                "item_list": result.itemList,
                "mail_arrived": result.mailArrived
            }
        })
    }))
}

export default routes;
