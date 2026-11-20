// What a player gets for duplicates (FT-40): melting an armament's duplicates (`equipment/sell_stack`,
// `equipment/bulk_sell_stack`), awakening armaments with their duplicates (`equipment/bulk_upgrade`), uncapping units
// with theirs (`character/bulk_over_limit`) and turning a uncapped unit's duplicates into pooled EXP
// (`expod/stack_to_exp`, `expod/bulk_stack_to_exp`). The rates come from the client's masters
// (`assets/sell_rules.json`, scripts/converter.py `convert_sell_rules`):
// - a melted duplicate gives the armament's ability core, Wrightpieces by rarity (`dissolving_craft_point`: 1-5) and,
//   for an armament from portals (`obtain_source` 0), Star Specks (`equipment_dissolve_rate`: 0, 0, 1, 5, 15). The
//   capture `docs/routes/equipment_sell_stack.md` agrees: one 1★ duplicate gave one Wrightpiece and no Star Speck.
// - an awakening level costs Wrightpieces by rarity (`awakening_craft_point`: 5-25) and gives an ability core.
// - a converted unit duplicate gives pooled EXP by rarity (100, 300, 500, 2000, 10000) and, for a unit from portals,
//   Star Specks (0, 0, 2, 10, 30).
// Items given are capped at what the player may own (src/lib/rewardCredits.ts). Cores and Wrightpieces past their cap
// (9,999 a core, 99,999 Wrightpieces) turn into mana at the item's sale price instead (FT-69), as the client says:
// awakening asks "Crafting Ability Cores x::n:: will exceed storage limits. Convert these Ability Cores to ::mana:: mana
// instead?" (`EquipmentUpgradeConvertToManaConfirmDialog`, mana = core sale price x excess), and melting asks the same
// for Wrightpieces (`EquipmentSellConfirmConvertCraftPointToMana`, Wrightpiece sale price x excess). For cores from a
// melt the client asks nothing, but its result passes the cores that didn't arrive to the core result dialog as
// `convertAbilitySoulNum`, as awakening does, so they convert the same way. Star Specks past their cap are lost.
// An augmented armament keeps its augmentation when its duplicates are melted, and can't be melted itself (FT-57,
// `meltEquipmentSync`).

import sellRules from "../../assets/sell_rules.json";
import { PlayerEquipment } from "../data/types";
import { deletePlayerEquipmentSync, getPlayerEquipmentSync, getPlayerItemSync, isPlayerEquipmentInPartySync, updatePlayerEquipmentSync, updatePlayerItemSync } from "../data/wdfpData";
import { getCharacterDataSync, getEquipmentMaxLevelSync } from "./assets";
import { clientSerializeEquipment } from "./equipment";
import { creditEarnedCurrencySync, creditEarnedItemSync } from "./rewardCredits";

export const WRIGHTPIECE_ITEM_ID = 100000
export const STAR_SPECK_ITEM_ID = 990008

/** `equipment_dissolve_rate`: the Star Specks a melted duplicate gives, by rarity (1-5). */
const EQUIPMENT_DISSOLVE_STAR_SPECKS = [0, 0, 1, 5, 15]

/** The Wrightpiece's sale price in mana (master `item/item`, row 100000: column 15; it isn't sellable itself). */
const WRIGHTPIECE_SALE_PRICE = 5

interface SellRules {
    items: Record<string, { price: number }>
    craftPoints: Record<string, { dissolve: number, awaken: number }>
    experienceConversion: Record<string, { exp: number, starGrain: number }>
    unmeltableEquipment: number[]
    equipmentWithoutStarGrain: number[]
    charactersWithoutStarGrain: number[]
}

const rules = sellRules as unknown as SellRules
const unmeltable = new Set(rules.unmeltableEquipment)
const equipmentWithoutStarGrain = new Set(rules.equipmentWithoutStarGrain)
const charactersWithoutStarGrain = new Set(rules.charactersWithoutStarGrain)

/** An armament's rarity (1-5), from its id. */
export function equipmentRarity(equipmentId: number): number {
    return Math.min(5, Math.max(1, Math.floor(equipmentId / 1000000)))
}

/** The Wrightpieces one awakening level of an armament costs. */
export function awakeningCost(equipmentId: number): number {
    return rules.craftPoints[String(equipmentRarity(equipmentId))]?.awaken ?? 0
}

/** Mana owed for cores and Wrightpieces past their cap, paid once per request by `payOverflowManaSync`. */
export interface OverflowMana { mana: number }

