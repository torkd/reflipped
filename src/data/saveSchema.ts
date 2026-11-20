import Ajv from "ajv";
import type { ClientPlayerData, SaveMail } from "./types";
import { MailType } from "./types";
import { mailLimits } from "../lib/limits";
import { checkMailContents, checkMailText, InvalidMailError } from "../lib/mail";
import { isKnownDegree } from "../lib/degrees";
import degreeIds from "../../assets/degree.json";

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
const dateTime = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$" }
const nullableDateTime = { ...dateTime, type: ["string", "null"] }
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
    last_login_time: dateTime,
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
    // one entry per mana board, boards 1 and 2 (FIX-7); duplicates are refused in validateSaveData
    bond_token_list: list(object({ mana_board_index: { type: "integer", enum: [1, 2] }, status: int32 }), 2),
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

// the gift box; the contents (ids the game has, amounts it can grant) and texts are checked by checkSaveMail()
const mail = strictObject({
    type: { type: "integer", enum: Object.values(MailType).filter(value => typeof value === "number") },
    type_id: { type: ["integer", "null"], minimum: 0, maximum: 2147483647 },
    number: count,
    reason_id: count,
    subject: { type: ["string", "null"], maxLength: mailLimits.subjectLength },
    description: { type: ["string", "null"], maxLength: mailLimits.descriptionLength },
    create_time: dateTime,
    receive_time: nullableDateTime,
    reward_limit_time: nullableDateTime,
    reward_source_key: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" }
}, ["type", "type_id", "number", "reason_id", "subject", "description", "create_time", "receive_time", "reward_limit_time"])

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
    ),
    // optional: a save from before they were saved has neither, and the player keeps their own
    user_mail_list: list(mail, mailLimits.pendingMails + mailLimits.historyMails),
    user_degree_list: { ...list(count, degreeIds.length), uniqueItems: true }
}, [
    "user_info", "user_daily_challenge_point_list", "user_triggered_tutorial", "cleared_regular_mission_list",
    "user_character_list", "user_character_mana_node_list", "user_party_group_list", "item_list", "user_equipment_list",
    "quest_progress", "gacha_info_list", "user_option", "drawn_quest_list", "user_periodic_reward_point_list",
    "all_active_mission_list", "box_gacha_list", "start_dash_exchange_campaign_list"
])

const validate = new Ajv({ allErrors: false, strict: true, allowUnionTypes: true }).compile(saveSchema)

export class InvalidSaveError extends Error { }

/** Called for each received mail a save import leaves out (`where` is its path in the file, `reason` our own text). */
export type DroppedMailHandler = (where: string, reason: string) => void

/**
 * Checks an imported save against `saveSchema`. A file may wrap the save in `{ "data": ... }` (the shape
 * the game's own `/load` uses); the unwrapped save is returned. Received mail that today's checks refuse is left out
 * rather than refusing the save (see `checkSaveMail`); `onDropped` hears of each.
 *
 * @throws InvalidSaveError naming the first field that is wrong (our own text, never the file's values).
 */
export function validateSaveData(json: unknown, onDropped: DroppedMailHandler = () => { }): Partial<ClientPlayerData> {
    const save = typeof json === "object" && json !== null && !Array.isArray(json) && "data" in json
        ? (json as { data: unknown }).data
        : json
    if (!validate(save)) {
        const error = validate.errors?.[0]
        const where = error?.instancePath ? error.instancePath.slice(0, 120) : "the file"
        throw new InvalidSaveError(`Invalid save: ${where} ${error?.message ?? "is not valid"}`)
    }
    const checked = save as Partial<ClientPlayerData>
    // a unit's bond token entries are keyed by board: two for the same board would fail the import's insert
    for (const [characterId, character] of Object.entries(checked.user_character_list ?? {})) {
        const boards = character.bond_token_list.map(token => token.mana_board_index)
        if (new Set(boards).size !== boards.length) throw new InvalidSaveError(`Invalid save: /user_character_list/${characterId.slice(0, 20)}/bond_token_list has the same board twice`)
    }
    if (checked.user_mail_list !== undefined) checked.user_mail_list = checkSaveMail(checked.user_mail_list, onDropped)
    for (const [index, degreeId] of (checked.user_degree_list ?? []).entries()) {
        if (!isKnownDegree(degreeId)) throw new InvalidSaveError(`Invalid save: /user_degree_list/${index} is not a title the game has`)
    }
    // the title the player has set: the client looks it up in its master table, so only one the game has
    if (checked.user_info !== undefined && !isKnownDegree(checked.user_info.degree_id)) throw new InvalidSaveError("Invalid save: /user_info/degree_id is not a title the game has")
    return checked
}

/**
 * The years a save's mail dates may lie in: every date the server's clocks can reach (src/lib/calendar.ts,
 * `EARLIEST_CLOCK_YEAR`, less a player clock's `MAX_CLOCK_OFFSET_DAYS`), from 1970 on like the save's server times, up
 * to the last year the format's four digits hold. A narrower range refused a player's own export.
 */
const EARLIEST_SAVE_YEAR = 1970
const LATEST_SAVE_YEAR = 9999

/** A save time ("YYYY-MM-DD HH:MM:SS", UTC) that is a real date in the save's years. */
function isSaneTime(time: string): boolean {
    const date = new Date(`${time.replace(" ", "T")}Z`)
    return !isNaN(date.getTime()) && date.toISOString().slice(0, 19).replace("T", " ") === time
        && date.getUTCFullYear() >= EARLIEST_SAVE_YEAR && date.getUTCFullYear() <= LATEST_SAVE_YEAR
}

/**
 * Checks a save's gift box: the dates are real ones, and at most `pendingMails` mails wait and `historyMails` were
 * received. Waiting mail is checked the way sent mail is (ids the game has, amounts it can grant, the admin form's text
 * rules), and refused otherwise. Received mail is only history, written by whatever build received it: one that
 * today's checks refuse (an amount past today's cap, a unit no longer playable) is left out and reported, never the
 * reason to refuse the save. Returns the mail to import.
 */
function checkSaveMail(mails: SaveMail[], onDropped: DroppedMailHandler): SaveMail[] {
    const kept: SaveMail[] = []
    let pending = 0
    for (const [index, mail] of mails.entries()) {
        const where = `/user_mail_list/${index}`
        for (const field of ["create_time", "receive_time", "reward_limit_time"] as const) {
            const time = mail[field]
            if (time !== null && !isSaneTime(time)) throw new InvalidSaveError(`Invalid save: ${where}/${field} is not a date from ${EARLIEST_SAVE_YEAR} to ${LATEST_SAVE_YEAR}`)
        }
        try {
            checkMailContents({ type: mail.type, typeId: mail.type_id, number: mail.number })
            checkMailText(mail.subject, mail.description)
        } catch (error) {
            if (!(error instanceof InvalidMailError)) throw error
            // the messages are our own and quote only integers the schema has checked
            if (mail.receive_time === null) throw new InvalidSaveError(`Invalid save: ${where}: ${error.message}`)
            onDropped(where, error.message)
            continue
        }
        if (mail.receive_time === null) pending++
        kept.push(mail)
    }
    if (pending > mailLimits.pendingMails) throw new InvalidSaveError(`Invalid save: /user_mail_list has more than ${mailLimits.pendingMails} mails waiting`)
    if (kept.length - pending > mailLimits.historyMails) throw new InvalidSaveError(`Invalid save: /user_mail_list has more than ${mailLimits.historyMails} received mails`)
    return kept
}
