// FT-4: mail types 14 and 15, daily challenge points (challenge attempts) and periodic reward points (co-op reward counts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readCapturedRoute } from "./helpers";
import { admin, data, exportSave, newPlayer, pendingMail, Player, post, request, sendMail, sendToAll, setupMailTests, uploadSave } from "./mailHelpers";

setupMailTests()

test("mail types 14 and 15: daily challenge points and periodic reward points", async (t) => {
    const { setServerTime } = await import("../src/utils")
    const SOLO_BOSS = 1 // daily challenge point: max 9, the day starts with 2, open-ended
    const ENDED_POINT = 10008 // a new player's event attempts, ended 2024-07-25
    const COOP_REWARD = 10000000 // periodic reward point: max 99, +2 a day, open 2024-12-01 14:00 to 2024-12-17 20:59:59 JST
    const load = (player: Player) => post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    const challengePoint = async (player: Player, id: number) => (await load(player)).user_daily_challenge_point_list.find((entry: any) => entry.id === id)
    const rewardPoint = async (player: Player, id: number) => (await load(player)).user_periodic_reward_point_list.find((entry: any) => entry.id === id)?.point

    await t.test("sending checks the id, the type id rule and the cap", async () => {
        const player = await newPlayer()
        const refused: Record<string, unknown>[] = [
            { type: "DAILY_CHALLENGE_POINT", number: 1 }, // needs a type id
            { type: "DAILY_CHALLENGE_POINT", typeId: 999999, number: 1 },
            { type: "DAILY_CHALLENGE_POINT", typeId: SOLO_BOSS, number: 10 }, // max_challenge_point 9
            { type: "PERIODIC_REWARD_POINT", number: 1 },
            { type: "PERIODIC_REWARD_POINT", typeId: 4, number: 1 },
            { type: "PERIODIC_REWARD_POINT", typeId: COOP_REWARD, number: 100 } // max_reward_point 99
        ]
        for (const mail of refused) assert.equal((await sendMail(player, mail)).statusCode, 400, JSON.stringify(mail))
        assert.equal((await sendMail(player, { type: 14, typeId: SOLO_BOSS, number: 9 })).statusCode, 200)
        assert.equal((await sendMail(player, { type: "PERIODIC_REWARD_POINT", typeId: COOP_REWARD, number: 99 })).statusCode, 200)

        const [reward, challenge] = await pendingMail(player)
        assert.deepEqual([challenge.type, challenge.type_id, challenge.number], [14, SOLO_BOSS, 9])
        assert.deepEqual([reward.type, reward.type_id, reward.number], [15, COOP_REWARD, 99])
    })

    await t.test("the catalog lists them for the admin form", async () => {
        const catalog = (await admin.inject({ method: "GET", url: "/api/catalog" })).json()
        assert.equal(catalog.dailyChallengePoints.find((entry: any) => entry.id === SOLO_BOSS).name, "Solo Boss Challenge Attempts")
        assert.ok(catalog.periodicRewardPoints.some((entry: any) => entry.id === COOP_REWARD))
        const page = await admin.inject({ method: "GET", url: "/player" })
        assert.match(page.body, /<option value="DAILY_CHALLENGE_POINT">/)
        assert.match(page.body, /<option value="PERIODIC_REWARD_POINT">/)
    })

    await t.test("receiving adds to the point and the reply carries the changed entry", async () => {
        const player = await newPlayer()
        assert.equal((await challengePoint(player, SOLO_BOSS)).point, 2, "a new player starts the day with 2")
        await sendMail(player, { type: "DAILY_CHALLENGE_POINT", typeId: SOLO_BOSS, number: 3 })
        const reply = await post(player, "mail/receive", { mail_id: (await pendingMail(player))[0].id })
        assert.deepEqual(reply.user_daily_challenge_point_list, [{ id: SOLO_BOSS, point: 5, campaign_list: [{ campaign_id: 2023013101, additional_point: 2 }] }])
        assert.equal(reply.user_periodic_reward_point_list, undefined, "only what changed")
        assert.equal((await challengePoint(player, SOLO_BOSS)).point, 5)

        await sendMail(player, { type: "PERIODIC_REWARD_POINT", typeId: COOP_REWARD, number: 4 })
        await sendMail(player, { type: "PERIODIC_REWARD_POINT", typeId: 3, number: 1 })
        const all = await post(player, "mail/receive_all", { mail_ids: (await pendingMail(player)).map(mail => mail.id) })
        assert.deepEqual(all.user_periodic_reward_point_list.sort((a: any, b: any) => a.id - b.id), [{ id: 3, point: 3 }, { id: COOP_REWARD, point: 6 }])
        assert.equal(all.max_overed_mail_count, 0)
        assert.equal(await rewardPoint(player, COOP_REWARD), 6)
    })

    await t.test("a mail past the cap stays in the box and counts in max_overed_mail_count", async () => {
        const player = await newPlayer()
        data.setPlayerDailyChallengePointSync(player.playerId, SOLO_BOSS, 8)
        data.setPlayerPeriodicRewardPointSync(player.playerId, COOP_REWARD, 98)
        await sendMail(player, { type: "DAILY_CHALLENGE_POINT", typeId: SOLO_BOSS, number: 2 })
        await sendMail(player, { type: "PERIODIC_REWARD_POINT", typeId: COOP_REWARD, number: 2 })
        await sendMail(player, { type: "DAILY_CHALLENGE_POINT", typeId: SOLO_BOSS, number: 1 })
        const ids = (await pendingMail(player)).map(mail => mail.id)

        // receive all: the one that fits goes in first (newest first), then the other attempts mail no longer fits
        const all = await post(player, "mail/receive_all", { mail_ids: ids })
        assert.equal(all.max_overed_mail_count, 2)
        assert.deepEqual(all.user_daily_challenge_point_list.map((entry: any) => entry.point), [9])
        assert.equal((await pendingMail(player)).length, 2)
        assert.equal((await request(player, "mail/receive", { mail_id: (await pendingMail(player))[0].id })).statusCode, 400)
        assert.equal(await rewardPoint(player, COOP_REWARD), 98)

        // sending to everyone skips this player for attempts it can't take, and gives them to a player who can
        const other = await newPlayer()
        data.setPlayerDailyChallengePointSync(other.playerId, SOLO_BOSS, 0)
        const waiting = (await pendingMail(player)).length
        const toAll = await sendToAll({ type: "DAILY_CHALLENGE_POINT", typeId: SOLO_BOSS, number: 1 })
        assert.equal(toAll.statusCode, 200, toAll.body)
        assert.ok(toAll.json().skippedLimit >= 1)
        assert.equal((await pendingMail(player)).length, waiting, "at its cap: skipped")
        assert.deepEqual((await pendingMail(other)).map(mail => [mail.type, mail.type_id, mail.number]), [[14, SOLO_BOSS, 1]])
    })

    await t.test("an open campaign's extra attempts count towards the cap, as in the client", async () => {
        // campaign 2023013101 gives solo boss challenges 2 more from 2024-05-28 14:00 to 2024-07-25 14:59:59 Japan time
        setServerTime(new Date("2024-06-10T12:00:00Z"))
        const player = await newPlayer()
        data.setPlayerDailyChallengePointSync(player.playerId, SOLO_BOSS, 6)
        await sendMail(player, { type: "DAILY_CHALLENGE_POINT", typeId: SOLO_BOSS, number: 2 })
        const id = (await pendingMail(player))[0].id
        assert.equal((await post(player, "mail/receive_all", { mail_ids: [id] })).max_overed_mail_count, 1, "6 + 2 + 2 > 9")
        // after the campaign it fits
        setServerTime(new Date("2024-08-01T12:00:00Z"))
        assert.equal((await post(player, "mail/receive_all", { mail_ids: [id] })).max_overed_mail_count, 0)
        assert.equal((await challengePoint(player, SOLO_BOSS)).point, 8)
    })

    await t.test("the daily reset refills open points and leaves ended ones", async () => {
        setServerTime(new Date("2024-12-05T12:00:00Z"))
        const player = await newPlayer()
        // a new player's list has 2 (as captured), and the first load's reset adds the day's 2
        assert.equal(await rewardPoint(player, COOP_REWARD), 4)
        data.setPlayerPeriodicRewardPointSync(player.playerId, COOP_REWARD, 2)
        data.setPlayerDailyChallengePointSync(player.playerId, SOLO_BOSS, 0)
        data.setPlayerDailyChallengePointSync(player.playerId, 251, 7)
        data.setPlayerDailyChallengePointSync(player.playerId, ENDED_POINT, 0)

        // the same game day: nothing changes
        setServerTime(new Date("2024-12-05T19:59:00Z"))
        assert.equal((await challengePoint(player, SOLO_BOSS)).point, 0)

        // 20:00 UTC is 05:00 in Japan: a new game day
        setServerTime(new Date("2024-12-05T20:00:00Z"))
        assert.equal((await challengePoint(player, SOLO_BOSS)).point, 2, "back to the day's 2")
        assert.equal((await challengePoint(player, 251)).point, 7, "more than the day's amount is kept")
        assert.equal((await challengePoint(player, ENDED_POINT)).point, 0, "an ended event's attempts stay")
        assert.equal(await rewardPoint(player, COOP_REWARD), 4, "+2 a day")

        data.setPlayerPeriodicRewardPointSync(player.playerId, COOP_REWARD, 98)
        setServerTime(new Date("2024-12-07T12:00:00Z"))
        assert.equal(await rewardPoint(player, COOP_REWARD), 99, "up to max_reward_point")

        // after its period the reward count no longer grows
        setServerTime(new Date("2024-12-20T12:00:00Z"))
        data.setPlayerPeriodicRewardPointSync(player.playerId, COOP_REWARD, 5)
        await load(player)
        setServerTime(new Date("2024-12-21T12:00:00Z"))
        assert.equal(await rewardPoint(player, COOP_REWARD), 5)
    })

    await t.test("a point opening later in the game day is refilled at the day's first load", async () => {
        // the co-op reward count opens at 14:00 Japan time on 1 December, nine hours into that game day
        setServerTime(new Date("2024-11-30T12:00:00Z"))
        const player = await newPlayer()
        assert.equal(await rewardPoint(player, COOP_REWARD), 2, "not open yet: the new player's 2, no refill")
        // 06:00 in Japan on 1 December: the first load of the game day, before the point opens
        setServerTime(new Date("2024-11-30T21:00:00Z"))
        assert.equal(await rewardPoint(player, COOP_REWARD), 4)
        // later that day it isn't refilled again
        setServerTime(new Date("2024-12-01T06:00:00Z"))
        assert.equal(await rewardPoint(player, COOP_REWARD), 4)
    })

    await t.test("a point the player doesn't have yet is added at the reset", async () => {
        const player = await newPlayer()
        const { default: getDatabase, Database } = await import("../src/data/index")
        getDatabase(Database.WDFP_DATA).prepare(`DELETE FROM daily_challenge_point_list_entries WHERE player_id = ? AND id = 5001`).run(player.playerId)
        setServerTime(new Date("2025-01-04T12:00:00Z"))
        assert.deepEqual(await challengePoint(player, 5001), { id: 5001, point: 10, campaign_list: [] }, "Chrono Trial starts the day with 10")
    })

    await t.test("points are part of a save and survive a round trip", async () => {
        const player = await newPlayer()
        data.setPlayerDailyChallengePointSync(player.playerId, SOLO_BOSS, 7)
        await sendMail(player, { type: "DAILY_CHALLENGE_POINT", typeId: SOLO_BOSS, number: 1 })
        const save = await exportSave(player)
        assert.equal(save.user_daily_challenge_point_list.find((entry: any) => entry.id === SOLO_BOSS).point, 7)
        assert.equal(save.user_mail_list.at(-1).type, 14)
        data.setPlayerDailyChallengePointSync(player.playerId, SOLO_BOSS, 1)
        assert.equal((await uploadSave(player.playerId, JSON.stringify(save))).headers.location, `/player/${player.playerId}?message=save-imported`)
        assert.equal(data.getPlayerDailyChallengePointListSync(player.playerId).find(entry => entry.id === SOLO_BOSS)!.point, 7)
        assert.equal((await pendingMail(player))[0].type, 14)
        // a save with an attempts mail the game doesn't have is refused
        const bad = { ...save, user_mail_list: [{ ...save.user_mail_list.at(-1), type_id: 999999 }] }
        assert.equal((await uploadSave(player.playerId, JSON.stringify(bad))).headers.location, `/player/${player.playerId}?error=save-invalid`)
    })
})
