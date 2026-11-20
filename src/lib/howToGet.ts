// "How to obtain" (FT-16, how_to_get/get_list): where an item or armament can be got right now. The reply lists the
// box gachas that hold it and the shop products that give it, as shop/get_sales_list entries. Matching the original's
// reply (docs/routes/how_to_get_get_list.md, item 2 on 2024-06-22): every product on sale of the Boss Coin, event
// item and Star Speck shops that gives it, and the boxes open then; not the Trove's products, whose daily lineup is
// random. The general shop counts too (it sells no item 2). Paid packs (shop_type 3) aren't in the data (FT-19).
// Products of a select item campaign's lineup that the player can't buy (another lineup chosen, or none yet; FT-38)
// go to `unselected_lineup_shop_sales_list` instead.

import bossCoinShop from "../../assets/boss_coin_shop.json";
import eventItemShop from "../../assets/event_item_shop.json";
import generalShop from "../../assets/general_shop.json";
import starGrainShop from "../../assets/star_grain_shop.json";
import boxRewards from "../../assets/box_reward.json";
import boxResets from "../../assets/box_gacha_reset.json";
import { masterDate } from "../utils";
import { isContentPeriodOpen } from "./eventSchedule";
import { lineupPurchaseRefusal } from "./lineupChoice";
import { isOnSale, salesListEntry } from "./shopLimits";
import { BoxGachaIdReward, BoxGachaRewardType, BossCoinShopItems, EventShopItems, RawBoxRewards, ShopItem, ShopItemRewardType, ShopItems, ShopType } from "./types";

/** What the player asks about: an item (`item_id`) or an armament (`equipment_id`). */
export type HowToGetTarget = { kind: "item" | "equipment", id: number }

/** Every product of each shop the lookup searches, by shop type. */
const shops: [ShopType, ShopItems][] = [
    [ShopType.EVENT_ITEM, Object.assign({}, ...Object.values(eventItemShop as EventShopItems).flatMap(events => Object.values(events)))],
    [ShopType.BOSS_COIN, Object.assign({}, ...Object.values(bossCoinShop as BossCoinShopItems))],
    [ShopType.GENERAL, generalShop as ShopItems],
    [ShopType.STAR_GRAIN, starGrainShop as ShopItems]
]

function productGives(item: ShopItem, target: HowToGetTarget): boolean {
    const type = target.kind === "item" ? ShopItemRewardType.ITEM : ShopItemRewardType.EQUIPMENT
    return (item.rewards as { type: number, id?: number }[]).some(reward => reward.type === type && reward.id === target.id)
}

/** A box gacha's period: its boxes' reset rules (assets/box_gacha_reset.json); a gacha without one has none. */
function boxGachaOpen(boxGachaId: string, date: Date): boolean {
    const rules = Object.values((boxResets as Record<string, Record<string, { start: string, end: string }>>)[boxGachaId] ?? {})
    return rules.some(rule => isContentPeriodOpen(masterDate(rule.start).getTime(), masterDate(rule.end).getTime(), date))
}

function boxGachaGives(boxes: RawBoxRewards[string], target: HowToGetTarget): boolean {
    const type = target.kind === "item" ? BoxGachaRewardType.ITEM : BoxGachaRewardType.EQUIPMENT
    return Object.values(boxes).some(box => Object.values(box).some(reward => reward.type === type && (reward as BoxGachaIdReward).id === target.id))
}

/** The reply's data for `target`, as of `date`. */
export function howToGetSync(playerId: number, target: HowToGetTarget, date: Date) {
    const salesList: ReturnType<typeof salesListEntry>[] = []
    const unselectedLineupSalesList: ReturnType<typeof salesListEntry>[] = []
    for (const [shopType, items] of shops) {
        for (const [shopItemId, item] of Object.entries(items)) {
            if (!productGives(item, target) || !isOnSale(item, date)) continue
            const entry = salesListEntry(playerId, shopType, Number(shopItemId), date)
            if (lineupPurchaseRefusal(playerId, shopType, Number(shopItemId), date) === null) salesList.push(entry)
            else unselectedLineupSalesList.push(entry)
        }
    }
    const boxGachaIds = Object.entries(boxRewards as RawBoxRewards)
        .filter(([boxGachaId, boxes]) => boxGachaGives(boxes, target) && boxGachaOpen(boxGachaId, date))
        .map(([boxGachaId]) => Number(boxGachaId))
    return {
        "box_gacha_id_list": boxGachaIds,
        "unselected_lineup_shop_sales_list": unselectedLineupSalesList,
        "shop_sales_list": salesList
    }
}