/** The mana one copy past the cap is worth: cores and Wrightpieces only. */
function overflowPrice(itemId: number): number {
    if (itemId === WRIGHTPIECE_ITEM_ID) return WRIGHTPIECE_SALE_PRICE
    return rules.items[String(itemId)]?.price ?? 0
}

/**
 * Adds to an item and records its new total in `items` (capped at what the player may own); with `overflow`, what
 * didn't fit is owed as mana.
 */
function credit(playerId: number, itemId: number, amount: number, items: Record<string, number>, overflow?: OverflowMana) {
    if (amount <= 0) return
    const credited = creditEarnedItemSync(playerId, itemId, amount)
    items[String(itemId)] = credited.total
    if (overflow) overflow.mana += (amount - credited.amount) * overflowPrice(itemId)
}

/** Pays the mana owed (capped at the mana limit); the reply's `user_info` when any was owed, else nothing. */
export function payOverflowManaSync(playerId: number, overflow: OverflowMana): { user_info: { free_mana: number } } | {} {
    if (overflow.mana <= 0) return {}
    return { user_info: { free_mana: creditEarnedCurrencySync(playerId, "mana", overflow.mana).total } }
}

export type DuplicateResult<T> = { refusal: string } | T

/**
 * Melts `count` duplicates of an armament: the stack goes down, and the cores, Wrightpieces and Star Specks are added
 * to `items` (new totals). `protectedRefused` refuses a locked armament (the bulk melt; the client's single melt
 * doesn't check it).
 */
export function meltDuplicatesSync(playerId: number, equipmentId: number, count: number, items: Record<string, number>,
    overflow: OverflowMana, protectedRefused = false): DuplicateResult<{ equipment: Object }> {
    const equipment = getPlayerEquipmentSync(playerId, equipmentId)
    if (equipment === null) return { refusal: "Player does not own equipment." }
    if (unmeltable.has(equipmentId)) return { refusal: "This armament can't be melted down." }
    if (protectedRefused && equipment.protection) return { refusal: "This armament is locked." }
    if (!Number.isSafeInteger(count) || count < 1) return { refusal: "Invalid number of duplicates." }
    if (count > equipment.stack) return { refusal: "Attempt to sell more stacks than owned." }

    const rarity = equipmentRarity(equipmentId)
    updatePlayerEquipmentSync(playerId, equipmentId, { stack: equipment.stack - count })
    credit(playerId, equipmentId, count, items, overflow)
    credit(playerId, WRIGHTPIECE_ITEM_ID, (rules.craftPoints[String(rarity)]?.dissolve ?? 0) * count, items, overflow)
    if (!equipmentWithoutStarGrain.has(equipmentId)) credit(playerId, STAR_SPECK_ITEM_ID, EQUIPMENT_DISSOLVE_STAR_SPECKS[rarity - 1] * count, items)
    return { equipment: clientSerializeEquipment(equipmentId, { ...equipment, stack: equipment.stack - count }) }
}

/**
 * Why the armament itself can't be melted, as the client's `getSellableStatus` refuses it: it is augmented
 * (`EquipmentEnhancedAndNoStack`, FT-57) or equipped in a party (`EquipmentEquipped`, "You cannot melt down equipped
 * armaments"). Melting only its duplicates (`meltDuplicatesSync`) keeps the armament, so neither applies there.
 */
function keptArmamentRefusal(playerId: number, equipmentId: number, equipment: PlayerEquipment): string | null {
    if (equipment.enhancementLevel > 0) return "An augmented armament can't be melted down, only its duplicates."
    if (isPlayerEquipmentInPartySync(playerId, equipmentId)) return "An armament in a party can't be melted down."
    return null
}

/**
 * Melts an armament itself (`equipment/sell_equipment`, the client's "sell all" when it has no duplicates left): the
 * armament and any duplicates are melted, one core, the Wrightpieces and the Star Specks per copy, and the armament is
 * removed. The capture `docs/routes/equipment_sell_equipment.md` agrees: a 2★ armament without duplicates gave one core
 * and, with `equipment_sell_stack.md` taken after it, two Wrightpieces. A locked armament is refused, as the client
 * doesn't offer it. So is an augmented one (FT-57): the client's `getSellableStatus` gives an armament with an
 * `enhancement_level` above 0 the reason `EquipmentEnhancedAndNoStack` ("Cannot melt down ::name::", Japanese "::name::
 * itself can't be melted down"), so only its duplicates can be melted (`meltDuplicatesSync`), and its augmentation
 * stays. An armament equipped in a party is refused too, whatever its stack (`keptArmamentRefusal`).
 */
