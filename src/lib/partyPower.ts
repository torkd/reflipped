// Party power (FT-63): the score the client shows for a party ("party_power_score"), which suggested parties (FT-50,
// src/lib/recentParties.ts) send as `power` because the panel shows that value as it is. This is the client's own
// formula, read from its bytecode (the party's getBattlePower and the unit, armament and status helpers it calls);
// the stat tables are in assets/party_power.json (scripts/converter.py, "Party power").
//
// Per party slot with a main unit, the client adds
//   int(0.2 * hp + atk + 10 * mana nodes + EX ability power + armament augment ability power + 10 * core rarity)
// where
//   hp  = the main unit's HP + int(0.25 * the unison unit's HP) + the armament's HP (atk likewise);
//   a unit's HP = ceil(status HP at its level * (1 + over limit steps * HP % per step / 100)) + its evolution bonus
//                 + its EX boost status HP;
//   mana nodes and EX ability power (ex_boost/ex_ability battle_power) are the main and unison units' together;
//   an armament's HP = its status HP at its level + its augment HP at its augment level.
// Status tables hold a few key levels; the client interpolates linearly between them and rounds up. `int()` is the
// client's float to int conversion (truncation after nudging by 1e-10 away from zero).
//
// One part is left out: an augmented armament's augment ability adds its abilities' power, which the client works out
// from each trigger's level-scaled power values. Only augmented armaments (26 of them) have one, so their parties
// show a little less than in the client.

import partyPowerData from "../../assets/party_power.json";
import { clampEquipmentLevel, getCharacterDataSync } from "./assets";
import { characterLevel } from "./missions";
import { getPlayerCharacterManaNodesSync, getPlayerCharacterSync, getPlayerEquipmentSync, getPlayerItemSync } from "../data/wdfpData";
import { unitStatusRows, visibleManaNodes } from "./balance";
import { PlayerCharacter, PlayerEquipment } from "../data/types";

/** Rows of a stat table: [key level, hp, atk], sorted by level. */
type LeveledRows = [number, number, number][]

interface PartyPowerData {
    characterStatus: Record<string, LeveledRows>
    /** per rarity: atk_plus_value_1, hp_plus_value_1, atk_plus_value_2, hp_plus_value_2 */
    evolution: Record<string, [number, number, number, number]>
    /** per rarity: HP and ATK percent added per over limit step */
    overLimitPercent: Record<string, [number, number]>
    /** per EX boost status: hp, atk */
    exStatus: Record<string, [number, number]>
    exAbilityPower: Record<string, number>
    equipmentStatus: Record<string, LeveledRows>
    equipmentEnhancementStatus: Record<string, LeveledRows>
    abilitySoulRarity: Record<string, number>
}

const data = partyPowerData as unknown as PartyPowerData

const HP = 1
const ATK = 2

/** The client's float to int conversion: nudged by 1e-10 away from zero, then truncated. */
function toInt(value: number): number {
    return Math.trunc(value < 0 ? value - 1e-10 : value + 1e-10)
}

/**
 * A unit's or armament's stat at `level` (the client's status logics): the last key level at or below it, linearly
 * interpolated towards the next one and rounded up; past the last key level, the last row. Null below the first key
 * level, where the client throws.
 */
function statAt(rows: LeveledRows | undefined, level: number, column: number): number | null {
    if (rows === undefined || rows.length === 0 || level < rows[0][0]) return null
    let index = 0
    while (index + 1 < rows.length && rows[index + 1][0] <= level) index++
    if (index === rows.length - 1) return rows[index][column]
    const [low, high] = [rows[index], rows[index + 1]]
    const t = (level - low[0]) / (high[0] - low[0])
    return Math.ceil(low[column] * (1 - t) + high[column] * t)
}

/**
 * An armament's augment stat at `enhancementLevel` (the client's enhancement status logic): 0 for armaments without
 * augments; below the first key level it rises from 0, between key levels it is interpolated as above.
 */
function enhancementStatAt(equipmentId: number, enhancementLevel: number, column: number): number {
    const rows = data.equipmentEnhancementStatus[String(equipmentId)]
    if (rows === undefined || rows.length === 0) return 0
    const first = rows[0]
    if (enhancementLevel < first[0]) return Math.ceil(first[column] * (enhancementLevel / first[0]))
    return statAt(rows, enhancementLevel, column) ?? 0
}

