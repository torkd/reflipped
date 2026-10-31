// Attention: the bell that invites players to co-op rooms that are recruiting (src/lib/coop/recruitment.ts).

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerSync } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";
import { any, arrayOf, gameBody, integer, string } from "../schemas";
import { noteAttentionAction, notePresence, takeAttentions } from "../../lib/coop/recruitment";
import { attentionConfig } from "../../lib/coop/attentionConfig";

interface CheckBody {
    viewer_id: number
    /** attentions the client holds now */
    holding_number: number
    retry_count: number
    /** how many more it can take */
    request_number: number
}

const checkSchema = gameBody({
    holding_number: integer,
    retry_count: integer,
    request_number: integer
})

interface ActionBody {
    viewer_id: number
    /** AttentionScoreActionKind names: "Decline", "Expire", "Disconnect", "Neglect" */
    priority_factors?: string[]
}

const actionSchema = gameBody({ priority_factors: arrayOf(string) })

// client_logs: [{log_type, scene_view, attention_key, category_id, quest_id, room_number, timestamp}]
const loggerSchema = gameBody({ client_logs: any })

const routes = async (fastify: FastifyInstance) => {
    // Polled every 10 s (15 s in battle) outside co-op rooms. data.multi lists rooms to join; without it the
    // client notes "no attention".
    fastify.post("/check", { schema: checkSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CheckBody
        const viewerId = request.viewer.viewerId

        const player = getPlayerSync(request.viewer.playerId)
        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        notePresence(viewerId)
        request.log.debug({ viewerId, holding: body.holding_number }, "attention check")
        const config = attentionConfig()
        const maxHeld = config.return_attention_max_num
        const requested = Number.isInteger(body.request_number) ? body.request_number : maxHeld
        const free = Math.min(requested, maxHeld - (Number(body.holding_number) || 0))
        const multi = takeAttentions(viewerId, free)
        if (multi.length > 0) request.log.info({ viewerId, rooms: multi.map(entry => entry.quest_info.room_number) }, "co-op rooms offered")

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "config": config,
                ...(multi.length > 0 ? { "multi": multi } : {})
            }
        })
    })

    // A declined or expired attention, a disconnect from a room joined through one, or a guest force-readied for
    // idling. The reply's scores were the original's matchmaking priority; the client only logs them.
    fastify.post("/action", { schema: actionSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ActionBody
        const viewerId = request.viewer.viewerId

        const factors = Array.isArray(body.priority_factors) ? body.priority_factors.map(String) : []
        noteAttentionAction(viewerId, factors)
        request.log.info({ viewerId, factors }, "co-op attention action")

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "priority_action_score": 0,
                "priority_playing_score": 0
            }
        })
    })

    // A batch of client-side attention logs (Receive/Open/Accept/Decline/Expire), sent every attention_log_interval_seconds.
    fastify.post("/logger", { schema: loggerSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = request.viewer.viewerId

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": []
        })
    })
}

export default routes;
