import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import "@fastify/multipart"; // request.file()
import { getClientSerializedData } from "../../data/utils";
import { getAllPlayersSync, getPlayerReceivableMailListSync, getPlayerSync } from "../../data/wdfpData";
import { rejectAutomaticRewardMutation, requireManagedRewards } from "../../lib/rewardPolicy";
import { runOnPlayerClockSync } from "../../lib/playerClock";
import { MailType } from "../../data/types";
import { revertUnlock, unlockEverything } from "../../lib/developerMode";
import { InvalidMailError, sendMailToAllPlayersSync, sendPlayerMailSync, SendMailOptions } from "../../lib/mail";
import { deletePlayer, resetPlayer } from "../../lib/playerAdmin";
import { restoreDeletedSaveSync } from "../../lib/saveDeletion";
import { getServerDate } from "../../utils";
import { mailLimits } from "../../lib/limits";
import { integer, jsonBody, nullable, query, string, stringOrInteger } from "../schemas";
import { importPlayerSave } from "../../lib/playerSaveImport";

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
const sendMailToAllSchema = { body: sendMailSchema.body }
const developerModeSchema = query({ id: digits, state: { enum: ["on", "off"] } }, ["id"])

/** The send mail form's body as mail options, or null if it is malformed. */
function parseSendMailBody(body: SendMailBody | undefined): SendMailOptions | null {
    const type = typeof body?.type === "string" && isNaN(Number(body.type))
        ? MailType[body.type.toUpperCase() as keyof typeof MailType]
        : Number(body?.type)
    const rewardLimitTime = body?.rewardLimitTime ? new Date(body.rewardLimitTime) : null
    if (body === undefined || type === undefined || typeof body.subject !== "string" || typeof body.description !== "string"
        || (rewardLimitTime !== null && isNaN(rewardLimitTime.getTime()))) return null
    return {
        type: type,
        typeId: body.typeId ?? null,
        number: body.number,
        subject: body.subject,
        description: body.description,
        rewardLimitTime: rewardLimitTime
    }
}

function invalidMailBody(reply: FastifyReply) {
    return reply.status(400).send({
        "error": "Bad Request",
        "message": "Invalid request body."
    })
}

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

        // on the player's clock (FT-5), as their own /load would see it: which mail has expired depends on it
        const data = runOnPlayerClockSync(playerId, () => getClientSerializedData(playerId, { serializeRushEventData: true, serializeSaveData: true }))
        if (data === null) return reply.redirect("/player");

        // otherwise, send
        reply.header("content-disposition", `attachment; filename="reflipped-save-${playerId}.json"`)
        reply.type('application/json').send(data)
    })

    // Replaces a player's save with an uploaded file (the admin page's "Upload save"). The file is size-limited
    // (multipart `fileSize`, `maxSaveFileBytes`), checked against `saveSchema` and imported in one transaction, so a
    // bad file changes nothing. The page shows a fixed message per outcome; details go to the log.
    fastify.post("/save", { schema: playerQuerySchema, preHandler: requireManagedRewards }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.query as SaveQuery
        const playerId = Number(id)
        if (!Number.isInteger(playerId) || getPlayerSync(playerId) === null) return reply.redirect("/player");

        let buffer: Buffer
        try {
            const file = await request.file()
            if (file === undefined) return reply.redirect(`/player/${playerId}?error=save-missing`);
            buffer = await file.toBuffer()
        } catch (error) {
            const tooLarge = error instanceof Error && (error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE"
            request.log.warn({ playerId, reason: tooLarge ? (error as Error).message : "unreadable upload" }, "save import rejected")
            return reply.redirect(`/player/${playerId}?error=${tooLarge ? "save-too-large" : "save-invalid"}`);
        }
        const result = importPlayerSave(playerId, buffer, request.log)
        if (result === "automatic") return rejectAutomaticRewardMutation(reply)
        if (result === "invalid") return reply.redirect(`/player/${playerId}?error=save-invalid`);
        if (result === "failed") return reply.redirect(`/player/${playerId}?error=save-failed`);
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

        // what the player can still receive on their own clock (FT-5)
        return reply.status(200).send(runOnPlayerClockSync(playerId, () => getPlayerReceivableMailListSync(playerId, getServerDate(), 0, mailLimits.pendingMails)))
    })

    // sends a mail to a player's gift box; `type` is a MailType name ("ITEM") or number
    fastify.post("/mail", { schema: sendMailSchema, preHandler: requireManagedRewards }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.query as SaveQuery
        const playerId = Number(id)
        if (isNaN(playerId) || getPlayerSync(playerId) === null) return reply.status(404).send({
            "error": "Not Found",
            "message": "No such player."
        })

        const options = parseSendMailBody(request.body as SendMailBody | undefined)
        if (options === null) return invalidMailBody(reply)

        try {
            return reply.status(200).send({ id: sendPlayerMailSync(playerId, options) })
        } catch (error) {
            // only our own texts reach the page; anything else is the shared error handler's 500 (src/lib/logging.ts)
            if (!(error instanceof InvalidMailError)) throw error
            return reply.status(400).send({
                "error": "Bad Request",
                "message": error.message
            })
        }
    })

    // sends the same mail to every player (the Players page); answers how many got it and how many were skipped
    fastify.post("/mail/all", { schema: sendMailToAllSchema, preHandler: requireManagedRewards }, async (request: FastifyRequest, reply: FastifyReply) => {
        const options = parseSendMailBody(request.body as SendMailBody | undefined)
        if (options === null) return invalidMailBody(reply)

        try {
            return reply.status(200).send(sendMailToAllPlayersSync(options))
        } catch (error) {
            // An invalid mail is refused before anything is written. Anything else rolled the transaction back, so
            // nothing was sent; the shared error handler logs it and answers 500 with the request ID (src/lib/logging.ts).
            if (!(error instanceof InvalidMailError)) throw error
            return reply.status(400).send({
                "error": "Bad Request",
                "message": error.message
            })
        }
    })

    // Developer mode: "on" unlocks everything (the player's own save is kept), "off" restores it.
    fastify.post("/developer-mode", { schema: developerModeSchema, preHandler: requireManagedRewards }, async (request: FastifyRequest, reply: FastifyReply) => {
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
    fastify.post("/reset", { schema: playerQuerySchema, preHandler: requireManagedRewards }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.query as SaveQuery
        const playerId = Number(id)
        if (isNaN(playerId)) return reply.redirect("/player");
        const newPlayerId = resetPlayer(playerId)
        if (newPlayerId === null) return reply.redirect("/player");
        return reply.redirect(`/player/${newPlayerId}?message=reset`);
    })

    // FT-59: puts a save a player deleted back on its account (src/lib/saveDeletion.ts)
    fastify.post("/restoreDeleted", { schema: playerQuerySchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.query as SaveQuery
        const keptId = Number(id)
        let result: ReturnType<typeof restoreDeletedSaveSync>
        try {
            result = restoreDeletedSaveSync(keptId)
        } catch (error) {
            request.log.error({ keptId, err: error }, "deleted save restore failed")
            return reply.redirect("/player?error=restore-failed")
        }
        request.log.info({ userId: request.adminUser?.id ?? null, keptId, result }, "deleted save restore")
        if (result === "restored") return reply.redirect("/player?message=restored")
        return reply.redirect(`/player?error=restore-${result}`)
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