export function meltEquipmentSync(playerId: number, equipmentId: number, items: Record<string, number>, overflow: OverflowMana): DuplicateResult<{}> {
    const equipment = getPlayerEquipmentSync(playerId, equipmentId)
    if (equipment === null) return { refusal: "Player does not own equipment." }
    if (unmeltable.has(equipmentId)) return { refusal: "This armament can't be melted down." }
    if (equipment.protection) return { refusal: "This armament is locked." }
    const keptReason = keptArmamentRefusal(playerId, equipmentId, equipment)
    if (keptReason !== null) return { refusal: keptReason }
    const copies = equipment.stack + 1
    const rarity = equipmentRarity(equipmentId)
    deletePlayerEquipmentSync(playerId, equipmentId)
    credit(playerId, equipmentId, copies, items, overflow)
    credit(playerId, WRIGHTPIECE_ITEM_ID, (rules.craftPoints[String(rarity)]?.dissolve ?? 0) * copies, items, overflow)
    if (!equipmentWithoutStarGrain.has(equipmentId)) credit(playerId, STAR_SPECK_ITEM_ID, EQUIPMENT_DISSOLVE_STAR_SPECKS[rarity - 1] * copies, items)
    return {}
}

/**
 * Awakens an armament with all the duplicates it can use (`min(stack, max level - level)` levels, no Starsteel
 * Ingots), paying Wrightpieces: the levels and their cost, or a refusal when there's nothing to awaken. Nothing is
 * written; `applyAwakeningSync` does it once every armament of a request has passed.
 */
export function plannedAwakening(playerId: number, equipmentId: number): DuplicateResult<{ equipment: PlayerEquipment, levels: number, cost: number }> {
    const equipment = getPlayerEquipmentSync(playerId, equipmentId)
    if (equipment === null) return { refusal: "Player does not own equipment." }
    const maxLevel = getEquipmentMaxLevelSync(equipmentId) ?? 5
    const levels = Math.min(equipment.stack, maxLevel - equipment.level)
    if (levels < 1) return { refusal: "Nothing to awaken." }
    return { equipment, levels, cost: levels * awakeningCost(equipmentId) }
}

/** Applies a planned awakening: the level and stack change, and the cores are added to `items`. */
export function applyAwakeningSync(playerId: number, equipmentId: number, plan: { equipment: PlayerEquipment, levels: number },
    items: Record<string, number>, overflow: OverflowMana): Object {
    const after = { ...plan.equipment, level: plan.equipment.level + plan.levels, stack: plan.equipment.stack - plan.levels }
    updatePlayerEquipmentSync(playerId, equipmentId, { level: after.level, stack: after.stack })
    creditAwakeningCoresSync(playerId, equipmentId, plan.levels, items, overflow)
    return clientSerializeEquipment(equipmentId, after)
}

/** The cores `levels` awakenings craft (one each), with those past the cap owed as mana; for `equipment/upgrade` too. */
export function creditAwakeningCoresSync(playerId: number, equipmentId: number, levels: number, items: Record<string, number>,
    overflow: OverflowMana) {
    credit(playerId, equipmentId, levels, items, overflow)
}

/** Takes Wrightpieces, or returns false when the player has too few. */
export function spendWrightpiecesSync(playerId: number, amount: number, items: Record<string, number>): boolean {
    const owned = getPlayerItemSync(playerId, WRIGHTPIECE_ITEM_ID) ?? 0
    if (owned < amount) return false
    if (amount > 0) {
        updatePlayerItemSync(playerId, WRIGHTPIECE_ITEM_ID, owned - amount)
        items[String(WRIGHTPIECE_ITEM_ID)] = owned - amount
    }
    return true
}

/**
 * What converting `count` duplicates of a unit gives: pooled EXP and, for a unit from portals, Star Specks. Null for a
 * unit without master data.
 */
export function conversionYield(characterId: number, count: number): { exp: number, starSpecks: number } | null {
    const character = getCharacterDataSync(characterId)
    if (character === null) return null
    const rate = rules.experienceConversion[String(character.rarity)] ?? { exp: 0, starGrain: 0 }
    return { exp: rate.exp * count, starSpecks: charactersWithoutStarGrain.has(characterId) ? 0 : rate.starGrain * count }
}

/** Gives the Star Specks of a conversion; their new total goes into `items`. */
export function creditStarSpecksSync(playerId: number, amount: number, items: Record<string, number>) {
    credit(playerId, STAR_SPECK_ITEM_ID, amount, items)
}
