// Armament augmentation (FT-54, the augment shop, the client's shop type 10, `EquipmentEnhancement`). Some armaments
// can be raised past their usual maximum: each has a chain of shop rows (`equipment_enhancement_shop`), one per stage,
// and every level bought costs the stage's items (the co-op boss events' gears, FT-23, and other materials). The
// armament keeps the levels bought as its `enhancement_level` (0 to 99, or 120 for the Score Scramble ones); the
// client derives its name, art, stats and extra abilities from that level and the master tables.
//
// From the client (no capture holds an augmentation): the shop is listed through `shop/get_sales_list` with
// `shop_types: [10]` and `equipment_enhancement_shop_category_ids: [category]`, and bought through `shop/buy` with
// `shop_type: 10`, a shop row and the number of levels. A sales entry's `group_info.group_total_purchase_num` is the
// armament's level, `group_total_stock_quantity` the levels left in the whole chain, `multi_stage` whether the chain
// has more than one stage, and `stock_quantity` the levels left in this stage (0 shows "max enhancement level"). The
// server lists one row per armament, its current stage: inferred, since every client computation fits it. A buy's
// reply carries the armament's new entry (`equipment_list`) and the cost items' balances (`item_list`); the client
// then asks for the list again, which shows the next stage.
//
// Rules: the feature (`equipment_enhancement_config`), the category, the row and the armament must be in their
// periods (projected onto the event timeline like other master dates); the player needs the feature's unlock
// (`game_system_unlock` `equipment_enhancement`, rank 90) and the row's release rank; the armament must be owned and
// awakened to the row's level; a buy stays within the current stage (the client doesn't check that, so it is the
// server's rule: from the previous stage's highest level up to this one's). Data: `assets/equipment_enhancement.json`
// (scripts/converter.py, `convert_equipment_enhancement`).

import enhancementData from "../../assets/equipment_enhancement.json";
import { getPlayerEquipmentSync, getPlayerItemSync, getPlayerSync, updatePlayerEquipmentSync, updatePlayerItemSync } from "../data/wdfpData";
import { masterDate } from "../utils";
import { playerRankSync } from "./assets";
import { isContentPeriodOpen } from "./eventSchedule";
import { clientSerializeEquipment } from "./equipment";
import { systemUnlockRefusal } from "./questAttempts";

export const EQUIPMENT_ENHANCEMENT_SHOP_TYPE = 10

interface Period {
    start: string
    end: string | null
}

interface AugmentRow extends Period {
    category: number
    /** the armament's chain, unique within its category */
    chain: number
    stage: number
    order: number
    /** the items each level costs */
    costs: { id: number, count: number }[]
    releaseRank: number
    equipmentId: number
    /** the stage's highest level */
    maxLevel: number
    /** the awakening level (the armament's `level`, 1-5) the stage needs */
    awakening: number
}

interface EnhancementData {
    start: string
    categories: Record<string, Period>
    equipment: Record<string, { maxLevel: number, start: string }>
    shop: Record<string, Omit<AugmentRow, "id">>
}

const data = enhancementData as EnhancementData

/** Every chain's rows by category, each chain's stages in order. */
const chainsByCategory = new Map<number, (AugmentRow & { id: number })[][]>()
{
    const chains = new Map<string, (AugmentRow & { id: number })[]>()
    for (const [id, row] of Object.entries(data.shop)) {
        const key = `${row.category}:${row.chain}`
        const chain = chains.get(key) ?? []
        chain.push({ ...row, id: Number(id) })
        chains.set(key, chain)
    }
    for (const chain of chains.values()) {
        chain.sort((a, b) => a.stage - b.stage)
        const list = chainsByCategory.get(chain[0].category) ?? []
        list.push(chain)
        chainsByCategory.set(chain[0].category, list)
    }
    for (const list of chainsByCategory.values()) list.sort((a, b) => a[0].order - b[0].order || a[0].chain - b[0].chain)
}

function isOpen(period: { start: string, end?: string | null }, date: Date): boolean {
    return isContentPeriodOpen(masterDate(period.start).getTime(), period.end ? masterDate(period.end).getTime() : undefined, date)
}

/** Whether a row can be sold at `date`: the feature, its category, its armament and the row itself in their periods. */
function rowOpen(row: AugmentRow, date: Date): boolean {
    const category = data.categories[String(row.category)]
    const equipment = data.equipment[String(row.equipmentId)]
    return isOpen({ start: data.start }, date) && category !== undefined && isOpen(category, date)
        && equipment !== undefined && isOpen({ start: equipment.start }, date) && isOpen(row, date)
}

