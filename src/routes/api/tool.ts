import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SessionType } from "../../data/types";
import { generateViewerIdSession, getAccountSessionsOfType, getPlayerFromAccountIdSync, getSession, insertDefaultPlayerSync, updateSessionUdidSync } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";
import { renewViewerSession } from "../../lib/gameAuth";
import { integer, nullable, object, string } from "../schemas";

interface GetHeaderResponseBody {
    viewer_id: number
}

interface SignupBody {
    app_secret: string
    access_token: string
    storage_directory_path: string
    app_admin: string
    kakao_pid: string,
    device_id: number,
    idp_code: string
}

// runs before signup too, so viewer_id may be missing
const getHeaderResponseSchema = { body: object({ viewer_id: nullable(integer) }) }

const signupSchema = { body: object({
    access_token: string
}, ["access_token"]) }

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_header_response", { config: { gameAuth: "none" }, schema: getHeaderResponseSchema }, (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetHeaderResponseBody

        reply.header("content-type", "application/x-msgpack")

        reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: body.viewer_id
            }),
            "data": []
        })
    })

    fastify.post("/signup", { config: { gameAuth: "none" }, schema: signupSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as SignupBody
        
        const zat = body.access_token
        if (!zat) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const udid = request.headers['udid']
        if (typeof udid !== "string" || !udid) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid headers."
        })

        const session = await getSession(zat)
        if (session === null || session.type !== SessionType.ZAT) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid zat provided."
        })

        const accountId = session.accountId

        // Create the player data if it doesn't exist.
        const accountPlayer = getPlayerFromAccountIdSync(accountId)
        if (accountPlayer === null) {    
            // create new player account
            insertDefaultPlayerSync(accountId)
        }

        // generate viewer id
        const viewerIds = await getAccountSessionsOfType(accountId, SessionType.VIEWER)
        const viewerId = !viewerIds[0] ? await generateViewerIdSession(accountId) : viewerIds[0]
        renewViewerSession(viewerId)
        // the client signs every later game request with this UDID (PARAM, src/lib/gameAuth.ts)
        if (viewerId.udid !== udid) updateSessionUdidSync(viewerId.token, udid)

        reply.header("content-type", "application/x-msgpack")
        reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: Number.parseInt(viewerId.token),
                udid: udid
            }, ['short_udid', 'viewer_id', 'udid', 'servertime', 'result_code']),
            "data": []
        })
    })
}

export default routes;