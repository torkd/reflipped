import Ajv from "ajv";
import type { ClientPlayerData } from "./types";

/*
 * Schema for an imported save file (the JSON `GET /api/player/save` exports, `ClientPlayerData`), checked
 * before `deserializePlayerData()` turns it into rows (SEC-9). It covers every field the importer reads, with
 * types, ranges, string lengths and size caps, so a hand-edited or hostile file can't put odd values or huge
 * collections into the database. Fields the importer ignores (`premium_bonus_list`, `config`, ...) may be
 * present with any value and are dropped; objects whose fields are copied as a whole reject unknown keys.
 */

/** Largest import the admin page accepts, in bytes (the multipart file limit). A developer-mode save is about 1 MB. */
export const maxSaveFileBytes = 8 * 1024 * 1024

const int32 = { type: "integer", minimum: -2147483648, maximum: 2147483647 }
/** counts, balances and ids the client keeps in 32-bit ints */
const count = { type: "integer", minimum: 0, maximum: 2147483647 }
/** server times (seconds) and millisecond values that can pass 32 bits */
const bigCount = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const nullableInt = { type: ["integer", "null"], minimum: -2147483648, maximum: 2147483647 }
const idKey = { type: "string", pattern: "^[0-9]{1,10}$" }
const sectionKey = { type: "string", minLength: 1, maxLength: 32 }

function record(value: object, maxProperties: number, propertyNames: object = idKey) {
    return { type: "object", propertyNames, additionalProperties: value, maxProperties }
}

function list(items: object, maxItems: number) {
    return { type: "array", items, maxItems }
}

function strictObject(properties: Record<string, object>, required: string[] = Object.keys(properties)) {
    return { type: "object", properties, required, additionalProperties: false }
}

/** an object whose listed fields are checked; other fields are ignored by the importer */
function object(properties: Record<string, object>, required: string[] = Object.keys(properties)) {
    return { type: "object", properties, required }
}

const userInfo = object({
    stamina: count,
    stamina_heal_time: bigCount,
    boost_point: count,
    boss_boost_point: count,
    transition_state: int32,
    role: int32,
    name: { type: "string", maxLength: 100 },
    last_login_time: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$" },
    comment: { type: "string", maxLength: 500 },
    vmoney: count,
    free_vmoney: count,
    rank_point: count,
    star_crumb: count,
    bond_token: count,
    exp_pool: count,
    exp_pooled_time: bigCount,
    leader_character_id: count,
    party_slot: count,
    degree_id: count,
    birth: int32,
    free_mana: count,
    paid_mana: count,
    enable_auto_3x: { type: "boolean" }
})

const character = object({
    entry_count: count,
    evolution_level: count,
    over_limit_step: count,
    protection: { type: "boolean" },
    join_time: bigCount,
    update_time: bigCount,
    exp: count,
    stack: count,
    bond_token_list: list(object({ mana_board_index: count, status: int32 }), 2),
    mana_board_index: count,
    ex_boost: object({ status_id: count, ability_id_list: list(count, 10) }, ["status_id"]),
    illustration_settings: list(int32, 10)
}, ["entry_count", "evolution_level", "over_limit_step", "protection", "join_time", "update_time", "exp", "stack", "bond_token_list", "mana_board_index"])

const partyIds = list({ type: ["integer", "null"], minimum: 0, maximum: 2147483647 }, 3)
const partyTeam = object({
    name: { type: "string", maxLength: 100 },
    character_ids: partyIds,
    unison_character_ids: partyIds,
    equipment_ids: partyIds,
    ability_soul_ids: partyIds,
    edited: { type: "boolean" },
    options: object({ allow_other_players_to_heal_me: { type: "boolean" } }, [])
})

