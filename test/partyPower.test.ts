// FT-63: the party power score suggested parties send, the client's own formula (src/lib/partyPower.ts). The expected
// numbers are worked out by hand from the master rows (assets/party_power.json) in each test's comments.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer } from "./helpers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let giveCharacter: typeof import("../src/lib/character").givePlayerCharacterSync
let giveEquipment: typeof import("../src/lib/equipment").givePlayerEquipmentSync
let partyPowerSync: typeof import("../src/lib/partyPower").partyPowerSync

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    giveCharacter = (await import("../src/lib/character")).givePlayerCharacterSync
    giveEquipment = (await import("../src/lib/equipment")).givePlayerEquipmentSync
    partyPowerSync = (await import("../src/lib/partyPower")).partyPowerSync
})

after(async () => {
    await cleanup()
})

async function newPlayerId(): Promise<number> {
    const player = await createTestPlayer(fastify)
    return data.getViewerPlayerIdSync(player.viewerId)!
}

const slot = (character: number | null, unisonCharacter: number | null = null, equipment: number | null = null, abilitySoul: number | null = null) =>
    ({ character, unisonCharacter, equipment, abilitySoul })

test("a level 1 unit alone", async () => {
    const playerId = await newPlayerId()
    giveCharacter(playerId, 111001)
    // 111001 at level 1: HP 53, ATK 11 -> int(53 * 0.2 + 11) = int(21.6) = 21
    assert.equal(partyPowerSync(playerId, [slot(111001), slot(null), slot(null)]), 21)
})

test("a full slot: level, over limit, evolution, EX boost, mana nodes, unison, armament and core", async () => {
    const playerId = await newPlayerId()
    giveCharacter(playerId, 111001)
    giveCharacter(playerId, 111002)
    // level 45 (rarity 5's threshold), two over limit steps, evolution 1, EX status 2 with abilities 1 and 11
    data.updatePlayerCharacterSync(playerId, 111001, {
        exp: 22793, overLimitStep: 2, evolutionLevel: 1, exBoost: { statusId: 2, abilityIdList: [1, 11] }
    })
    data.insertPlayerCharacterManaNodesSync(playerId, 111001, [1, 2, 3, 4, 5])
    giveEquipment(playerId, 1010001, 1)
    data.updatePlayerEquipmentSync(playerId, 1010001, { level: 3 })
    data.givePlayerItemSync(playerId, 100001, 1)
    // 111001 at level 45, between key levels 10 (532/112) and 80 (3192/672): ceil(1862) = 1862 HP, ceil(392) = 392 ATK;
    //   over limit 2 at 3 % a step (rarity 5): ceil(1862 * 1.06) = 1974, ceil(392 * 1.06) = 416;
    //   evolution 1 (rarity 5): +300 HP, +60 ATK; EX status 2: +200 HP, +40 ATK -> 2474 HP, 516 ATK;
    //   EX abilities 1 and 11: 50 + 35 = 85; 5 mana nodes
    // unison 111002 at level 1 (56/9): int(56 * 0.25) = 14 HP, int(9 * 0.25) = 2 ATK
    // armament 1010001 at level 3, between 1 (47/18) and 5 (70/26): ceil(58.5) = 59 HP, ceil(22) = 22 ATK
    // core 100001: rarity 5
    // HP 2474 + 14 + 59 = 2547, ATK 516 + 2 + 22 = 540
    // int(2547 * 0.2 + 540 + 5 * 10 + 85 + 5 * 10) = int(1234.4) = 1234
    assert.equal(partyPowerSync(playerId, [slot(111001, 111002, 1010001, 100001), slot(null), slot(null)]), 1234)
})

