// Handles the player's titles (degrees): the title list and setting one.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { updatePlayerSync } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";
import { gameBody, integer } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import { getPlayerOwnedDegreeIdsSync } from "../../lib/degrees";

interface UpdateDegreeBody {
    viewer_id: number,
    api_count: number,
    degree_id: number
}

const getDegreeListSchema = gameBody({ api_count: integer })

const updateDegreeSchema = gameBody({
    api_count: integer,
    degree_id: integer
}, ["degree_id"])

const routes = async (fastify: FastifyInstance) => {
    // The title screen: every title the player owns (`degree_ids`).
    fastify.post("/get_degree_list", { schema: getDegreeListSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = request.viewer.viewerId

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "degree_ids": getPlayerOwnedDegreeIdsSync(request.viewer.playerId)
            }
        })
    })

    // Sets the title shown on the player's profile; only an owned one.
    fastify.post("/update_degree", { schema: updateDegreeSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UpdateDegreeBody

        const viewerId = request.viewer.viewerId
        const playerId = request.viewer.playerId
        const degreeId = body.degree_id
        if (!getPlayerOwnedDegreeIdsSync(playerId).includes(degreeId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Title not owned."
        })

        updatePlayerSync({ id: playerId, degreeId })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "degree_id": degreeId
                },
                "mail_arrived": false
            }
        })
    }))
}

export default routes;
