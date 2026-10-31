import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import "@fastify/multipart"; // request.file()
import { deserializePlayerData, getClientSerializedData } from "../../data/utils";
import { getAllPlayersSync, getPlayerReceivableMailListSync, getPlayerSync, replacePlayerDataSync } from "../../data/wdfpData";
import { MailType } from "../../data/types";
import { revertUnlock, unlockEverything } from "../../lib/developerMode";
import { sendPlayerMailSync } from "../../lib/mail";
import { deletePlayer, resetPlayer } from "../../lib/playerAdmin";
import { getServerDate } from "../../utils";
import { integer, jsonBody, nullable, query, string, stringOrInteger } from "../schemas";
import { InvalidSaveError, validateSaveData } from "../../data/saveSchema";

interface SaveQuery {
    id: string | undefined
}

interface GetPlayersQuery {
    page: string | undefined,
    perPage: string | undefined
}

interface SendMailBody {
    type: string | number
    typeId?: number | null
    number: number
    subject: string
    description: string
    rewardLimitTime?: string | null // ISO date (UTC)
}

const defaultPerPage = 25

// SEC-6 schemas. Player ids come in the query string as digits.
const digits = { type: "string", pattern: "^[0-9]{1,15}$" }
const playerQuerySchema = query({ id: digits }, ["id"])
const getPlayersSchema = query({ page: digits, perPage: digits })
const sendMailSchema = {
    ...playerQuerySchema,
    ...jsonBody({
        type: stringOrInteger,
        typeId: nullable(integer),
        number: integer,
        subject: { type: "string", maxLength: 1000 },
        description: { type: "string", maxLength: 10000 },
        rewardLimitTime: nullable(string)
    }, ["type", "subject", "description"])
}
const developerModeSchema = query({ id: digits, state: { enum: ["on", "off"] } }, ["id"])

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", { schema: getPlayersSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        // get page and perPage
        const { page, perPage } = request.query as GetPlayersQuery
        const parsedPage = page === undefined ? 0 : Number.parseInt(page)
        const parsedPerPage = perPage === undefined ? defaultPerPage : Number.parseInt(perPage)
        if (isNaN(parsedPage) || isNaN(parsedPerPage)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid query parameters."
        })

        // get players
        const players = getAllPlayersSync(parsedPage * parsedPerPage, Math.min(defaultPerPage, parsedPerPage))

        return reply.status(200).send(players)
    })

    fastify.get("/save", { schema: playerQuerySchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        // get id
        const { id } = request.query as SaveQuery
        const playerId = Number(id)
        if (isNaN(playerId)) return reply.redirect("/player");

        // get player
        const data = getClientSerializedData(playerId, { serializeRushEventData: true })
        if (data === null) return reply.redirect("/player");

        // otherwise, send
        reply.header("content-disposition", "attachment; save.json")
        reply.type('application/json').send(data)
    })

    // Replaces a player's save with an uploaded file (the admin page's "Upload save"). The file is size-limited
    // (multipart `fileSize`, `maxSaveFileBytes`), checked against `saveSchema` and imported in one transaction, so a
    // bad file changes nothing. The page shows a fixed message per outcome; details go to the log.
    fastify.post("/save", { schema: playerQuerySchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.query as SaveQuery
        const playerId = Number(id)
        if (!Number.isInteger(playerId) || getPlayerSync(playerId) === null) return reply.redirect("/player");

        let parsed
        try {
            const file = await request.file()
            if (file === undefined) return reply.redirect(`/player/${playerId}?error=save-missing`);
            const saveData = validateSaveData(JSON.parse((await file.toBuffer()).toString("utf-8")))
            parsed = deserializePlayerData(playerId, saveData)
        } catch (error) {
            const tooLarge = error instanceof Error && (error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE"
            const code = tooLarge ? "save-too-large" : "save-invalid"
            // JSON.parse quotes the file in its message, so only our own schema texts are logged (OPS-2)
            const reason = error instanceof InvalidSaveError || tooLarge ? (error as Error).message
                : error instanceof SyntaxError ? "not valid JSON" : "unreadable save"
            request.log.warn({ playerId, reason }, "save import rejected")
            return reply.redirect(`/player/${playerId}?error=${code}`);
        }

        try {
            replacePlayerDataSync(parsed)
        } catch (error) {
            request.log.error({ playerId, err: error }, "save import failed")
            return reply.redirect(`/player/${playerId}?error=save-failed`);
        }

        return reply.redirect(`/player/${playerId}?message=save-imported`);
    })

    // lists the mail a player can still receive
    fastify.get("/mail", { schema: playerQuerySchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.query as SaveQuery
        const playerId = Number(id)
        if (isNaN(playerId) || getPlayerSync(playerId) === null) return reply.status(404).send({
            "error": "Not Found",
            "message": "No such player."
        })

        return reply.status(200).send(getPlayerReceivableMailListSync(playerId, getServerDate(), 0, 1000))
    })

    // sends a mail to a player's gift box; `type` is a MailType name ("ITEM") or number
    fastify.post("/mail", { schema: sendMailSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.query as SaveQuery
        const playerId = Number(id)
        if (isNaN(playerId) || getPlayerSync(playerId) === null) return reply.status(404).send({
            "error": "Not Found",
            "message": "No such player."
        })

        const body = request.body as SendMailBody | undefined
        const type = typeof body?.type === "string" && isNaN(Number(body.type))
            ? MailType[body.type.toUpperCase() as keyof typeof MailType]
            : Number(body?.type)
        const rewardLimitTime = body?.rewardLimitTime ? new Date(body.rewardLimitTime) : null
        if (body === undefined || type === undefined || typeof body.subject !== "string" || typeof body.description !== "string"
            || (rewardLimitTime !== null && isNaN(rewardLimitTime.getTime()))) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        try {
            const mailId = sendPlayerMailSync(playerId, {
                type: type,
                typeId: body.typeId ?? null,
                number: body.number,
                subject: body.subject,
                description: body.description,
                rewardLimitTime: rewardLimitTime
            })
            return reply.status(200).send({ id: mailId })
        } catch (error: Error | any) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": error.message
            })
        }
    })

    // Developer mode: "on" unlocks everything (the player's own save is kept), "off" restores it.
    fastify.post("/developer-mode", { schema: developerModeSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id, state } = request.query as SaveQuery & { state: string | undefined }
        const playerId = Number(id)
        if (isNaN(playerId)) return reply.redirect("/player");
        try {
            // the page shows fixed texts for these codes (src/routes/web/player.ts)
            let message: string
            if (state === "on") {
                if (unlockEverything(playerId) === null) return reply.redirect("/player");
                message = "dev-on"
            } else if (state === "off") {
                message = revertUnlock(playerId) ? "dev-off" : "dev-already-off"
            } else {
                return reply.redirect(`/player/${playerId}`);
            }
            return reply.redirect(`/player/${playerId}?message=${message}`);
        } catch (error) {
            request.log.error({ playerId, state, err: error }, "developer mode switch failed")
            return reply.redirect(`/player/${playerId}?error=dev-failed`);
        }
    })

    // Start over: a fresh default player on the same account (the device stays signed in).
    fastify.post("/reset", { schema: playerQuerySchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.query as SaveQuery
        const playerId = Number(id)
        if (isNaN(playerId)) return reply.redirect("/player");
        const newPlayerId = resetPlayer(playerId)
        if (newPlayerId === null) return reply.redirect("/player");
        return reply.redirect(`/player/${newPlayerId}?message=reset`);
    })

    // Delete the player's account and everything on it.
    fastify.post("/delete", { schema: playerQuerySchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.query as SaveQuery
        const playerId = Number(id)
        if (isNaN(playerId)) return reply.redirect("/player");
        deletePlayer(playerId)
        return reply.redirect("/player");
    })
}

export default routes;
