/**
 * Unit balance on the replayed timeline (FT-47): which second mana boards are out. Decided with the owner
 * (2026-11-07, docs/balance-history.md):
 * - balance follows the server's shared timeline: a player's own Time Travel or an admin's travel doesn't change it,
 *   so co-op players never see a unit two ways;
 * - strict history: when the shared timeline goes back (Manual jumps, the archive's loop), boards that aren't out yet
 *   are hidden again. A player's progress on a hidden board stays stored, and the server reports the unit as on its
 *   first board, without the hidden board's nodes, until the board is out again;
 * - with event scheduling off, every board is out (the archive's end).
 * The client learns which boards exist from its `mana_board/mana_node` master, which the schedule overlay ships per
 * balance epoch (src/lib/scheduleAssets.ts).
 */
import type { UserCharacter, UserCharacterManaNodeList } from "../data/types";
import { isBoard2Node, isBoard2Out } from "./boardRelease";
import { balanceEpochAt, statusRowsAt } from "./balanceChanges";
import { getEventScheduleView, scheduledContentEnabled } from "./eventSchedule";

/** The shared timeline's content time, without a player's own Time Travel; Infinity with scheduling off. */
export function sharedBalanceTime(now = Date.now()): number {
    if (!scheduledContentEnabled()) return Infinity
    return getEventScheduleView(now, 0).contentTime
}

/** The balance epoch the server is in now (src/lib/balanceChanges.ts). */
export function currentBalanceEpoch(now = Date.now()): number {
    return balanceEpochAt(sharedBalanceTime(now))
}

/** Whether a unit's second board is out now. */
export function board2Available(characterId: number, time = sharedBalanceTime()): boolean {
    return isBoard2Out(characterId, time)
}

/** A unit's learnt mana nodes as the client may see them now: without a hidden second board's. */
export function visibleManaNodes(characterId: number, nodeIds: number[], time = sharedBalanceTime()): number[] {
    if (isBoard2Out(characterId, time)) return nodeIds
    return nodeIds.filter(nodeId => !isBoard2Node(characterId, nodeId))
}

/** A unit as the client may see it now: on its first board while its second is hidden (its progress kept). */
export function visibleUserCharacter<T extends Pick<UserCharacter, "mana_board_index" | "bond_token_list">>(characterId: number, character: T,
    time = sharedBalanceTime()): T {
    if (isBoard2Out(characterId, time)) return character
    return {
        ...character,
        mana_board_index: Math.min(character.mana_board_index, 1),
        bond_token_list: character.bond_token_list.map(token => token.mana_board_index >= 2 ? { ...token, status: 0 } : token)
    }
}

/** Applies `visibleUserCharacter` and `visibleManaNodes` to `/load`'s unit lists, in place (never to a save). */
export function hideUnreleasedBoards(data: { user_character_list: Record<string, UserCharacter>, user_character_mana_node_list: UserCharacterManaNodeList },
    time = sharedBalanceTime()): void {
    if (time === Infinity) return
    for (const [id, character] of Object.entries(data.user_character_list))
        data.user_character_list[id] = visibleUserCharacter(Number(id), character, time)
    for (const [id, nodes] of Object.entries(data.user_character_mana_node_list))
        data.user_character_mana_node_list[id] = visibleManaNodes(Number(id), nodes, time)
}

/** A unit's HP and ATK key rows ([level, hp, atk]) as the shared timeline has them (src/lib/balanceChanges.ts). */
export function unitStatusRows(characterId: number, rows: readonly [number, number, number][], time = sharedBalanceTime()): [number, number, number][] {
    return statusRowsAt(characterId, rows, time)
}
