// Developer mode Off is a full restore: unlike an ordinary save import, it doesn't keep the mission claims and earned
// reward mail of the time it was on, and it puts the server-side records (mission progress, earned mail sources) back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { data, developerMode, exportSave, newPlayer, pendingMail, Player, post, setupMailTests, uploadSave } from "./mailHelpers";

setupMailTests()

async function sendReward(player: Player, number: number): Promise<number> {
    const { sendPlayerMailSync } = await import("../src/lib/mail")
    const { missionRewardMailReasonId } = await import("../src/lib/missions")
    return sendPlayerMailSync(player.playerId, { type: 8, number, reasonId: missionRewardMailReasonId, subject: "Reward", description: "Earned", durableReward: true })
}

test("developer mode Off restores the records from before and drops the rewards earned while on", async () => {
    const player = await newPlayer()
    const earnedBefore = await sendReward(player, 11)
    data.setPlayerMissionSync(player.playerId, 2, { missionId: 6, progress: 1, clearedStage: 0 })
    const records = data.getPlayerProgressRecordsSync(player.playerId)
    assert.ok(records.players_reward_mail_sources!.some(source => source.mail_id === earnedBefore))

    assert.equal((await developerMode(player, "on")).headers.location, `/player/${player.playerId}?message=dev-on`)
    const earnedMeanwhile = await sendReward(player, 22)
    data.setPlayerMissionSync(player.playerId, 2, { missionId: 6, progress: 9, clearedStage: 1 })
    data.setPlayerMissionSync(player.playerId, 2, { missionId: 7, progress: 3, clearedStage: 0 })

    assert.equal((await developerMode(player, "off")).headers.location, `/player/${player.playerId}?message=dev-off`)
    assert.deepEqual(data.getPlayerProgressRecordsSync(player.playerId), records)
    const pending = await pendingMail(player)
    assert.deepEqual(pending.map(mail => [mail.id, mail.number]), [[earnedBefore, 11]], "the earned mail keeps its ID")
    assert.ok(!pending.some(mail => mail.id === earnedMeanwhile))

    // its source is linked again: an ordinary import of an older save doesn't make it claimable twice
    const save = await exportSave(player)
    await post(player, "mail/receive", { mail_id: earnedBefore })
    assert.equal((await uploadSave(player.playerId, JSON.stringify(save))).headers.location, `/player/${player.playerId}?message=save-imported`)
    assert.deepEqual(await pendingMail(player), [])
})

test("a developer-mode backup without records drops the progress made since", async () => {
    const player = await newPlayer()
    assert.equal((await developerMode(player, "on")).headers.location, `/player/${player.playerId}?message=dev-on`)
    const { readFileSync, writeFileSync } = await import("fs")
    const path = await import("path")
    const file = path.join(process.env.DATABASE_DIR!, "developer-mode-backups", `${player.playerId}.json`)
    const { developer_mode_progress_records: _, ...backup } = JSON.parse(readFileSync(file, "utf-8"))
    writeFileSync(file, JSON.stringify(backup))
    await sendReward(player, 22)
    data.setPlayerMissionSync(player.playerId, 2, { missionId: 6, progress: 9, clearedStage: 1 })

    assert.equal((await developerMode(player, "off")).headers.location, `/player/${player.playerId}?message=dev-off`)
    const records = data.getPlayerProgressRecordsSync(player.playerId)
    assert.deepEqual(records.players_missions, [])
    assert.deepEqual(records.players_reward_mail_sources, [])
    assert.deepEqual(await pendingMail(player), [])
})