/** A unit's own part: its HP and ATK (without unison), mana nodes and EX ability power. */
interface UnitPower {
    hp: number
    atk: number
    manaNodes: number
    exAbilityPower: number
}

/** The evolution bonus: nothing at evolution level 0, the first value at 1, both at 2. */
function evolutionBonus(rarity: number, evolutionLevel: number, column: typeof HP | typeof ATK): number {
    const row = data.evolution[String(rarity)]
    if (row === undefined) return 0
    const [first, second] = column === HP ? [row[1], row[3]] : [row[0], row[2]]
    if (evolutionLevel === 1) return first
    if (evolutionLevel === 2) return first + second
    return 0
}

function unitPower(characterId: number, character: PlayerCharacter, manaNodes: number): UnitPower | null {
    const rarity = getCharacterDataSync(characterId)?.rarity
    const finalRows = data.characterStatus[String(characterId)]
    if (rarity === undefined || finalRows === undefined) return null
    // the stats before balance changes not landed yet on the shared timeline (FT-47)
    const rows = unitStatusRows(characterId, finalRows)
    const level = characterLevel(character.exp, rarity)
    const [hpPercent, atkPercent] = data.overLimitPercent[String(rarity)] ?? [0, 0]
    const base = (column: typeof HP | typeof ATK, percent: number) =>
        Math.ceil((statAt(rows, level, column) ?? 0) * (1 + (percent * character.overLimitStep) / 100))
    const exStatus = character.exBoost === undefined ? undefined : data.exStatus[String(character.exBoost.statusId)]
    return {
        hp: base(HP, hpPercent) + evolutionBonus(rarity, character.evolutionLevel, HP) + (exStatus?.[0] ?? 0),
        atk: base(ATK, atkPercent) + evolutionBonus(rarity, character.evolutionLevel, ATK) + (exStatus?.[1] ?? 0),
        manaNodes,
        exAbilityPower: (character.exBoost?.abilityIdList ?? [])
            .reduce((sum, abilityId) => sum + (data.exAbilityPower[String(abilityId)] ?? 0), 0)
    }
}

function equipmentStats(equipmentId: number, equipment: PlayerEquipment): [number, number] {
    const rows = data.equipmentStatus[String(equipmentId)]
    const level = clampEquipmentLevel(equipmentId, equipment.level)
    return [HP, ATK].map(column =>
        (statAt(rows, level, column) ?? 0) + enhancementStatAt(equipmentId, equipment.enhancementLevel, column)
    ) as [number, number]
}

/** One party slot's ids; null where the slot is empty. */
export interface PartyPowerSlot {
    character: number | null
    unisonCharacter: number | null
    equipment: number | null
    abilitySoul: number | null
}

/**
 * The power score of a party of the player's own units, armaments and Ability Cores, as the client works it out from
 * what the player has now. Units, armaments or cores the player doesn't have count for nothing.
 */
export function partyPowerSync(playerId: number, slots: PartyPowerSlot[]): number {
    const unit = (characterId: number | null): UnitPower | null => {
        if (characterId === null) return null
        const character = getPlayerCharacterSync(playerId, characterId)
        return character === null ? null : unitPower(characterId, character, visibleManaNodes(characterId, getPlayerCharacterManaNodesSync(playerId, characterId)).length)
    }
    let total = 0
    for (const slot of slots) {
        const main = unit(slot.character)
        if (main === null) continue
        const unison = unit(slot.unisonCharacter)
        const equipment = slot.equipment === null ? null : getPlayerEquipmentSync(playerId, slot.equipment)
        const [equipmentHp, equipmentAtk] = equipment === null || slot.equipment === null ? [0, 0] : equipmentStats(slot.equipment, equipment)
        const soulRarity = slot.abilitySoul === null || (getPlayerItemSync(playerId, slot.abilitySoul) ?? 0) <= 0 ? 0
            : data.abilitySoulRarity[String(slot.abilitySoul)] ?? 0

        const hp = main.hp + toInt((unison?.hp ?? 0) * 0.25) + equipmentHp
        const atk = main.atk + toInt((unison?.atk ?? 0) * 0.25) + equipmentAtk
        const manaNodes = main.manaNodes + (unison?.manaNodes ?? 0)
        const exAbilityPower = main.exAbilityPower + (unison?.exAbilityPower ?? 0)
        // the client's order of operations, so the rounding matches
        total += toInt(hp * 0.2 + atk * 1.0 + manaNodes * 10.0 + exAbilityPower + 0 + soulRarity * 10.0)
    }
    return total
}
