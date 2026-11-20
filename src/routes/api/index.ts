import { applyCampaignGiftsSync } from "../../lib/campaignGifts";
import { clientGachaCampaignListSync } from "../../lib/gachaCampaigns";
import { ensureStartDashEntriesSync, startDashCampaignListSync } from "../../lib/startDash";
import { specialExchangeCampaignListSync } from "../../lib/specialExchange";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SessionType } from "../../data/types";
import { getClientSerializedData, serializePlayerData } from "../../data/utils";
import { hideUnreleasedBoards } from "../../lib/balance";
import { getPlayerFromAccountIdSync, insertDefaultPlayerSync, replaceAccountViewerSessionSync, collectPlayerDataPooledExpSync, collectPlayerPooledExpSync, getAccountPlayers, getPlayerActiveMissionsSync, getPlayerBoxGachasSync, getPlayerCharactersManaNodesSync, getPlayerCharactersSync, getPlayerClearedRegularMissionListSync, getPlayerDailyChallengePointListSync, getPlayerDrawnQuestsSync, getPlayerEquipmentListSync, getPlayerGachaInfoListSync, getPlayerItemsSync, getPlayerMultiSpecialExchangeCampaignsSync, getPlayerOptionsSync, getPlayerPartyGroupListSync, getPlayerPeriodicRewardPointsSync, getPlayerQuestProgressSync, getPlayerReceivableMailCountSync, getPlayerStartDashExchangeCampaignsSync, getPlayerSync, getPlayerTriggeredTutorialsSync, getAccountSessionsOfType, getSession, runInTransactionSync, sessionTokenExistsSync, updatePlayerSync, updateSessionUdidSync } from "../../data/wdfpData";
import { generateDataHeaders, getServerDate, isGeneratedViewerId } from "../../utils";
import { renewViewerSession } from "../../lib/gameAuth";
import { integer, object, string } from "../schemas";
import { forgetReplays } from "../../lib/replayGuard";
import { getClientMultiSpecialExchangeCampaignList } from "../../lib/multiSpecialExchange";
import { applyResets } from "../../lib/resets";
import { takeTowerDungeonNoticesSync } from "../../lib/towerDungeon";
import { applyLoginBonuses, latestReturnSync } from "../../lib/loginBonus";
import { comebackBossBoostPeriodSync, serializeComebackBossBoost, topUpComebackBossBoostSync } from "../../lib/comebackBoost";
import { applyPeriodicPacksSync, premiumBonusListSync } from "../../lib/periodicPacks";
import { followAccountClock } from "../../lib/playerClock";
import { giveMissedStoryJoinCharactersSync } from "../../lib/storyJoin";
import { collectionUpdatesSync, updateMissionsSync } from "../../lib/missions";
import { comebackGachaPeriodSync, withComebackCampaign } from "../../lib/comebackGacha";

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
            // The game calls tool/signup only when it keeps no viewer id, so it can bring an id that isn't this
            // account's: the server forgot it (sessions reset, database replaced), or the device changed accounts or
            // servers (the Reflipped app's Sign out keeps the game's local data; app builds since FIX-12 clear the id
            // on an account change, older ones and the original APK don't). Sign the device up again under that id
            // instead of failing every launch with a 400: the account takes it, and its other viewer sessions end,
            // since the zat shows this device plays the account now. Only an id of the kind the server hands out that
            // nobody else holds, not even in an expired session, is taken: one another account holds stays that
            // account's until its sessions end (Sign out, a sign-in on another device).
            const holder = sessionTokenExistsSync(String(viewerId))
            if (holder || !isGeneratedViewerId(viewerId)) {
                if (holder) request.log.info({ viewerId, accountId: session.accountId }, "load: viewer id held by another account")
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "Invalid viewer ID provided."
                })
            }

            viewerSession = replaceAccountViewerSessionSync(session.accountId, String(viewerId))
        }
        renewViewerSession(viewerSession, true)

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

        // the reply and the resets below are on the player's own clock (src/lib/playerClock.ts)
        followAccountClock(session.accountId)

        // the client's api_count restarts here, so a kept reply can't be a retry any more (src/lib/replayGuard.ts)
        forgetReplays(playerId)

        const loginBonuses = runInTransactionSync(() => {
            const now = getServerDate()
            updatePlayerSync({ id: playerId, lastLoginTime: now })
            // the client returns to the title (and so to /load) when the game day changes (src/lib/resets.ts)
            const resets = applyResets(playerId, now)

            // collect the player's pooled exp
            collectPlayerDataPooledExpSync(player)
            // the Start Dash bundle for a new player (FT-44), before the gifts, which may give it
            ensureStartDashEntriesSync(playerId, session.accountId, now)
            // story units the save missed: read their quest before the server gave them (src/lib/storyJoin.ts)
            if (giveMissedStoryJoinCharactersSync(playerId).length > 0) updateMissionsSync(playerId, now, collectionUpdatesSync(playerId))
            // scheduled campaign gifts an admin turned on (FT-39), once per campaign, at the first login of its period
            applyCampaignGiftsSync(playerId, now)
            // the login before this one (updated above) decides the comeback calendars (src/lib/loginBonus.ts)
            const bonuses = applyLoginBonuses(playerId, now, player.lastLoginTime)
            // the Welcome Back Boost: 15 Boss Boosts on the returning login and each new game day of it (FT-65)
            const returned = latestReturnSync(playerId)
            const returnedNow = returned !== null && Math.floor(returned.getTime() / 1000) >= Math.floor(now.getTime() / 1000)
            topUpComebackBossBoostSync(playerId, now, resets.daily || returnedNow)
            // periodic packs the owner gives every player (FT-89): terms, days and rank thresholds due, by mail
            applyPeriodicPacksSync(playerId, now)
            return bonuses
        })

        const clientData = getClientSerializedData(playerId, { viewerId: viewerId })
        if (clientData === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player data."
        })
        // second mana boards not out yet on the shared timeline: hidden, their progress kept (FT-47, src/lib/balance.ts)
        hideUnreleasedBoards(clientData)
        // lights the gift box badge on the home screen
        clientData.mail_arrived = getPlayerReceivableMailCountSync(playerId, getServerDate()) > 0
        clientData.bonus_index_list = loginBonuses.bonusIndexList
        clientData.login_bonus_received_at = loginBonuses.loginBonusReceivedAt
        // the stored campaign rows aren't sent as they are: open campaigns the player hasn't joined are added (the client
        // hides unlisted ones) and tickets past their exchange period are left out (src/lib/multiSpecialExchange.ts)
        clientData.multi_special_exchange_campaign_list = getClientMultiSpecialExchangeCampaignList(playerId, getServerDate())
        // Scouting Seasons and the Dream Armament shop: the Shop lists a campaign only with a status, so every open one
        // is sent, entered or not (src/lib/specialExchange.ts)
        clientData.special_exchange_campaign_list = specialExchangeCampaignListSync(playerId, getServerDate())
        // free pull campaigns: the open campaigns' portals the player hasn't pulled on yet are listed with a pull left, or
        // the client shows no free pull button (src/lib/gachaCampaigns.ts)
        clientData.gacha_campaign_list = clientGachaCampaignListSync(playerId, getServerDate())
        // the Welcome Back Portal of a player who has just returned: the client shows it only with this period
        // (src/lib/comebackGacha.ts)
        clientData.gacha_info_list = withComebackCampaign(clientData.gacha_info_list, comebackGachaPeriodSync(playerId, getServerDate()))
        // the Welcome Back Boost's end: the client shows its "5x the Boss Boosts" dialog once a day until then (FT-65)
        const bossBoost = serializeComebackBossBoost(comebackBossBoostPeriodSync(playerId, getServerDate()))
        if (bossBoost !== undefined) clientData.comeback_campaign_boss_boost = bossBoost
        // the running monthly packs and their days left (FT-89)
        clientData.premium_bonus_list = premiumBonusListSync(playerId, getServerDate())
        // the Start Dash bundle's entries with the status the client expects (src/lib/startDash.ts)
        clientData.start_dash_exchange_campaign_list = startDashCampaignListSync(playerId)
        // the Haunt's reset dialog, once, after its cycle changed (src/lib/towerDungeon.ts)
        clientData.tower_dungeon_list = takeTowerDungeonNoticesSync(playerId)

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
