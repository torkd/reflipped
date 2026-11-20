// FT-4: the gift box history (history/receive): what it lists, its order of receipt and its retention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { data, exportSave, gift, itemId, newPlayer, pendingMail, post, request, sendMail, setupMailTests, uploadSave } from "./mailHelpers";

setupMailTests()

test("history/receive lists the mail received in the last week, newest first, 100 per page", async (t) => {
    const player = await newPlayer()
    const history = async (page: number) => post(player, "history/receive", { page })
    const { setServerTime, getServerDate } = await import("../src/utils")
    /** received mails straight in the database, `count` of them one minute apart from `start` */
    const insertReceived = (count: number, start: Date) => data.runInTransactionSync(() => {
        for (let i = 0; i < count; i++) data.insertPlayerMailSync(player.playerId, {
            type: 8, typeId: null, number: i + 1, reasonId: 60, subject: null, description: null, createTime: getServerDate(), receiveTime: new Date(start.getTime() + i * 60_000), rewardLimitTime: null
        })
    })

    await t.test("an empty history", async () => {
        assert.deepEqual(await history(1), { total_count: 0, history: [] })
    })

    await t.test("waiting mail isn't in it; received mail is, in the captured format with Japan times", async () => {
        setServerTime(new Date("2025-01-03T12:00:00Z"))
        await sendMail(player, { type: "ITEM", typeId: itemId, number: 4 })
        await sendMail(player, { type: "FREE_VMONEY", number: 50 })
        assert.equal((await history(1)).total_count, 0)

        // received later than sent: the entry's time is the receive time, in Japan time (UTC+9)
        setServerTime(new Date("2025-01-03T13:30:00Z"))
        const [beads, item] = await pendingMail(player)
        await post(player, "mail/receive", { mail_id: item.id })
        setServerTime(new Date("2025-01-03T13:31:00Z"))
        await post(player, "mail/receive", { mail_id: beads.id })

        const page = await history(1)
        assert.equal(page.total_count, 2)
        assert.deepEqual(page.history, [
            { null: 1, reason_id: 0, type: 4, type_id: null, number: 50, subject: gift.subject, description: gift.description, create_time: "2025-01-03 22:31:00" },
            { null: 1, reason_id: 0, type: 1, type_id: itemId, number: 4, subject: gift.subject, description: gift.description, create_time: "2025-01-03 22:30:00" }
        ])
    })

    await t.test("pages hold 100; a page past the end is empty, a page below 1 is the first", async () => {
        setServerTime(new Date("2025-01-03T16:30:00Z"))
        insertReceived(148, new Date("2025-01-03T14:00:00Z"))
        const first = await history(1)
        assert.equal(first.total_count, 150)
        assert.equal(first.history.length, 100)
        assert.equal(first.history[0].number, 148, "the last received first")
        const second = await history(2)
        assert.equal(second.history.length, 50)
        assert.equal(second.history.at(-3).number, 1)
        assert.equal(second.history.at(-1).type, 1, "the first received last")
        assert.deepEqual(await history(3), { total_count: 150, history: [] })
        assert.deepEqual(await history(0), first)
        assert.deepEqual(await history(-5), first)
    })

    await t.test("mail received more than a week ago isn't listed or counted", async () => {
        // a week after the 148 were received (from 2025-01-03 14:00), only those of the last 7 days show
        setServerTime(new Date("2025-01-10T15:00:00Z"))
        const page = await history(1)
        assert.equal(page.total_count, 88, "those from 15:00 on 2025-01-03")
        assert.equal(page.history.length, 88)
        // still stored, and in a save
        assert.equal((await exportSave(player)).user_mail_list.filter((mail: any) => mail.receive_time !== null).length, 150)
    })

    await t.test("the history keeps the 500 mails received last", async () => {
        setServerTime(new Date("2025-01-10T00:00:00Z"))
        insertReceived(600, new Date("2025-01-09T00:00:00Z"))
        // 750 in the last week, but the history lists 500 at most, also before the next receive trims the rest
        assert.equal((await history(1)).total_count, 500)
        assert.equal(data.getPlayerMailHistoryCountSync(player.playerId), 750)
        // the next receive trims the oldest
        await sendMail(player, { type: "STAR_CRUMB", number: 3 })
        await post(player, "mail/receive", { mail_id: (await pendingMail(player))[0].id })
        const page = await history(1)
        assert.equal(page.total_count, 500)
        assert.equal(page.history[0].type, 7)
        assert.equal((await history(5)).history.length, 100)
        assert.deepEqual((await history(6)).history, [])
        assert.equal(data.getPlayerMailHistoryCountSync(player.playerId), 500)
        assert.equal((await exportSave(player)).user_mail_list.filter((mail: any) => mail.receive_time !== null).length, 500)
    })

    // the clock goes back at every calendar wrap, Reset or player clock change: the order of receipt decides, not the
    // receive dates
    const looped = await newPlayer()
    await t.test("after the clock went back, a new mail is kept and the history starts over", async () => {
        setServerTime(new Date("2025-01-28T12:00:00Z"))
        data.runInTransactionSync(() => {
            for (let i = 0; i < 500; i++) data.insertPlayerMailSync(looped.playerId, {
                type: 8, typeId: null, number: i + 1, reasonId: 60, subject: null, description: null, createTime: getServerDate(), receiveTime: new Date(Date.parse("2025-01-28T00:00:00Z") + i * 60_000), rewardLimitTime: null
            })
        })
        assert.equal((await post(looped, "history/receive", { page: 1 })).total_count, 500)

        // the calendar wraps (or the admin sets the time back)
        setServerTime(new Date("2025-01-03T12:00:00Z"))
        assert.deepEqual(await post(looped, "history/receive", { page: 1 }), { total_count: 0, history: [] }, "the last loop isn't \"the last week\"")
        await sendMail(looped, { type: "STAR_CRUMB", number: 3 })
        const id = (await pendingMail(looped))[0].id
        await post(looped, "mail/receive", { mail_id: id })
        assert.notEqual(data.getPlayerMailSync(looped.playerId, id), null, "the mail just received is kept")
        assert.equal(data.getPlayerMailHistoryCountSync(looped.playerId), 500)
        assert.equal(data.getPlayerMailSync(looped.playerId, id - 500), null, "the first one received went")
        const page = await post(looped, "history/receive", { page: 1 })
        assert.equal(page.total_count, 1)
        assert.equal(page.history[0].create_time, "2025-01-03 21:00:00")

        // on the same date in the next loop, the mail of the loop before doesn't come back
        setServerTime(new Date("2025-01-28T12:00:00Z"))
        assert.equal((await post(looped, "history/receive", { page: 1 })).total_count, 0)

        // a save holds the received mail in the order it was received
        const received = (await exportSave(looped)).user_mail_list.filter((mail: any) => mail.receive_time !== null)
        assert.equal(received.length, 500)
        assert.deepEqual([received[0].number, received[498].number, received[499].type], [2, 500, 7])
    })

    await t.test("a save import keeps the order mail was received in", async () => {
        setServerTime(new Date("2025-01-03T13:00:00Z"))
        const save = await exportSave(looped)
        const other = await newPlayer()
        assert.equal((await uploadSave(other.playerId, JSON.stringify(save))).headers.location, `/player/${other.playerId}?message=save-imported`)
        assert.deepEqual((await exportSave(other)).user_mail_list, save.user_mail_list)
        await sendMail(other, { type: "BOND_TOKEN", number: 1 })
        await post(other, "mail/receive", { mail_id: (await pendingMail(other))[0].id })
        // the trim drops the first received (dated 2025-01-28), not the star crumbs received last (dated 2025-01-03)
        const received = (await exportSave(other)).user_mail_list.filter((mail: any) => mail.receive_time !== null)
        assert.deepEqual([received.length, received[0].number, received[498].type, received[499].type], [500, 3, 7, 10])
        assert.deepEqual((await post(other, "history/receive", { page: 1 })).history.map((entry: any) => entry.type), [10, 7])
    })

    await t.test("the request needs a numeric page, and a sane one", async () => {
        const response = await request(player, "history/receive", { page: "first" })
        assert.equal(response.statusCode, 400)
        for (const page of [1e300, 1_000_001, 2.5]) assert.equal((await request(player, "history/receive", { page })).statusCode, 400, String(page))
        assert.equal((await request(player, "history/receive", { page: 1_000_000 })).statusCode, 200)
        // mail/index's page too: SQLite can't take the offset of such a page
        for (const current_page of [1e300, 1_000_001]) assert.equal((await request(player, "mail/index", { current_page, app_secret: "", app_admin: "" })).statusCode, 400, String(current_page))
        assert.equal((await request(player, "mail/index", { current_page: 1_000_000, app_secret: "", app_admin: "" })).statusCode, 200)
    })
})

