// A server that never saved its reward management starts Automatic; REWARD_MANAGEMENT picks another default, and
// whatever an admin saved wins over both.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestServer } from "./helpers";

let cleanup: () => Promise<void>
let policy: typeof import("../src/lib/rewardPolicy")
const saved = process.env.REWARD_MANAGEMENT

before(async () => {
    ({ cleanup } = await createTestServer())   // the helper saves Managed, as the other tests expect
    policy = await import("../src/lib/rewardPolicy")
    const { setStoredTexts } = await import("../src/data/serverSettings")
    setStoredTexts([["rewards.management", null]])
})
after(async () => {
    if (saved === undefined) delete process.env.REWARD_MANAGEMENT; else process.env.REWARD_MANAGEMENT = saved
    await cleanup?.()
})

test("nothing saved: Automatic by default, Managed when the environment says so", () => {
    delete process.env.REWARD_MANAGEMENT
    assert.equal(policy.getRewardPolicy().management, "automatic")
    assert.equal(policy.getRewardPolicy().multiplierOverride, null)
    process.env.REWARD_MANAGEMENT = "managed"
    assert.equal(policy.getRewardPolicy().management, "managed")
    process.env.REWARD_MANAGEMENT = "nonsense"
    assert.equal(policy.getRewardPolicy().management, "automatic")
})

test("a saved choice wins over the default", () => {
    delete process.env.REWARD_MANAGEMENT
    assert.deepEqual(policy.setRewardPolicy({ management: "managed" }), [])
    assert.equal(policy.getRewardPolicy().management, "managed")
    process.env.REWARD_MANAGEMENT = "automatic"
    assert.equal(policy.getRewardPolicy().management, "managed")
    assert.deepEqual(policy.setRewardPolicy({ management: "automatic" }), [])
    process.env.REWARD_MANAGEMENT = "managed"
    assert.equal(policy.getRewardPolicy().management, "automatic")
})
