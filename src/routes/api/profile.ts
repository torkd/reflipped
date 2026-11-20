// Handles the player's profile: the profile screen (get_my_profile: counts, show/hide settings and favourite units;
// FT-36, src/lib/profile.ts), renaming, the title list and setting one (degrees), and the comment, which also carries
// the portal's device link codes (ACC-4, src/lib/deviceLink.ts).

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerSync, getViewerPlayerIdSync, setPlayerProfileSettingsSync, updatePlayerSync } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";
import { boolean, gameBody, ignoredBody, integer, object, playerText, string, stringOrInteger } from "../schemas";
import { playerNameProblem, profileInfoSync, profilePartyGroupListSync, profileSettingsReplySync } from "../../lib/profile";
import { otherProfileSync } from "../../lib/follows";
import { atomicHandler } from "../../lib/atomic";
import { getPlayerOwnedDegreeIdsSync } from "../../lib/degrees";
import { linkDeviceSync, looksLikeLinkCode } from "../../lib/deviceLink";

/**
 * The comment's result code for a refused text: the client says the comment contains a word that can't be used and
 * keeps the old one (`ProfileUpdateCommentRealRemote`, `NgWordError`). A wrong or expired link code gets it.
 */
const NG_WORD_RESULT_CODE = 207

/** The longest comment kept. The game's own box is shorter; this only bounds what a modified client can store. */
const COMMENT_MAX_LENGTH = 100

interface UpdateDegreeBody {
    viewer_id: number,
    api_count: number,
    degree_id: number
}

const getDegreeListSchema = gameBody({ api_count: integer })

const updateDegreeSchema = gameBody({
    api_count: integer,
    degree_id: integer
}, ["degree_id"])

interface UpdateCommentBody {
    viewer_id: number,
    api_count: number,
    comment: string
}

const updateCommentSchema = gameBody({
    api_count: integer,
    comment: string
}, ["comment"])

interface RenameBody {
    viewer_id: number,
    name: string
}

const renameSchema = gameBody({ name: playerText }, ["name"])

interface UpdateProfileSettingsBody {
    viewer_id: number,
    profile_settings: {
        show_owned_character_count: boolean,
        show_opened_mana_board_second_count: boolean,
        show_owned_degree_count: boolean
    }
}

const updateProfileSettingsSchema = gameBody({
    profile_settings: object({
        show_owned_character_count: boolean,
        show_opened_mana_board_second_count: boolean,
        show_owned_degree_count: boolean
    }, ["show_owned_character_count", "show_opened_mana_board_second_count", "show_owned_degree_count"])
}, ["profile_settings"])

const getProfileSchema = gameBody({ target_viewer_id: stringOrInteger }, ["target_viewer_id"])

const routes = async (fastify: FastifyInstance) => {
    // Another player's profile (FT-15: from the follow list, a search or a co-op result), with the counts they show,
    // their favourite units and how the player stands towards them; read-only
    fastify.post("/get_profile", { schema: getProfileSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const target = String((request.body as { target_viewer_id: number | string }).target_viewer_id).trim()
        const targetId = /^\d{1,15}$/.test(target) ? getViewerPlayerIdSync(target) : null
        const profile = targetId === null ? null : otherProfileSync(request.viewer.playerId, targetId)
        if (profile === null) return reply.status(400).send({ "error": "Bad Request", "message": "Player not found." })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: request.viewer.viewerId
            }),
            "data": profile
        })
    })

    // Menu → Profile: the counts shown on the profile, the show/hide settings and the favourite units, whose party set
    // is made the first time (so this writes once)
    fastify.post("/get_my_profile", { schema: ignoredBody }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const playerId = request.viewer.playerId
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: request.viewer.viewerId
            }),
            "data": {
                "profile_info": profileInfoSync(playerId),
                "profile_settings": profileSettingsReplySync(playerId),
                "user_party_group_list": profilePartyGroupListSync(playerId)
            }
        })
    }))

    // Edit Profile → Name. The client reads nothing from the reply; a refused name gets its "word can't be used"
    // dialog (207). Its other error, 6001 ("temporarily unable to change your nickname"), was an operator switch.
    fastify.post("/rename", { schema: renameSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as RenameBody
        const { viewerId, playerId } = request.viewer
        const problem = playerNameProblem(body.name)
        reply.header("content-type", "application/x-msgpack")
        if (problem !== null) {
            request.log.info({ problem }, "profile/rename refused")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: NG_WORD_RESULT_CODE }),
                "data": []
            })
        }
        const name = body.name.trim()
        updatePlayerSync({ id: playerId, name })
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "name": name
                },
                "mail_arrived": false
            }
        })
    }))

    // Edit Profile → Show/Hide Settings: which counts the profile shows
    fastify.post("/update_profile_settings", { schema: updateProfileSettingsSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const settings = (request.body as UpdateProfileSettingsBody).profile_settings
        const playerId = request.viewer.playerId
        setPlayerProfileSettingsSync(playerId, {
            showOwnedCharacterCount: settings.show_owned_character_count,
            showOpenedManaBoardSecondCount: settings.show_opened_mana_board_second_count,
            showOwnedDegreeCount: settings.show_owned_degree_count
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: request.viewer.viewerId
            }),
            "data": {
                "profile_settings": profileSettingsReplySync(playerId)
            }
        })
    }))

    // The title screen: every title the player owns (`degree_ids`).
    fastify.post("/get_degree_list", { schema: getDegreeListSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const viewerId = request.viewer.viewerId

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "degree_ids": getPlayerOwnedDegreeIdsSync(request.viewer.playerId)
            }
        })
    })

    // Sets the title shown on the player's profile; only an owned one.
    fastify.post("/update_degree", { schema: updateDegreeSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UpdateDegreeBody

        const viewerId = request.viewer.viewerId
        const playerId = request.viewer.playerId
        const degreeId = body.degree_id
        if (!getPlayerOwnedDegreeIdsSync(playerId).includes(degreeId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Title not owned."
        })

        updatePlayerSync({ id: playerId, degreeId })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "degree_id": degreeId
                },
                "mail_arrived": false
            }
        })
    }))

    // Sets the profile comment. A comment that is a link code from the portal isn't kept: it links this device to
    // the code's user instead (src/lib/deviceLink.ts), and a wrong or expired one is refused like a banned word.
    fastify.post("/update_comment", { schema: updateCommentSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UpdateCommentBody
        const { viewerId, playerId, accountId } = request.viewer
        const comment = body.comment

        if (looksLikeLinkCode(comment)) {
            const link = linkDeviceSync(accountId, comment)
            request.log.info({ accountId, outcome: link.outcome, ...("accountId" in link ? { linkedAccountId: link.accountId } : {}) }, "device link code in profile/update_comment")
            if (link.outcome === "invalid" || link.outcome === "locked" || link.outcome === "other-user") {
                reply.header("content-type", "application/x-msgpack")
                return reply.status(200).send({
                    "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: NG_WORD_RESULT_CODE }),
                    "data": []
                })
            }
            return commentReply(reply, viewerId, getPlayerSync(playerId)?.comment ?? "")
        }

        if (comment.length > COMMENT_MAX_LENGTH) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Comment too long."
        })
        updatePlayerSync({ id: playerId, comment })
        return commentReply(reply, viewerId, comment)
    }))
}

function commentReply(reply: FastifyReply, viewerId: number, comment: string) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        "data_headers": generateDataHeaders({
            viewer_id: viewerId
        }),
        "data": {
            "user_info": {
                "comment": comment
            },
            "mail_arrived": false
        }
    })
}

export default routes;
