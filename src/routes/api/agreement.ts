// The game's own terms and privacy agreement (`UserPolicyProcessingDialog`): agreement/agree_terms,
// agreement/agree_privacy and agreement/agree_all send the versions the player accepted. It belongs to the terms flow
// that starts with tool/agreement (`TermsOfServiceLoadingTask`), which the global client doesn't run: the Kakao SDK
// shows the agreements there (openapi `agreement/getForLogin`). Nothing is recorded; the reply only lets the dialog close.
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";
import { integer, nullable, object } from "../schemas";

// The flow may run before the player exists (the client sends the viewer id it has stored, if any), so these routes
// skip the game authentication: they change nothing.
const agreeSchema = { body: object({ viewer_id: nullable(integer), terms_version: integer, privacy_version: integer }) }

const routes = async (fastify: FastifyInstance) => {
    for (const route of ["/agree_terms", "/agree_privacy", "/agree_all"]) {
        fastify.post(route, { config: { gameAuth: "none" }, schema: agreeSchema }, (request: FastifyRequest, reply: FastifyReply) => {
            const body = request.body as { viewer_id?: number | null }
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: body.viewer_id ?? 0 }),
                "data": []
            })
        })
    }
}

export default routes;
