// FT-4: the gift box (waiting and received mail) and the titles in save export and import, and in developer mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readCapturedRoute } from "./helpers";
import { admin, data, degreeId, developerMode, exportSave, gift, itemId, newPlayer, pendingMail, Player, post, sendMail, sendToAll, setupMailTests, uploadSave } from "./mailHelpers";

setupMailTests()

test("the gift box and titles in save export and import", async (t) => {
    const player = await newPlayer()

    await t.test("an export holds waiting and received mail and the titles", async () => {
        assert.equal((await sendMail(player, { type: "FREE_MANA", number: 500 })).statusCode, 200)
        assert.equal((await sendMail(player, { type: "ITEM", typeId: itemId, number: 3, rewardLimitTime: "2030-01-01T00:00Z" })).statusCode, 200)
        assert.equal((await sendMail(player, { type: "DEGREE", typeId: degreeId, number: 1 })).statusCode, 200)
        const titleMail = (await pendingMail(player)).find(mail => mail.type === 13)
        await post(player, "mail/receive", { mail_id: titleMail.id })

        const save = await exportSave(player)
        assert.deepEqual(save.user_degree_list, [degreeId])
        assert.equal(save.user_mail_list.length, 3)
        const [mana, item, title] = save.user_mail_list
        assert.deepEqual(mana, { type: 8, type_id: null, number: 500, reason_id: 0, subject: gift.subject, description: gift.description, create_time: mana.create_time, receive_time: null, reward_limit_time: null })
        assert.match(mana.create_time, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
        assert.equal(item.reward_limit_time, "2030-01-01 00:00:00")
        assert.match(title.receive_time, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
        assert.equal("id" in mana, false, "mail ids aren't saved")

        // the game's /load doesn't get them
        const load = await post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
        assert.equal(load.user_mail_list, undefined)
        assert.equal(load.user_degree_list, undefined)
    })

    await t.test("an import restores them in place of the current ones", async () => {
        const save = await exportSave(player)
        // after the export: a new mail and the mana mail received
        await sendMail(player, { type: "STAR_CRUMB", number: 10 })
        const mana = (await pendingMail(player)).find(mail => mail.type === 8)
        await post(player, "mail/receive", { mail_id: mana.id })

        const response = await uploadSave(player.playerId, JSON.stringify(save))
        assert.equal(response.headers.location, `/player/${player.playerId}?message=save-imported`)
        const pending = await pendingMail(player)
        assert.deepEqual(pending.map(mail => mail.type).sort(), [1, 8], "the save's waiting mail, not the newer one")
        assert.deepEqual((await post(player, "profile/get_degree_list", {})).degree_ids, [1, degreeId])
        assert.deepEqual((await exportSave(player)).user_mail_list, save.user_mail_list, "the round trip keeps every field")
    })

    await t.test("an import into another player gives them the gift box and titles", async () => {
        const other = await newPlayer()
        const save = await exportSave(player)
        assert.equal((await uploadSave(other.playerId, JSON.stringify(save))).headers.location, `/player/${other.playerId}?message=save-imported`)
        assert.deepEqual((await exportSave(other)).user_mail_list, save.user_mail_list)
        assert.deepEqual((await post(other, "profile/get_degree_list", {})).degree_ids, [1, degreeId])
        // the first player's mail is untouched (mail ids are new, not taken over)
        assert.equal((await pendingMail(player)).length, 2)
    })

    await t.test("a save without the new fields keeps the player's current mail and titles", async () => {
        const save = await exportSave(player)
        const { user_mail_list, user_degree_list, ...oldSave } = save
        const before = await pendingMail(player)
        await sendMail(player, { type: "BOND_TOKEN", number: 5 })
        const current = await pendingMail(player)

        assert.equal((await uploadSave(player.playerId, JSON.stringify({ ...oldSave, user_info: { ...oldSave.user_info, name: "Old save" } }))).headers.location, `/player/${player.playerId}?message=save-imported`)
        assert.equal(data.getPlayerSync(player.playerId)!.name, "Old save")
        assert.deepEqual(await pendingMail(player), current, "the same mails with the same ids")
        assert.equal(current.length, before.length + 1)
        assert.deepEqual((await post(player, "profile/get_degree_list", {})).degree_ids, [1, degreeId])
        // the received history is kept too
        assert.deepEqual((await exportSave(player)).user_mail_list.filter((mail: any) => mail.receive_time !== null), user_mail_list.filter((mail: any) => mail.receive_time !== null))
    })

    await t.test("an empty list in a save does clear the gift box and titles", async () => {
        const other = await newPlayer()
        await sendMail(other, { type: "DEGREE", typeId: degreeId, number: 1 })
        await post(other, "mail/receive", { mail_id: (await pendingMail(other))[0].id })
        await sendMail(other, { type: "FREE_MANA", number: 1 })
        const save = await exportSave(other)
        assert.equal((await uploadSave(other.playerId, JSON.stringify({ ...save, user_mail_list: [], user_degree_list: [] }))).headers.location, `/player/${other.playerId}?message=save-imported`)
        assert.deepEqual(await pendingMail(other), [])
        assert.deepEqual((await post(other, "profile/get_degree_list", {})).degree_ids, [1])
    })

    await t.test("invalid mail or titles in a save are refused and nothing changes", async () => {
        const save = await exportSave(player)
        const mail = save.user_mail_list[0]
        const before = await pendingMail(player)
        const many = (count: number, received: boolean) => Array.from({ length: count }, () => ({ ...mail, type: 8, type_id: null, number: 1, receive_time: received ? "2025-01-01 00:00:00" : null }))
        const bad: Record<string, unknown>[] = [
            { user_mail_list: [{ ...mail, type: 2 }] }, // a type the client doesn't have
            { user_mail_list: [{ ...mail, type: 1, type_id: 999999 }] }, // no such item
            { user_mail_list: [{ ...mail, type: 1, type_id: null }] }, // item without type id
            { user_mail_list: [{ ...mail, type: 8, type_id: 5 }] }, // currency with type id
            { user_mail_list: [{ ...mail, type: 5, type_id: 700001, number: 1 }] }, // not a playable unit
            { user_mail_list: [{ ...mail, type: 4, type_id: null, number: 1_000_000 }] }, // past the bead limit
            { user_mail_list: [{ ...mail, type: 8, type_id: null, number: 0 }] },
            { user_mail_list: [{ ...mail, subject: "x".repeat(101) }] },
            { user_mail_list: [{ ...mail, subject: "" }] },
            { user_mail_list: [{ ...mail, description: "bell\u0007" }] },
            { user_mail_list: [{ ...mail, create_time: "2025-13-01 00:00:00" }] },
            { user_mail_list: [{ ...mail, create_time: "1969-12-31 23:59:59" }] }, // before any clock the server has
            { user_mail_list: [{ ...mail, receive_time: "2025-02-30 00:00:00" }] },
            { user_mail_list: [{ ...mail, receive_time: "yesterday" }] },
            { user_mail_list: [{ ...mail, extra: 1 }] },
            { user_mail_list: [{ ...mail, number: undefined }] },
            { user_mail_list: many(1001, false) }, // more waiting than a gift box holds
            { user_mail_list: many(501, true) }, // more received than the history keeps
            { user_mail_list: "nope" },
            { user_degree_list: [999999] }, // no such title
            { user_degree_list: [degreeId, degreeId] },
            { user_degree_list: [-1] },
            { user_info: { ...save.user_info, degree_id: 999999 } } // a selected title the game doesn't have
        ]
        for (const change of bad) {
            const response = await uploadSave(player.playerId, JSON.stringify({ ...save, ...change }))
            assert.equal(response.headers.location, `/player/${player.playerId}?error=save-invalid`, JSON.stringify(change).slice(0, 200))
        }
        assert.deepEqual(await pendingMail(player), before)
    })

    await t.test("a save may list the default title and an expired or long-received mail", async () => {
        const save = await exportSave(player)
        const mail = save.user_mail_list[0]
        const extra = [
            { ...mail, type: 8, type_id: null, reward_limit_time: "2024-01-01 00:00:00", receive_time: null },
            { ...mail, type: 8, type_id: null, subject: null, description: null, receive_time: "2020-01-01 00:00:00" }
        ]
        const response = await uploadSave(player.playerId, JSON.stringify({ ...save, user_mail_list: [...save.user_mail_list, ...extra], user_degree_list: [1, degreeId] }))
        assert.equal(response.headers.location, `/player/${player.playerId}?message=save-imported`)
        assert.deepEqual(data.getPlayerDegreesSync(player.playerId), [degreeId], "title 1 isn't stored")
    })

    await t.test("developer mode off restores the gift box and titles from before", async () => {
        const dev = await newPlayer()
        await sendMail(dev, { type: "FREE_MANA", number: 42 })
        await sendMail(dev, { type: "DEGREE", typeId: degreeId, number: 1 })
        await post(dev, "mail/receive", { mail_id: (await pendingMail(dev)).find(mail => mail.type === 13).id })
        const before = (await exportSave(dev)).user_mail_list

        assert.equal((await developerMode(dev, "on")).headers.location, `/player/${dev.playerId}?message=dev-on`)
        // while unlocked: the mana mail is received, a mission reward arrives, and the admin sends two mails (one to
        // everyone), one of which is received
        await post(dev, "mail/receive", { mail_id: (await pendingMail(dev)).find(mail => mail.type === 8).id })
        const { missionRewardMailReasonId } = await import("../src/lib/missions")
        data.insertPlayerMailSync(dev.playerId, { type: 7, typeId: null, number: 99, reasonId: missionRewardMailReasonId, subject: null, description: null, createTime: new Date("2025-01-03T12:00:00Z"), receiveTime: null, rewardLimitTime: null })
        await sendMail(dev, { type: "STAR_CRUMB", number: 1 })
        assert.equal((await sendToAll({ type: "BOND_TOKEN", number: 3 })).statusCode, 200)
        await sendMail(dev, { type: "FREE_MANA", number: 5 })
        await post(dev, "mail/receive", { mail_id: (await pendingMail(dev)).find(mail => mail.number === 5).id })

        assert.equal((await developerMode(dev, "off")).headers.location, `/player/${dev.playerId}?message=dev-off`)
        // the progress from before, plus the admin mail still waiting; the mission reward and the receipt are dropped
        const after = (await exportSave(dev)).user_mail_list
        const waiting = (list: any[]) => list.filter(mail => mail.receive_time === null)
        const received = (list: any[]) => list.filter(mail => mail.receive_time !== null)
        assert.deepEqual(received(after), received(before))
        assert.deepEqual(waiting(after).slice(0, waiting(before).length), waiting(before))
        assert.deepEqual(waiting(after).slice(waiting(before).length).map((mail: any) => [mail.type, mail.number]), [[7, 1], [10, 3]])
        assert.deepEqual((await pendingMail(dev)).map(mail => mail.number), [3, 1, 42])
        assert.deepEqual((await post(dev, "profile/get_degree_list", {})).degree_ids, [1, degreeId])
    })

    await t.test("the save and the developer-mode backup judge expiry on the player's clock", async () => {
        const { setPlayerClockSync } = await import("../src/lib/playerClock")
        const traveller = await newPlayer()
        setPlayerClockSync(traveller.playerId, new Date("2024-12-20T00:00:00Z"))
        try {
            // dated 2024-12-20 on the player's clock; expired on the server clock (2025-01-03), not on the player's
            assert.equal((await sendMail(traveller, { type: "FREE_MANA", number: 5, rewardLimitTime: "2024-12-25T00:00Z" })).statusCode, 200)
            const save = await exportSave(traveller)
            assert.deepEqual(save.user_mail_list.map((mail: any) => mail.reward_limit_time), ["2024-12-25 00:00:00"])
            assert.equal((await developerMode(traveller, "on")).headers.location, `/player/${traveller.playerId}?message=dev-on`)
            const { readFileSync } = await import("fs")
            const path = await import("path")
            const backup = JSON.parse(readFileSync(path.join(process.env.DATABASE_DIR!, "developer-mode-backups", `${traveller.playerId}.json`), "utf-8"))
            assert.deepEqual(backup.user_mail_list.map((mail: any) => mail.reward_limit_time), ["2024-12-25 00:00:00"])
            assert.equal((await developerMode(traveller, "off")).headers.location, `/player/${traveller.playerId}?message=dev-off`)
        } finally {
            setPlayerClockSync(traveller.playerId, null)
        }
    })

    await t.test("a save holds at most a full gift box, so the player's own export always imports", async () => {
        const { mailLimits } = await import("../src/lib/limits")
        const { setPlayerClockSync } = await import("../src/lib/playerClock")
        const box = await newPlayer()
        // a full box that expired on 2025-01-02, and a full box sent after: more than 1000 receivable once the
        // player's clock goes back before that expiry
        const insert = (count: number, rewardLimitTime: Date | null) => data.runInTransactionSync(() => {
            for (let i = 0; i < count; i++) data.insertPlayerMailSync(box.playerId, {
                type: 8, typeId: null, number: 1, reasonId: 0, subject: "Filler", description: "", createTime: new Date("2024-12-01T00:00:00Z"), receiveTime: null, rewardLimitTime
            })
        })
        insert(mailLimits.pendingMails, new Date("2025-01-02T00:00:00Z"))
        insert(mailLimits.pendingMails, null)
        setPlayerClockSync(box.playerId, new Date("2024-12-20T00:00:00Z"))
        try {
            const save = await exportSave(box)
            const pending = save.user_mail_list.filter((mail: any) => mail.receive_time === null)
            assert.equal(pending.length, mailLimits.pendingMails)
            assert.ok(pending.every((mail: any) => mail.reward_limit_time === null), "the newest")
            assert.equal((await uploadSave(box.playerId, JSON.stringify(save))).headers.location, `/player/${box.playerId}?message=save-imported`)
        } finally {
            setPlayerClockSync(box.playerId, null)
        }
    })

    await t.test("a developer-mode backup from before this change keeps the current mail and titles", async () => {
        const dev = await newPlayer()
        await developerMode(dev, "on")
        // a backup written by the old code has neither field
        const { readFileSync, writeFileSync } = await import("fs")
        const path = await import("path")
        const file = path.join(process.env.DATABASE_DIR!, "developer-mode-backups", `${dev.playerId}.json`)
        const { user_mail_list, user_degree_list, ...oldBackup } = JSON.parse(readFileSync(file, "utf-8"))
        writeFileSync(file, JSON.stringify(oldBackup))

        await sendMail(dev, { type: "DEGREE", typeId: degreeId, number: 1 })
        await post(dev, "mail/receive", { mail_id: (await pendingMail(dev))[0].id })
        await sendMail(dev, { type: "FREE_MANA", number: 7 })
        // everything stays, mission rewards and titles earned while unlocked included: the old backup can't tell them apart
        const current = await pendingMail(dev)
        const titles = (await post(dev, "profile/get_degree_list", {})).degree_ids
        assert.ok(current.some(mail => mail.number === 7))
        assert.ok(titles.includes(degreeId))
        assert.equal((await developerMode(dev, "off")).headers.location, `/player/${dev.playerId}?message=dev-off`)
        assert.deepEqual(await pendingMail(dev), current)
        assert.deepEqual((await post(dev, "profile/get_degree_list", {})).degree_ids, titles)
    })
})

test("a player's own export imports whatever date their clock or the server's was on", async (t) => {
    const { setPlayerClockSync, MAX_CLOCK_OFFSET_DAYS } = await import("../src/lib/playerClock")
    const { setServerTime } = await import("../src/utils")
    const roundTrip = async (player: Player) => {
        const save = await exportSave(player)
        assert.equal((await uploadSave(player.playerId, JSON.stringify(save))).headers.location, `/player/${player.playerId}?message=save-imported`)
        return save
    }

    await t.test("a player clock as far back as it goes, behind a server clock in 2000", async () => {
        const player = await newPlayer()
        setServerTime(new Date("2000-01-01T00:00:00Z"))
        setPlayerClockSync(player.playerId, new Date(Date.parse("2000-01-01T00:00:00Z") - MAX_CLOCK_OFFSET_DAYS * 24 * 60 * 60 * 1000))
        try {
            assert.equal((await sendMail(player, { type: "FREE_MANA", number: 1 })).statusCode, 200)
            const save = await roundTrip(player)
            assert.match(save.user_mail_list[0].create_time, /^1972-/)
        } finally {
            setPlayerClockSync(player.playerId, null)
        }
    })

    await t.test("a server clock running on past 2100", async () => {
        const player = await newPlayer()
        setServerTime(new Date("2101-01-05T12:00:00Z"))
        assert.equal((await sendMail(player, { type: "FREE_MANA", number: 1 })).statusCode, 200)
        await post(player, "mail/receive", { mail_id: (await pendingMail(player))[0].id })
        await sendMail(player, { type: "FREE_MANA", number: 2 })
        assert.deepEqual((await roundTrip(player)).user_mail_list.map((mail: any) => mail.create_time.slice(0, 4)), ["2101", "2101"])
    })

    await t.test("the server clock can't be set outside 2000 to 2100, nor a player's clock further than it goes", async () => {
        const player = await newPlayer()
        for (const time of ["1999-12-31T23:59", "2101-01-01T00:00", "0001-01-01T00:00"]) {
            const response = await admin.inject({ method: "POST", url: "/api/server/time", payload: { time, force: "1" } })
            assert.equal(response.statusCode, 400, time)
            assert.match(response.json().message, /from 2000 to 2100/)
        }
        const tooFar = new Date(Date.parse("2025-01-03T12:00:00Z") - (MAX_CLOCK_OFFSET_DAYS + 1) * 24 * 60 * 60 * 1000)
        assert.throws(() => setPlayerClockSync(player.playerId, tooFar), RangeError)
    })
})

test("received mail that today's checks refuse is left out of an import, not the reason to refuse it", async () => {
    const player = await newPlayer()
    await sendMail(player, { type: "FREE_MANA", number: 1 })
    await post(player, "mail/receive", { mail_id: (await pendingMail(player))[0].id })
    await sendMail(player, { type: "FREE_MANA", number: 2 })
    const save = await exportSave(player)
    const [waiting, received] = save.user_mail_list
    // history an older build may have stored: past today's cap, a unit that is no longer playable, an empty subject
    const old = [
        { ...received, type: 4, number: 1_000_000 },
        { ...received, type: 5, type_id: 700001, number: 1 },
        { ...received, subject: "" }
    ]
    const response = await uploadSave(player.playerId, JSON.stringify({ ...save, user_mail_list: [waiting, ...old, received] }))
    assert.equal(response.headers.location, `/player/${player.playerId}?message=save-imported`)
    assert.deepEqual((await exportSave(player)).user_mail_list, [waiting, received])
    // waiting mail like that is still refused: it could be received
    const refused = await uploadSave(player.playerId, JSON.stringify({ ...save, user_mail_list: [{ ...waiting, number: 1_000_000_000 }] }))
    assert.equal(refused.headers.location, `/player/${player.playerId}?error=save-invalid`)
})

test("mail dated after the player's now comes in at their now, so the history before it still shows", async () => {
    const { setServerTime } = await import("../src/utils")
    const player = await newPlayer()
    setServerTime(new Date("2025-01-03T12:00:00Z"))
    await sendMail(player, { type: "FREE_MANA", number: 1 })
    const save = await exportSave(player)
    const mail = save.user_mail_list[0]
    const list = [
        { ...mail, number: 1, receive_time: "2025-01-02 00:00:00" },
        // received last, dated in the future (a save made on a clock ahead of this one)
        { ...mail, number: 2, create_time: "2030-01-01 00:00:00", receive_time: "2030-01-01 00:00:00" }
    ]
    assert.equal((await uploadSave(player.playerId, JSON.stringify({ ...save, user_mail_list: list }))).headers.location, `/player/${player.playerId}?message=save-imported`)
    assert.deepEqual((await exportSave(player)).user_mail_list.map((entry: any) => entry.receive_time), ["2025-01-02 00:00:00", "2025-01-03 12:00:00"])
    await sendMail(player, { type: "FREE_MANA", number: 3 })
    await post(player, "mail/receive", { mail_id: (await pendingMail(player))[0].id })
    const history = await post(player, "history/receive", { page: 1 })
    assert.deepEqual(history.history.map((entry: any) => entry.number), [3, 2, 1])
})