function chainOf(row: AugmentRow): (AugmentRow & { id: number })[] {
    return (chainsByCategory.get(row.category) ?? []).find(chain => chain[0].chain === row.chain) ?? []
}

/** The level an armament has reached: its `enhancement_level`, 0 when the player doesn't own it. */
function currentLevel(playerId: number, equipmentId: number): number {
    return getPlayerEquipmentSync(playerId, equipmentId)?.enhancementLevel ?? 0
}

/** The stage a level is in: the first whose highest level is above it, else the last (fully augmented). */
function currentStage<T extends AugmentRow>(chain: T[], level: number): T {
    return chain.find(row => row.maxLevel > level) ?? chain[chain.length - 1]
}

/** The highest level of the stage before `row` (0 for the first). */
function previousMax(chain: AugmentRow[], row: AugmentRow): number {
    const index = chain.findIndex(candidate => candidate.stage === row.stage)
    return index > 0 ? chain[index - 1].maxLevel : 0
}

/**
 * The augment shop's sales entries for the categories asked, one per armament: its current stage with the levels left
 * in it and in the whole chain. Nothing while the player hasn't unlocked the feature.
 */
export function augmentSalesListSync(playerId: number, categoryIds: number[], date: Date): Object[] {
    if (systemUnlockRefusal(playerId, "equipment_enhancement") !== null) return []
    const entries: Object[] = []
    for (const categoryId of new Set(categoryIds)) {
        for (const chain of chainsByCategory.get(categoryId) ?? []) {
            const open = chain.filter(row => rowOpen(row, date))
            if (open.length === 0) continue
            const level = currentLevel(playerId, chain[0].equipmentId)
            const row = currentStage(open, level)
            const chainMax = chain[chain.length - 1].maxLevel
            entries.push({
                "shop_item_id": row.id,
                "stock_quantity": Math.max(0, row.maxLevel - level),
                "today_purchase_num": 0,
                "this_month_purchase_num": 0,
                "total_purchase_num": level,
                "group_info": {
                    "group_total_stock_quantity": Math.max(0, chainMax - level),
                    "group_total_purchase_num": level,
                    "multi_stage": chain.length > 1
                },
                "shop_type": EQUIPMENT_ENHANCEMENT_SHOP_TYPE
            })
        }
    }
    return entries
}

export type AugmentPurchase =
    | { refusal: string }
    | { equipment: Object, items: Record<string, number> }

/**
 * Buys `levels` levels of a shop row for the player: checks the periods, the unlock and rank, the armament (owned,
 * awakened enough, in this row's stage) and the costs, then takes the items and raises the armament's level.
 */
export function buyAugmentSync(playerId: number, shopItemId: number, levels: number, date: Date): AugmentPurchase {
    const raw = data.shop[String(shopItemId)]
    if (raw === undefined) return { refusal: "Shop item with specified id does not exist." }
    const row: AugmentRow = raw as AugmentRow
    if (!Number.isSafeInteger(levels) || levels < 1) return { refusal: "Invalid purchase amount." }
    if (!rowOpen(row, date)) return { refusal: "This augmentation isn't on sale." }
    const unlock = systemUnlockRefusal(playerId, "equipment_enhancement")
    if (unlock !== null) return { refusal: unlock }
    if (playerRankSync(getPlayerSync(playerId)?.rankPoint ?? 0) < row.releaseRank) return { refusal: `Needs rank ${row.releaseRank}.` }

    const equipment = getPlayerEquipmentSync(playerId, row.equipmentId)
    if (equipment === null) return { refusal: "The armament isn't owned." }
    if (equipment.level < row.awakening) return { refusal: `The armament needs awakening level ${row.awakening}.` }
    const level = equipment.enhancementLevel
    if (level < previousMax(chainOf(row), row) || level >= row.maxLevel) return { refusal: "The armament isn't at this stage." }
    if (level + levels > row.maxLevel) return { refusal: "More levels than the stage has left." }

    const items: Record<string, number> = {}
    for (const cost of row.costs) {
        const owned = getPlayerItemSync(playerId, cost.id) ?? 0
        if (owned < cost.count * levels) return { refusal: "Not enough items." }
        items[String(cost.id)] = owned - cost.count * levels
    }
    for (const [itemId, left] of Object.entries(items)) updatePlayerItemSync(playerId, itemId, left)
    updatePlayerEquipmentSync(playerId, row.equipmentId, { enhancementLevel: level + levels })
    return { equipment: clientSerializeEquipment(row.equipmentId, { ...equipment, enhancementLevel: level + levels }), items }
}
