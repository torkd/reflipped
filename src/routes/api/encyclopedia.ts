// Handles the insertion of mana into characters.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";
import encyclopedia from "../../../assets/encyclopedia.json";
import { arrayOf, gameBody, integer } from "../schemas";

interface IndexBody {
    api_count: number,
    viewer_id: number,
}

interface ReadKeywordBody {
    encyclopedia_ids: number[],
    viewer_id: number
}

const readKeywordSchema = gameBody({
    encyclopedia_ids: arrayOf(integer)
}, ["encyclopedia_ids"])

const indexSchema = gameBody({ api_count: integer })

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/read_keyword", { schema: readKeywordSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReadKeywordBody

        const viewerId = request.viewer.viewerId
        const encyclopediaIds = body.encyclopedia_ids
        if (encyclopediaIds === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const encyclopediaList: Record<string, object> = {}
        for (const id of encyclopediaIds) {
            encyclopediaList[id] = {
                "read": true
            }
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "encyclopedia_list": encyclopediaList
            }
        })
    })

    fastify.post("/index", { schema: indexSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as IndexBody

        const viewerId = request.viewer.viewerId

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "encyclopedia_list": encyclopedia,
                "mail_arrived": false
            }
        })
    })
}

export default routes;