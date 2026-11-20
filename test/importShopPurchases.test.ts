// FT-22: shop purchase counts aren't in a save (the original's /load has none; the client reads them from
// shop/get_sales_list), so a save import keeps the player's own, and developer mode Off puts back the backup's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { data, developerMode, exportSave, newPlayer, Player, post, request, setupMailTests, uploadSave } from "./mailHelpers";

setupMailTests()

// general shop products sold once ever, for 50 bond tokens, on sale since 2017 and 2022 (assets/general_shop.json)
const GENERAL = 8 // ShopType.GENERAL
const ONCE = 100001
const ONCE_TOO = 100003

async function buy(player: Player, shopItemId: number) {
    return (await request(player, "shop/buy", { shop_type: GENERAL, shop_item_id: shopItemId, number: 1 })).statusCode
}

async function boughtTotal(player: Player, shopItemId: number): Promise<number> {
    const { sales_list } = await post(player, "shop/get_sales_list", { shop_types: [GENERAL], boss_coin_shop_category_ids: [], event_list: [] })
    return sales_list.find((entry: { shop_item_id: number }) => entry.shop_item_id === shopItemId).total_purchase_num
}

function rich(player: Player) {
    data.updatePlayerSync({ id: player.playerId, bondToken: 10_000 })
}

test("the products are general shop products sold once", async () => {
    const { ShopType } = await import("../src/lib/types")
    const { getShopItemSync } = await import("../src/lib/assets")
    assert.equal(GENERAL, ShopType.GENERAL)
    for (const id of [ONCE, ONCE_TOO]) assert.equal(getShopItemSync(ShopType.GENERAL, id)?.maxFrequency, 1)
})

test("a save import keeps the purchase counts: a product sold once stays bought", async () => {
    const player = await newPlayer()
    rich(player)
    const save = await exportSave(player)
    assert.equal(await buy(player, ONCE), 200)
    assert.equal(await buy(player, ONCE), 400, "sold once")

    // the save from before the purchase doesn't reopen it
    assert.equal((await uploadSave(player.playerId, JSON.stringify(save))).headers.location, `/player/${player.playerId}?message=save-imported`)
    rich(player)
    assert.equal(await boughtTotal(player, ONCE), 1)
    assert.equal(await buy(player, ONCE), 400)
    assert.equal(await boughtTotal(player, ONCE_TOO), 0)
    assert.equal(await buy(player, ONCE_TOO), 200, "other products are unaffected")
})

test("developer mode Off puts back the counts from before it was turned on", async () => {
    const player = await newPlayer()
    rich(player)
    assert.equal(await buy(player, ONCE), 200)

    assert.equal((await developerMode(player, "on")).headers.location, `/player/${player.playerId}?message=dev-on`)
    rich(player)
    assert.equal(await buy(player, ONCE_TOO), 200)

    assert.equal((await developerMode(player, "off")).headers.location, `/player/${player.playerId}?message=dev-off`)
    assert.equal(await boughtTotal(player, ONCE), 1, "bought before: still bought")
    assert.equal(await boughtTotal(player, ONCE_TOO), 0, "bought while on: undone with the rest")
})

test("kept day and month counts still start over on a new game day", async () => {
    const player = await newPlayer()
    const { getServerDate, setServerTime } = await import("../src/utils")
    const { gameDay } = await import("../src/lib/shopLimits")
    const now = getServerDate()
    const { day, month } = gameDay(now)
    data.setPlayerShopPurchasesSync(player.playerId, GENERAL, ONCE, { total: 3, day, dayCount: 2, month, monthCount: 2 })

    assert.equal((await uploadSave(player.playerId, JSON.stringify(await exportSave(player)))).headers.location, `/player/${player.playerId}?message=save-imported`)
    assert.deepEqual(data.getPlayerShopPurchasesSync(player.playerId, GENERAL, ONCE), { total: 3, day, dayCount: 2, month, monthCount: 2 })

    setServerTime(new Date(now.getTime() + 40 * 24 * 60 * 60 * 1000))
    const { currentPurchases } = await import("../src/lib/shopLimits")
    const later = currentPurchases(player.playerId, GENERAL, ONCE, getServerDate())
    assert.deepEqual([later.total, later.dayCount, later.monthCount], [3, 0, 0])
})

test("a developer-mode backup from before the counts were kept leaves the player's own", async () => {
    const player = await newPlayer()
    rich(player)
    assert.equal((await developerMode(player, "on")).headers.location, `/player/${player.playerId}?message=dev-on`)
    const { readFileSync, writeFileSync } = await import("fs")
    const path = await import("path")
    const file = path.join(process.env.DATABASE_DIR!, "developer-mode-backups", `${player.playerId}.json`)
    const backup = JSON.parse(readFileSync(file, "utf-8"))
    delete backup.developer_mode_progress_records.players_shop_purchases
    writeFileSync(file, JSON.stringify(backup))
    rich(player)
    assert.equal(await buy(player, ONCE), 200)

    assert.equal((await developerMode(player, "off")).headers.location, `/player/${player.playerId}?message=dev-off`)
    assert.equal(await boughtTotal(player, ONCE), 1)
})
