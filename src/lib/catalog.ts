/**
 * What exists in the game data: playable units and the item and equipment ids the game hands out.
 * Developer mode grants these, and the admin mail picker lists them.
 */
import { existsSync, readFileSync } from "fs";
import { assetPath } from "./paths";

import characters from "../../assets/character.json";
import manaNodes from "../../assets/mana_node.json";
import degreeIds from "../../assets/degree.json";
import { rewardPointCatalog } from "./rewardPoints";
// reward and shop data, read for item and equipment ids
import boxReward from "../../assets/box_reward.json";
import bossCoinShop from "../../assets/boss_coin_shop.json";
import clearReward from "../../assets/clear_reward.json";
import eventItemShop from "../../assets/event_item_shop.json";
import generalShop from "../../assets/general_shop.json";
import rareScoreReward from "../../assets/rare_score_reward.json";
import scoreReward from "../../assets/score_reward.json";
import starGrainShop from "../../assets/star_grain_shop.json";
import treasureShop from "../../assets/treasure_shop.json";

/**
 * Playable characters: the 6-digit ids of the character list, except the 999999 placeholder and
 * the 7xxxxx entries (event and guest units; several have no skills at all, and owning them
 * makes the client's unit list fail with C8601, a missing master data key).
 */
export function getPlayableCharacterIds(): number[] {
    return Object.keys(characters)
        .filter(id => /^[1-6]\d{5}$/.test(id))
        .map(Number)
}

/**
 * Item and equipment ids the game hands out, read with each source's own reward type numbering
 * (they differ: shops use 4 for equipment, box gacha and clear rewards 1). Score reward entries of
 * type 1 are rare reward pool numbers, not items; granting those as items breaks the client's unit
 * and item lists with C8601 (a missing master data key), so ids are never guessed from their shape.
 */
export function scanAssetItemAndEquipmentIds(): { items: number[], equipment: number[] } {
    const items = new Set<number>(), equipment = new Set<number>()
    const add = (set: Set<number>, value: unknown) => {
        const id = Number(value)
        if (Number.isInteger(id) && id > 0 && !(String(id) in characters)) set.add(id)
    }
    const entries = (source: unknown): any[] => {
        const out: any[] = []
        const walk = (node: unknown) => {
            if (Array.isArray(node)) return node.forEach(walk)
            if (!node || typeof node !== "object") return
            if ("id" in (node as object) && "type" in (node as object)) out.push(node)
            else Object.values(node as object).forEach(walk)
        }
        walk(source)
        return out
    }
    // clear rewards and box gacha prizes: 0 item, 1 equipment
    for (const entry of [...entries(clearReward), ...entries(boxReward)]) {
        if (entry.type === 0) add(items, entry.id)
        else if (entry.type === 1) add(equipment, entry.id)
    }
    // rare score rewards: 0 item, 1 equipment
    for (const entry of entries(rareScoreReward)) {
        if (entry.type === 0) add(items, entry.id)
        else if (entry.type === 1) add(equipment, entry.id)
    }
    // score rewards: type 0 with reward_type 0 is an item; type 1 is a rare pool number
    for (const entry of entries(scoreReward)) {
        if (entry.type === 0 && entry.reward_type === 0) add(items, entry.id)
    }
    // shops: rewards 0 item, 4 equipment; every cost is an item (currencies, coins, tokens)
    const shopEntries: any[] = []
    const collectShop = (node: unknown) => {
        if (Array.isArray(node)) return node.forEach(collectShop)
        if (!node || typeof node !== "object") return
        if ("rewards" in (node as object)) shopEntries.push(node)
        else Object.values(node as object).forEach(collectShop)
    }
    for (const shop of [bossCoinShop, eventItemShop, generalShop, starGrainShop, treasureShop]) collectShop(shop)
    for (const entry of shopEntries) {
        for (const reward of entry.rewards ?? []) {
            if (reward.type === 0) add(items, reward.id)
            else if (reward.type === 4) add(equipment, reward.id)
        }
        for (const cost of entry.costs ?? []) add(items, cost.id)
    }
    // mana node costs: { items: { "<itemId>": amount } }
    for (const boards of Object.values(manaNodes as Record<string, Record<string, Record<string, any>>>)) {
        for (const nodes of Object.values(boards)) {
            for (const node of Object.values(nodes)) Object.keys(node.items ?? {}).forEach(id => add(items, id))
        }
    }
    return { items: [...items].sort((a, b) => a - b), equipment: [...equipment].sort((a, b) => a - b) }
}

