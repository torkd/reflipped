// Handles mail.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerReceivableMailCountSync, getPlayerReceivableMailListSync } from "../../data/wdfpData";
import { clientSerializeMail, mailPageSize, receivePlayerMailsSync } from "../../lib/mail";
import { generateDataHeaders, getServerDate } from "../../utils";
import { arrayOf, gameBody, integer } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import { collectionUpdatesSync, missionReplyFields, updateMissionsSync } from "../../lib/missions";

interface IndexBody {
    api_count: number,
    viewer_id: number,
    app_secret: string,
    current_page: number,
    app_admin: string
}

interface ReceiveBody {
    mail_id: number,
    api_count: number,
    viewer_id: number
}

interface ReceiveAllBody {
    mail_ids: number[],
    api_count: number,
    viewer_id: number
}

const indexSchema = gameBody({
    api_count: integer,
    current_page: integer
})

const receiveSchema = gameBody({
    mail_id: integer,
    api_count: integer
}, ["mail_id"])

const receiveAllSchema = gameBody({
    mail_ids: arrayOf(integer, 10000),
    api_count: integer
}, ["mail_ids"])

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/index", { schema: indexSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as IndexBody

        const viewerId = request.viewer.viewerId

        const playerId = request.viewer.playerId

        // pages start at 1
        const page = Math.max(1, Math.floor(Number(body.current_page) || 1))
        const now = getServerDate()
        const mailList = getPlayerReceivableMailListSync(playerId, now, (page - 1) * mailPageSize, mailPageSize)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "mail": mailList.map(mail => clientSerializeMail(mail)),
                "total_count": getPlayerReceivableMailCountSync(playerId, now)
            }
        })
    }))

    fastify.post("/receive", { schema: receiveSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBody

        const viewerId = request.viewer.viewerId
        const mailId = body.mail_id
        if (!Number.isInteger(mailId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        const result = receivePlayerMailsSync(playerId, [mailId])
        if (result === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player data."
        })

        // missions (FT-2): units and armaments received count; rewards they clear arrive as new mail
        const missionResult = updateMissionsSync(playerId, getServerDate(), result.receivedMailIds.length > 0 ? collectionUpdatesSync(playerId) : [])
        const remainingCount = getPlayerReceivableMailCountSync(playerId, getServerDate())

        // The original server answered a missing, already received or expired mail with result codes
        // 2001, 2002 and 2004. Reflipped never lists such mail, so this only happens on a race.
        if (result.receivedMailIds.length === 0) return reply.status(400).send({
            "error": "Bad Request",
            "message": result.maxOveredMailCount > 0 ? "Mail would take the player past a limit." : "Mail cannot be received."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": result.userInfo,
                "character_list": result.characterList,
                "equipment_list": result.equipmentList,
                "item_list": result.itemList,
                "dispose_expired_mail": false,
                "auto_sale_expired_mail": false,
                "total_count": remainingCount,
                ...missionReplyFields(missionResult, remainingCount > 0)
            }
        })
    }))

    fastify.post("/receive_all", { schema: receiveAllSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveAllBody

        const viewerId = request.viewer.viewerId
        const mailIds = body.mail_ids
        if (!Array.isArray(mailIds) || !mailIds.every(id => Number.isInteger(id))) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        const result = receivePlayerMailsSync(playerId, mailIds)
        if (result === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player data."
        })

        // missions (FT-2): units and armaments received count; rewards they clear arrive as new mail
        const missionResult = updateMissionsSync(playerId, getServerDate(), result.receivedMailIds.length > 0 ? collectionUpdatesSync(playerId) : [])
        const remainingCount = getPlayerReceivableMailCountSync(playerId, getServerDate())

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": result.userInfo,
                "character_list": result.characterList,
                "equipment_list": result.equipmentList,
                "item_list": result.itemList,
                "mail_ids": result.receivedMailIds,
                "deleted_mail_count": result.deletedMailCount,
                "already_mail_count": result.alreadyMailCount,
                "outdated_mail_count": result.outdatedMailCount,
                "dispose_expired_mail_count": 0,
                "auto_sale_expired_mail_count": 0,
                "max_overed_mail_count": result.maxOveredMailCount,
                "total_count": remainingCount,
                ...missionReplyFields(missionResult, remainingCount > 0)
            }
        })
    }))
}

export default routes;