test("the database update numbers the mail received before it by receive time", async () => {
    const Database = (await import("../src/data/sqlite")).default
    const { updateBeforeInit } = await import("../src/data/updaters/wdfpData")
    const database = new Database(":memory:")
    // players_mail as version 5 had it
    database.prepare(`CREATE TABLE players_mail (id INTEGER PRIMARY KEY AUTOINCREMENT, type INTEGER NOT NULL, type_id INTEGER, number INTEGER NOT NULL, reason_id INTEGER NOT NULL, subject TEXT, description TEXT, create_time DATE NOT NULL, receive_time DATE, reward_limit_time DATE, player_id INTEGER NOT NULL)`).run()
    const insert = database.prepare(`INSERT INTO players_mail (type, number, reason_id, create_time, receive_time, player_id) VALUES (8, 1, 0, '2025-01-01T00:00:00.000Z', ?, ?)`)
    for (const [receiveTime, playerId] of [["2025-01-05T00:00:00.000Z", 1], [null, 1], ["2025-01-04T00:00:00.000Z", 1], ["2025-01-04T00:00:00.000Z", 1], ["2025-01-02T00:00:00.000Z", 2]] as const)
        insert.run(receiveTime, playerId)
    updateBeforeInit(database, 5)
    assert.deepEqual(database.prepare(`SELECT id, receive_seq FROM players_mail ORDER BY id`).all(), [
        { id: 1, receive_seq: 3 }, { id: 2, receive_seq: null }, { id: 3, receive_seq: 1 }, { id: 4, receive_seq: 2 }, { id: 5, receive_seq: 1 }
    ])
    // run again (no version file): nothing changes
    updateBeforeInit(database, 5)
    assert.equal((database.prepare(`SELECT receive_seq FROM players_mail WHERE id = 1`).get() as any).receive_seq, 3)
    database.close()
})