const rushEvent = strictObject({
    active_rush_battle_folder_id: nullableInt,
    endless_battle_max_round: nullableInt,
    endless_battle_max_round_time: { type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    endless_battle_max_round_character_id_1: nullableInt,
    endless_battle_max_round_character_id_2: nullableInt,
    endless_battle_max_round_character_id_3: nullableInt,
    endless_battle_max_round_character_evolution_img_lvl_1: nullableInt,
    endless_battle_max_round_character_evolution_img_lvl_2: nullableInt,
    endless_battle_max_round_character_evolution_img_lvl_3: nullableInt
}, [])

const rushPlayedPartyFields = ["character_id", "unison_character_id", "equipment_id", "ability_soul_id", "evolution_img_level", "unison_evolution_img_level"]
const rushPlayedParty = strictObject(Object.fromEntries(rushPlayedPartyFields.flatMap(field => [1, 2, 3].map(slot => [`${field}_${slot}`, nullableInt]))), [])

export const saveSchema = object({
    user_info: userInfo,
    user_tutorial: {
        anyOf: [{ type: "null" }, object({ tutorial_step: { type: ["integer", "null"], minimum: 0, maximum: 2147483647 }, skip_flag: { type: ["boolean", "null"] } }, [])]
    },
    user_daily_challenge_point_list: list(object({
        id: count,
        point: count,
        campaign_list: list(object({ campaign_id: count, additional_point: count }), 1000)
    }), 1000),
    user_triggered_tutorial: list(count, 10000),
    cleared_regular_mission_list: record(count, 100000),
    user_character_list: record(character, 5000),
    user_character_mana_node_list: record(list(count, 1000), 5000),
    user_party_group_list: record(object({
        color_id: count,
        list: record(partyTeam, 100)
    }), 100),
    item_list: record(count, 100000),
    user_equipment_list: record(object({
        enhancement_level: count,
        level: count,
        protection: { type: "boolean" },
        stack: count
    }), 20000),
    quest_progress: record(list(object({
        quest_id: count,
        finished: { type: "boolean" },
        high_score: { type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        best_elapsed_time_ms: { type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        clear_rank: nullableInt
    }, ["quest_id", "finished"]), 100000), 1000, sectionKey),
    gacha_info_list: list(object({
        gacha_id: count,
        is_daily_first: { type: "boolean" },
        is_account_first: { type: "boolean" },
        gacha_exchange_point: count
    }, ["gacha_id", "is_daily_first", "is_account_first"]), 10000),
    gacha_campaign_list: list(object({ campaign_id: count, gacha_id: count, count: count }), 10000),
    user_option: record({ type: "boolean" }, 1000, { type: "string", minLength: 1, maxLength: 64 }),
    drawn_quest_list: list(object({ category_id: count, quest_id: count, odds_id: count }), 10000),
    user_periodic_reward_point_list: list(strictObject({ id: count, point: count }), 10000),
    all_active_mission_list: record(strictObject({
        progress: count,
        stages: {
            anyOf: [
                { type: "array", maxItems: 0 },
                record({ type: "boolean" }, 1000, sectionKey)
            ]
        }
    }), 100000),
    box_gacha_list: record(list(object({
        box_id: count,
        reset_times: count,
        remaining_number: count,
        is_closed: { type: "boolean" }
    }), 1000), 1000, sectionKey),
    start_dash_exchange_campaign_list: list(object({
        campaign_id: count,
        gacha_id: count,
        period_start_time: bigCount,
        period_end_time: bigCount,
        status: int32,
        term_index: int32
    }), 1000),
    multi_special_exchange_campaign_list: list(object({ campaign_id: count, status: int32, ticket_item_id: count }, ["campaign_id", "status"]), 1000),
    user_rush_event_list: record(rushEvent, 1000),
    user_rush_event_cleared_folder_list: record(list(count, 1000), 1000),
    user_rush_event_played_party_list: record(
        record(record(rushPlayedParty, 1000), 2, { type: "string", enum: ["0", "1"] }),
        1000
    )
}, [
    "user_info", "user_daily_challenge_point_list", "user_triggered_tutorial", "cleared_regular_mission_list",
    "user_character_list", "user_character_mana_node_list", "user_party_group_list", "item_list", "user_equipment_list",
    "quest_progress", "gacha_info_list", "user_option", "drawn_quest_list", "user_periodic_reward_point_list",
    "all_active_mission_list", "box_gacha_list", "start_dash_exchange_campaign_list"
])

const validate = new Ajv({ allErrors: false, strict: true, allowUnionTypes: true }).compile(saveSchema)

export class InvalidSaveError extends Error { }

/**
 * Checks an imported save against `saveSchema`. A file may wrap the save in `{ "data": ... }` (the shape
 * the game's own `/load` uses); the unwrapped save is returned.
 *
 * @throws InvalidSaveError naming the first field that is wrong (our own text, never the file's values).
 */
export function validateSaveData(json: unknown): Partial<ClientPlayerData> {
    const save = typeof json === "object" && json !== null && !Array.isArray(json) && "data" in json
        ? (json as { data: unknown }).data
        : json
    if (!validate(save)) {
        const error = validate.errors?.[0]
        const where = error?.instancePath ? error.instancePath.slice(0, 120) : "the file"
        throw new InvalidSaveError(`Invalid save: ${where} ${error?.message ?? "is not valid"}`)
    }
    return save as Partial<ClientPlayerData>
}
