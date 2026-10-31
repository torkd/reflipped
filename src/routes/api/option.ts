import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { updatePlayerOptionsSync } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";
import { boolean, gameBody, integer, recordOf } from "../schemas";
import { atomicHandler } from "../../lib/atomic";

interface UpdateBody {
    viewer_id: number
    api_count: number
    option_params: Record<string, boolean>
}

const updateRoute = atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as UpdateBody

    const viewerId = request.viewer.viewerId

    const playerId = request.viewer.playerId

    // update options
    const updatedOptions = body.option_params
    updatePlayerOptionsSync(playerId, updatedOptions)
    
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        "data_headers": generateDataHeaders({
            viewer_id: viewerId
        }),
        "data": {
            "user_option": updatedOptions
        }
    })
})

const updateSchema = gameBody({
    api_count: integer,
    option_params: recordOf(boolean, { maxKeys: 128, maxKeyLength: 64 })
}, ["option_params"])

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/update", { schema: updateSchema }, updateRoute)

    fastify.post("/update_in_battle", { schema: updateSchema }, updateRoute)
}

export default routes;