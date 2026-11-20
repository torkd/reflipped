// The Star Sliver Exchange (FT-58, Shop → Star Sliver Exchange): Star Slivers (`star_crumb`) trade for a unit, an
// armament or an item of the exchange's list, `exchange/star_crumb` with `{ exchange_id }`.
//
// From the client (ExchangeStarCrumbRealRemote and the exchange entry's logic class):
// - the list is the master `shop/star_crumb_exchange` (assets/star_crumb_exchange.json): per exchange its kind
//   (StarCrumbExchangeKind: 0 unit, 1 item, 2 armament), the target, its period, the Welcome Back Portal that holds it
//   (comeback_gacha_id) and its rarity;
// - the price is `shop/star_crumb_exchange_cost` (assets/star_crumb_exchange_cost.json) by kind and rarity: units and
//   items 300 (4-star) or 600 (5-star), armaments 200 or 400; any other rarity is a client error;
// - an exchange is possible within its period (start and end inclusive), when the player has enough Star Slivers and
//   doesn't own the unit or armament yet (an item: while one more fits under the item's limit), else the client
//   doesn't offer it (StarCrumbExchangePossibility DuplicatesOrAlreadyMax, StarCrumbShortage);
// - an exchange with a Welcome Back Portal follows that portal's period for the player instead of its own: the
//   portal's `comeback_campaign` period, which only a returning player gets (src/lib/comebackGacha.ts, FT-62). So such
//   an exchange is open exactly while that portal is the player's open Welcome Back Portal (FT-65);
// - the reply is read only through the common response (user_info, character_list, equipment_list, item_list); result
//   code 3006 is the client's ExchangePeriodError, 2053 ShopPeriodError and 3010 ShopStepOverDay.
// There's no purchase count: owning the unit or armament is the limit.

import exchanges from "../../assets/star_crumb_exchange.json";
import exchangeCosts from "../../assets/star_crumb_exchange_cost.json";
import { getPlayerCharacterSync, getPlayerEquipmentSync, getPlayerItemSync } from "../data/wdfpData";
import { masterDate } from "../utils";
import { isContentPeriodOpen } from "./eventSchedule";
import { getItemMaxCountSync } from "./limits";
import { ComebackGachaPeriod } from "./comebackGacha";

export enum StarCrumbExchangeKind {
    CHARACTER = 0,
    ITEM = 1,
    EQUIPMENT = 2
}

export interface StarCrumbExchange {
    kind: StarCrumbExchangeKind
    targetId: number
    /** Japan time, as the master has them */
    startTime: string
    endTime: string
    comebackGachaId: number | null
    rarity: number
}

/** The client's result code for an exchange outside its period (ExchangePeriodError). */
export const EXCHANGE_OUT_OF_PERIOD = 3006

const table = exchanges as Record<string, StarCrumbExchange>
const costs = exchangeCosts as Record<string, { rarity4: number, rarity5: number }>

export function getStarCrumbExchange(exchangeId: number): StarCrumbExchange | null {
    return table[String(exchangeId)] ?? null
}

/** The exchange's price in Star Slivers, or null for a rarity the client has no price for. */
export function starCrumbExchangeCost(exchange: StarCrumbExchange): number | null {
    const cost = costs[String(exchange.kind)]
    if (cost === undefined) return null
    return exchange.rarity === 4 ? cost.rarity4 : exchange.rarity === 5 ? cost.rarity5 : null
}

/**
 * Whether the exchange is open at `date`: its own period, projected like the client's master (inclusive end); for a
 * Welcome Back exchange, the player's open Welcome Back Portal period (`comeback`, comebackGachaPeriodSync) when it is
 * that exchange's portal.
 */
export function isStarCrumbExchangeOpen(exchange: StarCrumbExchange, date: Date, comeback: ComebackGachaPeriod | null): boolean {
    if (exchange.comebackGachaId !== null) {
        return comeback !== null && comeback.gachaId === exchange.comebackGachaId
            && date.getTime() >= comeback.start.getTime() && date.getTime() <= comeback.end.getTime()
    }
    return isContentPeriodOpen(masterDate(exchange.startTime).getTime(), masterDate(exchange.endTime).getTime(), date)
}

/** Why the player can't take the exchange (besides its period and price), or null if they can. */
export function starCrumbExchangeRefusalSync(playerId: number, exchange: StarCrumbExchange): string | null {
    switch (exchange.kind) {
        case StarCrumbExchangeKind.CHARACTER:
            return getPlayerCharacterSync(playerId, exchange.targetId) === null ? null : "The unit is owned already."
        case StarCrumbExchangeKind.EQUIPMENT:
            return getPlayerEquipmentSync(playerId, exchange.targetId) === null ? null : "The armament is owned already."
        case StarCrumbExchangeKind.ITEM: {
            const max = getItemMaxCountSync(exchange.targetId)
            return max === null || (getPlayerItemSync(playerId, exchange.targetId) ?? 0) + 1 <= max ? null : "The item is at its limit."
        }
        default:
            return "Unknown exchange kind."
    }
}
