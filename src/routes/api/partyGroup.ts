// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerSync, updatePlayerPartyGroupSync } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";
import { arrayOf, gameBody, integer, object } from "../schemas";
import { atomicHandler } from "../../lib/atomic";

interface EditBody {
    viewer_id: number
    api_count: number
    retry_count: number
    party_group_edit_params_list: {
        party_group_id: number,
        party_category: number,
        party_group_color_id: number
    }[]
}

const editSchema = gameBody({
    api_count: integer,
    retry_count: integer,
    party_group_edit_params_list: arrayOf(object({
        party_group_id: integer,
        party_category: integer,
        party_group_color_id: integer
    }, ["party_group_id", "party_category", "party_group_color_id"]))
}, ["party_group_edit_params_list"])

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/edit", { schema: editSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as EditBody

        const viewerId = request.viewer.viewerId

        const playerId = request.viewer.playerId
        const player = getPlayerSync(playerId)

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // update party groups
        for (const editParamsList of body.party_group_edit_params_list) {
            updatePlayerPartyGroupSync(playerId, editParamsList.party_group_id, editParamsList.party_group_color_id)
        }
        
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {}
        })
    }))
}

export default routes;