// --- catalog for the admin mail picker -------------------------------------------------------------

/**
 * Names, item categories and armament rarities, keyed by id, from the client's master data (ADM-1: `scripts/converter.py`
 * writes it from `character/character_text`, `item/equipment`, `item/item` and `degree/degree`). Its ids are every armament,
 * item and title the client knows, so the catalog lists those; without the file it lists the ids the rewards and shops
 * hand out, without names.
 */
const namesPath = assetPath("catalog_names.json")

interface CatalogNames {
    characters?: Record<string, string>
    equipment?: Record<string, { name: string | null, rarity: number }>
    items?: Record<string, { name: string | null, category: number }>
    degrees?: Record<string, string>
}

/** `item/item` column 13, the client's item list category, with the names the picker shows. */
export const ITEM_CATEGORIES: Record<number, string> = {
    0: "Consumables",
    2: "Growth materials",
    3: "Event items",
    4: "Tickets",
    5: "Armament cores",
    6: "Boss coins",
    7: "Currencies",
    8: "Currencies",
    9: "Armament materials"
}

export interface CatalogUnit {
    id: number
    name: string | null
    rarity: number
    element: number
}

export interface CatalogEntry {
    id: number
    name: string | null
}

export interface CatalogArmament extends CatalogEntry {
    /** null without `assets/catalog_names.json` */
    rarity: number | null
}

export interface CatalogItem extends CatalogEntry {
    /** a value of `ITEM_CATEGORIES`, null without `assets/catalog_names.json` */
    category: string | null
}

export interface ItemCatalog {
    hasNames: boolean
    units: CatalogUnit[]
    equipment: CatalogArmament[]
    items: CatalogItem[]
    degrees: CatalogEntry[]
    /** the item categories in the order the picker shows them */
    itemCategories: string[]
    /** mail types 14 and 15, with their master names */
    dailyChallengePoints: CatalogEntry[]
    periodicRewardPoints: CatalogEntry[]
}

let cachedCatalog: ItemCatalog | null = null

const sortedIds = (ids: Iterable<string | number>) => [...new Set([...ids].map(Number))].sort((a, b) => a - b)

/**
 * Everything the admin can send by mail: playable units with rarity and element, the armaments, items and titles the
 * game knows, with names, item categories and armament rarities when `assets/catalog_names.json` exists; the daily
 * challenge and periodic reward points with their names from the master data.
 */
export function getItemCatalog(): ItemCatalog {
    if (cachedCatalog !== null) return cachedCatalog

    const names: CatalogNames = existsSync(namesPath) ? JSON.parse(readFileSync(namesPath, "utf-8")) : {}
    const nameOf = (table: Record<string, string> | undefined, id: number) => table?.[String(id)] || null
    const characterData = characters as Record<string, { name: string, rarity: number, element: number }>
    const scanned = scanAssetItemAndEquipmentIds()
    const equipmentIds = names.equipment ? sortedIds(Object.keys(names.equipment)) : scanned.equipment
    const itemIds = names.items ? sortedIds(Object.keys(names.items)) : scanned.items

    cachedCatalog = {
        hasNames: Object.keys(names).length > 0,
        units: getPlayableCharacterIds().map(id => ({
            id,
            name: nameOf(names.characters, id) ?? (characterData[String(id)].name || null),
            rarity: characterData[String(id)].rarity,
            element: characterData[String(id)].element
        })),
        equipment: equipmentIds.map(id => {
            const entry = names.equipment?.[String(id)]
            return { id, name: entry?.name || null, rarity: entry?.rarity ?? null }
        }),
        items: itemIds.map(id => {
            const entry = names.items?.[String(id)]
            return { id, name: entry?.name || null, category: entry ? (ITEM_CATEGORIES[entry.category] ?? "Other") : null }
        }),
        degrees: (degreeIds as number[]).map(id => ({ id, name: nameOf(names.degrees, id) })),
        itemCategories: [...new Set([...Object.values(ITEM_CATEGORIES), "Other"])],
        ...rewardPointCatalog()
    }
    return cachedCatalog
}
