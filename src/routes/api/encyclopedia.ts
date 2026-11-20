// Encyclopedia read history is per player. Availability remains the emulator's existing broad catalogue policy.
import { FastifyInstance } from "fastify";
import { generateDataHeaders } from "../../utils";
import { arrayOf, gameBody, integer } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import { getPlayerEncyclopediaSync, isKnownEncyclopediaId, updatePlayerEncyclopediaSync } from "../../data/encyclopedia";

interface KeywordBody { encyclopedia_ids: number[] }
const keywordSchema = gameBody({ encyclopedia_ids: arrayOf(integer) }, ["encyclopedia_ids"])
const indexSchema = gameBody({ api_count: integer })

const routes = async (fastify: FastifyInstance) => {
    for (const [route, read] of [["read_keyword", true], ["unlock_keyword", false]] as const) {
        fastify.post(`/${route}`, { schema: keywordSchema }, atomicHandler((request, reply) => {
            const { encyclopedia_ids: ids } = request.body as KeywordBody
            // Validate before writing any row: unknown composite IDs can stop the client's master lookup (C8601).
            if (ids.some(id => !isKnownEncyclopediaId(id)))
                return reply.status(400).send({ error: "Bad Request", message: "Unknown encyclopedia entry." })
            const list = updatePlayerEncyclopediaSync(request.viewer.playerId, ids, read)
            return reply.header("content-type", "application/x-msgpack").status(200).send({
                data_headers: generateDataHeaders({ viewer_id: request.viewer.viewerId }),
                data: { encyclopedia_list: list }
            })
        }))
    }

    fastify.post("/index", { schema: indexSchema }, async (request, reply) => {
        return reply.header("content-type", "application/x-msgpack").status(200).send({
            data_headers: generateDataHeaders({ viewer_id: request.viewer.viewerId }),
            data: { encyclopedia_list: getPlayerEncyclopediaSync(request.viewer.playerId), mail_arrived: false }
        })
    })
}

export default routes;
