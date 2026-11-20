// Units that join through the story (FT-16): `assets/story_join_character.json` (character/story_join_character,
// scripts/converter.py). A "town" unit (Shroombo, 512001) waits in the town once its main story quest is read; tapping
// it sends character/add_character_from_town (the client only asks while the player doesn't have it). A "quest" unit
// joins when its main story quest is first read (story_quest/finish, `story_join_character_id_list` in the reply).
// The client also shows a "quest" unit in the town when its quest is read and the player lacks it (getTownCharacterId
// checks only the unit's emergence conditions), so the town accepts both kinds. Saves that read a "quest" unit's quest
// before the server gave it get it at /load (giveMissedStoryJoinCharactersSync).

import storyJoinCharacters from "../../assets/story_join_character.json";
import { getPlayerCharacterSync, getPlayerSingleQuestProgressSync } from "../data/wdfpData";
import { givePlayerCharacterSync } from "./character";
import { QuestCategory } from "./types";

interface StoryJoinCharacter {
    /** the main quest after which the unit joins */
    questId: number
    /** "town" (tapped in the town) or "quest" (brought by the quest) */
    via: string
}

const joinCharacters = storyJoinCharacters as Record<string, StoryJoinCharacter>

export type TownJoinCheck = "ok" | "not-a-story-character" | "story-not-read" | "already-joined"

/**
 * The units a main story quest brings ("quest"): on its first read, story_quest/finish gives each the player doesn't
 * have and names it in `story_join_character_id_list`, which the client reads to show the unit joining.
 */
export function questJoinCharacterIds(questId: number): number[] {
    return Object.entries(joinCharacters)
        .filter(([, join]) => join.via === "quest" && join.questId === questId)
        .map(([characterId]) => Number(characterId))
}

/** Whether the player may take the story unit `characterId` from the town now (either kind, see the header). */
export function townJoinCheckSync(playerId: number, characterId: number): TownJoinCheck {
    const join = joinCharacters[String(characterId)]
    if (join === undefined) return "not-a-story-character"
    if (getPlayerCharacterSync(playerId, characterId) !== null) return "already-joined"
    if (getPlayerSingleQuestProgressSync(playerId, QuestCategory.MAIN, join.questId)?.finished !== true) return "story-not-read"
    return "ok"
}

/**
 * Gives the "quest" units whose main story quest the player has read but who never joined (saves from before the
 * server gave them). Returns the ids given. Runs at /load, inside its transaction.
 */
export function giveMissedStoryJoinCharactersSync(playerId: number): number[] {
    const given: number[] = []
    for (const [id, join] of Object.entries(joinCharacters)) {
        const characterId = Number(id)
        if (join.via !== "quest" || getPlayerCharacterSync(playerId, characterId) !== null) continue
        if (getPlayerSingleQuestProgressSync(playerId, QuestCategory.MAIN, join.questId)?.finished !== true) continue
        if (givePlayerCharacterSync(playerId, characterId) !== null) given.push(characterId)
    }
    return given
}
