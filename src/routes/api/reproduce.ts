import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";
import { integer, nullable, object } from "../schemas";

interface PostBody {
    create_time: string,
    device_log_sequence_number: number,
    viewer_id: number | null,
    device_id: number,
    info: string,
    os_name: string,
    device_name: string
}

const postSchema = { body: object({
    viewer_id: nullable(integer)
}) }

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/post", { config: { gameAuth: "none" }, schema: postSchema }, (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PostBody

        // The client's own error report: log its error text and stack trace (clipped), so a client error code such as
        // U_xxxxxx (a hash of the thrown string) can be read back (FT-79). Device and viewer ids in `info` are not logged.
        try {
            const info = typeof body?.info === "string" ? JSON.parse(body.info) as Record<string, unknown> : null
            const clip = (value: unknown) => typeof value === "string" ? value.slice(0, 2000) : undefined
            const error = clip(info?.error), stackTrace = clip(info?.stackTrace)
            if (error !== undefined || stackTrace !== undefined) request.log.warn({ clientError: error, clientStackTrace: stackTrace }, "client error report")
        } catch { /* not JSON: nothing to log */ }

        reply.header("content-type", "application/x-msgpack")
        reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: body.viewer_id || undefined
            }),
            "data": []
        })
    })
}

export default routes;