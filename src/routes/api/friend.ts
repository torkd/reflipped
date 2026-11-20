import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAccountPlayersSync, getPlayerPublicViewerIdSync } from "../../data/wdfpData";
import { escapeHtml, readPage } from "../web/layout";
import { query, string } from "../schemas";

/**
 * The page a shared profile link opens (FT-43).
 *
 * The profile's Share button shares `player_profile_share_text` with the link the client's `getFriendFollowUrl` builds:
 * `<urlFriendFollowServer>/latest/api/index.php/friend/follow?kid=<kakao player ID>&c=<random>`, the player ID being
 * the account's (the login's `playerId`). A browser can't hand that to the game, so this page links to the game's own
 * scheme, `wdfp://profile?id=<viewer ID>`, which the game turns into `InvokeUrl.PlayerProfile(viewerId)`: it opens the
 * player's profile (`profile/get_profile`) and follows them (the GetProfileAndAutoFollow loading task: "Followed!",
 * "You already follow this player." or "That's your own link!"). `c` only makes each shared URL unique.
 */

/** An account ID as the client writes it; anything else is answered without a lookup. */
const KID = /^[1-9][0-9]{0,15}$/

/** The viewer ID other players know the account's player by, or null. */
function viewerIdOfAccount(kid: string): number | null {
    if (!KID.test(kid)) return null
    const playerId = getAccountPlayersSync(Number(kid))[0]
    return playerId === undefined ? null : getPlayerPublicViewerIdSync(playerId)
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/follow", {
        config: { gameAuth: "none" },
        schema: query({ kid: string, c: string })
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = viewerIdOfAccount(String((request.query as { kid?: string }).kid ?? ""))
        reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store")
        if (viewerId === null) return reply.status(404).send(readPage("follow-link-missing"))

        // Chrome on Android opens other apps more reliably through an intent: URL than through a bare custom scheme
        const android = /Android/i.test(String(request.headers["user-agent"] ?? ""))
        const link = android
            ? `intent://profile?id=${viewerId}#Intent;scheme=wdfp;end`
            : `wdfp://profile?id=${viewerId}`
        return reply.status(200).send(readPage("follow-link")
            .replace("{{link}}", escapeHtml(link))
            .replace("{{viewerId}}", escapeHtml(String(viewerId))))
    })
}

export default routes
