import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SessionType } from "../../data/types";
import { getClientSerializedData, serializePlayerData } from "../../data/utils";
import { getPlayerFromAccountIdSync, insertDefaultPlayerSync, insertSessionWithToken, viewerSessionExpiry, collectPlayerDataPooledExpSync, collectPlayerPooledExpSync, getAccountPlayers, getPlayerActiveMissionsSync, getPlayerBoxGachasSync, getPlayerCharactersManaNodesSync, getPlayerCharactersSync, getPlayerClearedRegularMissionListSync, getPlayerDailyChallengePointListSync, getPlayerDrawnQuestsSync, getPlayerEquipmentListSync, getPlayerGachaInfoListSync, getPlayerItemsSync, getPlayerMultiSpecialExchangeCampaignsSync, getPlayerOptionsSync, getPlayerPartyGroupListSync, getPlayerPeriodicRewardPointsSync, getPlayerQuestProgressSync, getPlayerReceivableMailCountSync, getPlayerStartDashExchangeCampaignsSync, getPlayerSync, getPlayerTriggeredTutorialsSync, getAccountSessionsOfType, getSession, runInTransactionSync, updatePlayerSync, updateSessionUdidSync } from "../../data/wdfpData";
import { generateDataHeaders, getServerDate, isGeneratedViewerId } from "../../utils";
import { renewViewerSession } from "../../lib/gameAuth";
import { integer, object, string } from "../schemas";
import { forgetReplays } from "../../lib/replayGuard";
import { getClientMultiSpecialExchangeCampaignList } from "../../lib/multiSpecialExchange";
import { applyResets } from "../../lib/resets";

interface LoadBody {
    app_secret: string,
    graphics_device_name: string,
    device_id: number,
    access_token: string,
    storage_directory_path: string,
    app_admin: string,
    kakao_pid: string,
    keychain: number,
    viewer_id: number,
    platform_os_version: string
}

const loadSchema = { body: object({
    access_token: string,
    viewer_id: integer
}) }

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/load", { config: { gameAuth: "none" }, schema: loadSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as LoadBody

        const zat = body.access_token
        let viewerId = body.viewer_id
        if (!zat || !viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const session = await getSession(zat)
        if (session === null || session.type !== SessionType.ZAT) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid zat provided."
        })

        // /load is the first game request of every launch, so it authenticates with the zat and
        // renews the viewer session even if it has expired.
        const viewerSessions = await getAccountSessionsOfType(session.accountId, SessionType.VIEWER)
        let viewerSession = viewerSessions.find(viewerSession => viewerSession.token === String(viewerId))
        if (viewerSession === undefined) {
            // The game only calls tool/signup on its first run and keeps its viewer id afterwards. If the server has
            // forgotten that id (the account's sessions were deleted or reset, the database was replaced), sign the
            // device up again under the same id instead of failing every launch with a 400. Only an account with no
            // viewer session adopts an id, and only one of the kind the server hands out that nobody else holds.
            if (viewerSessions.length > 0 || !isGeneratedViewerId(viewerId) || await getSession(String(viewerId)) !== null) return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid viewer ID provided."
            })

            viewerSession = await insertSessionWithToken({
                token: String(viewerId),
                expires: viewerSessionExpiry(),
                accountId: session.accountId,
                type: SessionType.VIEWER
            })
        }
        renewViewerSession(viewerSession)

        // Bind the device UDID that signs game requests (PARAM, src/lib/gameAuth.ts). The zat proves the account,
        // so this also binds sessions created before the UDID was stored, or a device whose UDID changed.
        const udid = request.headers["udid"]
        if (typeof udid === "string" && udid !== "" && viewerSession.udid !== udid) {
            if (viewerSession.udid) request.log.info({ viewerId }, "viewer UDID changed at /load")
            updateSessionUdidSync(viewerSession.token, udid)
        }

        // the player may have been deleted while the device stayed signed in: start a new one on the account
        if (getPlayerFromAccountIdSync(session.accountId) === null) insertDefaultPlayerSync(session.accountId)

        const playerIds = await getAccountPlayers(session.accountId)
        const playerId = playerIds[0]
        const player = playerId !== undefined ? getPlayerSync(playerId) : null

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // the client's api_count restarts here, so a kept reply can't be a retry any more (src/lib/replayGuard.ts)
        forgetReplays(playerId)

        runInTransactionSync(() => {
            const now = getServerDate()
            updatePlayerSync({ id: playerId, lastLoginTime: now })
            // the client returns to the title (and so to /load) when the game day changes (src/lib/resets.ts)
            applyResets(playerId, now)

            // collect the player's pooled exp
            collectPlayerDataPooledExpSync(player)
        })

        const clientData = getClientSerializedData(playerId, { viewerId: viewerId })
        if (clientData === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player data."
        })
        // lights the gift box badge on the home screen
        clientData.mail_arrived = getPlayerReceivableMailCountSync(playerId, getServerDate()) > 0
        // the stored campaign rows aren't sent as they are: open campaigns the player hasn't joined are added (the client
        // hides unlisted ones) and tickets past their exchange period are left out (src/lib/multiSpecialExchange.ts)
        clientData.multi_special_exchange_campaign_list = getClientMultiSpecialExchangeCampaignList(playerId, getServerDate())

        reply.header("content-type", "application/x-msgpack")
        reply.status(200).send({
            "data_headers": generateDataHeaders({
                asset_update: true,
                viewer_id: viewerId
            }),
            "data": clientData
        })
    })
}

export default routes;