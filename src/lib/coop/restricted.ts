// SEC-18 phase 2: co-op for restricted players (docs/hardening.md, "Anti-cheat"). Restriction is quiet, so nothing here
// tells the player; their rooms and options just come up empty for strangers. What stays open:
// - playing with AI companions (a room nobody else joins);
// - a restricted host's room by its number or link, which the host hands out on purpose, and to the host's follows,
//   mutuals and followers (friends see the room in their list and invitations as always);
// - a restricted guest joining a friend's room, a room they follow the host of or that follows them.
// What closes: a restricted host's room in the public room list and in invitations to strangers, and a restricted guest
// joining a stranger's room (any way), which `select_room` answers with the not-playable result code.
import { establisherFollowSync, FollowState } from "../follows";
import { getViewerPlayerIdSync } from "../../data/wdfpData";
import { restrictedPlayerSetSync } from "../../data/anticheatData";
import { anticheatMode } from "../anticheat";
import type { CoopRoom } from "./rooms";

/** The result code of NotPlayable in the client (docs/coop-research.md, "Recruitment"). */
export const COOP_NOT_PLAYABLE = 4020

/**
 * Whether the viewer's player is restricted and the restriction in force (restrictionActive()'s rule). Runs per room on
 * every room list, so the cheap checks come first: the mode (cached), then the cached restricted set, and only then the
 * viewer's player.
 */
function viewerRestricted(viewerId: number): boolean {
    if (anticheatMode() === "off") return false
    const restricted = restrictedPlayerSetSync()
    if (restricted.size === 0) return false
    const playerId = getViewerPlayerIdSync(viewerId)
    return playerId !== null && restricted.has(playerId)
}

/**
 * Whether a restricted host's room is hidden from this viewer in the room list and in invitations: the host is
 * restricted and the viewer is a stranger to them (no follow either way). Never for the host, never for friends.
 */
export function roomHiddenFrom(room: Pick<CoopRoom, "hostViewerId">, viewerId: number): boolean {
    if (viewerId === room.hostViewerId) return false
    if (!viewerRestricted(room.hostViewerId)) return false
    return establisherFollowSync(viewerId, room.hostViewerId) === FollowState.NONE
}

/** Whether this viewer may not join the room: they are restricted and a stranger to its host. */
export function joinRefusedFor(room: Pick<CoopRoom, "hostViewerId">, viewerId: number): boolean {
    if (viewerId === room.hostViewerId) return false
    if (!viewerRestricted(viewerId)) return false
    return establisherFollowSync(viewerId, room.hostViewerId) === FollowState.NONE
}