test("a 5★ uncapped unit with a built-up unison: rounding up, and the unison's quarter truncated", async () => {
    const playerId = await newPlayerId()
    giveCharacter(playerId, 111001)
    giveCharacter(playerId, 131026)
    // main 111001: level 83 (exp 187888), four over limit steps, evolution 1, EX status 1 with abilities 1 and 21
    data.updatePlayerCharacterSync(playerId, 111001, {
        exp: 187888, overLimitStep: 4, evolutionLevel: 1, exBoost: { statusId: 1, abilityIdList: [1, 21] }
    })
    data.insertPlayerCharacterManaNodesSync(playerId, 111001, Array.from({ length: 20 }, (_, index) => index + 1))
    // unison 131026: level 83, two over limit steps, evolution 1, EX status 4 with ability 11
    data.updatePlayerCharacterSync(playerId, 131026, {
        exp: 187888, overLimitStep: 2, evolutionLevel: 1, exBoost: { statusId: 4, abilityIdList: [11] }
    })
    data.insertPlayerCharacterManaNodesSync(playerId, 131026, [1, 2, 3])
    giveEquipment(playerId, 5010073, 1)
    data.updatePlayerEquipmentSync(playerId, 5010073, { level: 5, enhancementLevel: 99 })
    data.givePlayerItemSync(playerId, 100001, 1)
    // main: level 83 between 80 (3192/672) and 100 (3511/739), t = 0.15: ceil(3239.85) = 3240, ceil(682.05) = 683
    //   (rounding up, not to nearest); over limit 4 at 3 % a step: ceil(3628.8) = 3629, ceil(764.96) = 765;
    //   evolution +300/+60, EX status 1 +150/+50 -> 4079 HP, 875 ATK; EX abilities 50 + 15 = 65; 20 mana nodes
    // unison: level 83 between 80 (3360/618) and 100 (3696/680): ceil(3410.4) = 3411, ceil(627.3) = 628; over limit
    //   2: ceil(3615.66) = 3616, ceil(665.68) = 666; evolution +300/+60, EX status 4 +100/+40 -> 4016 HP, 766 ATK;
    //   a quarter: 1004 HP, int(191.5) = 191 ATK (truncated, not rounded); EX ability 11: 35; 3 mana nodes
    // armament 5010073 at level 5 (595/201) with augment level 99 (50/10): 645/211; core 100001: rarity 5
    // HP 4079 + 1004 + 645 = 5728, ATK 875 + 191 + 211 = 1277
    // int(5728 * 0.2 + 1277 + 23 * 10 + 100 + 5 * 10) = int(2802.6) = 2802
    assert.equal(partyPowerSync(playerId, [slot(111001, 131026, 5010073, 100001), slot(null), slot(null)]), 2802)
})

test("an augmented armament adds its augment status", async () => {
    const playerId = await newPlayerId()
    giveCharacter(playerId, 111001)
    giveEquipment(playerId, 5010073, 1)
    data.updatePlayerEquipmentSync(playerId, 5010073, { level: 5 })
    // 111001 at level 1: 53/11; 5010073 at level 5: 595/201
    // augment level 0 adds nothing: int(648 * 0.2 + 212) = int(341.6) = 341
    assert.equal(partyPowerSync(playerId, [slot(111001, null, 5010073)]), 341)
    // augment level 99 adds 50/10: int(698 * 0.2 + 222) = int(361.6) = 361
    data.updatePlayerEquipmentSync(playerId, 5010073, { enhancementLevel: 99 })
    assert.equal(partyPowerSync(playerId, [slot(111001, null, 5010073)]), 361)
})

test("empty slots and what the player doesn't have count for nothing", async () => {
    const playerId = await newPlayerId()
    assert.equal(partyPowerSync(playerId, [slot(null), slot(null), slot(null)]), 0)
    // a main unit the player doesn't have leaves its whole slot out, as the client skips a slot without a main unit
    giveCharacter(playerId, 111002)
    assert.equal(partyPowerSync(playerId, [slot(111001, 111002, 1010001, 100001)]), 0)
    // an unowned unison, armament or core adds nothing to an owned main unit (111002 at level 1: int(56 * 0.2 + 9) = 20)
    assert.equal(partyPowerSync(playerId, [slot(111002, 111001, 1010001, 100001)]), 20)
})
