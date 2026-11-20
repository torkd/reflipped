// Portal star rates as on the original server: each portal draws by its master rarity table (`rankWeights`): 5 / 25 / 70
// per cent on regular and armament portals, 7.5 / 25 / 67.5 on festival ones. The guaranteed pull of a 10-pull folds the
// 3-star weight into 4 stars (5 / 95, festival 7.5 / 92.5), as the client's odds page shows it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestServer } from "./helpers";
import gachas from "../assets/gacha.json";
import type { Gacha } from "../src/lib/types";

const REGULAR = "1"      // Launch Gala Portal, normal_rarity
const FESTIVAL = "147"   // a festival portal, fes_rarity
const ARMAMENT = "5038"

let cleanup: () => Promise<void>
let lib: typeof import("../src/lib/gacha")

before(async () => {
    ({ cleanup } = await createTestServer())
    lib = await import("../src/lib/gacha")
})

after(async () => {
    await cleanup()
})

const portal = (id: string) => (gachas as unknown as Record<string, Gacha>)[id]

/** The share of each star rank (5, 4, 3) among the pulls. */
function shares(gacha: Gacha, pulls: number, guaranteed = false): number[] {
    const stars = new Map<number, number>()
    for (const key of ["1", "2", "3"]) for (const unit of gacha.pool[key] ?? []) stars.set(unit.id, 6 - Number(key))
    const counts = [0, 0, 0]
    for (const [id, count] of lib.drawGachaSync(gacha, pulls, guaranteed)) counts[5 - stars.get(id)!] += count
    return counts.map(count => count / pulls)
}

test("every portal carries its master star weights and has units for each rank it can give", () => {
    for (const [id, gacha] of Object.entries(gachas as unknown as Record<string, Gacha>)) {
        const weights = lib.gachaRankWeights(gacha, false)
        assert.ok(weights.reduce((a, b) => a + b, 0) > 0, `portal ${id}`)
        weights.forEach((weight, rank) => assert.ok(weight === 0 || (gacha.pool[String(rank + 1)] ?? []).length > 0, `portal ${id} rank ${rank + 1}`))
        assert.equal(gacha.guaranteeRarity, 4, `portal ${id}`)
    }
})

test("regular and armament portals weigh 5 / 25 / 70, festival ones 75 / 250 / 675; the guaranteed pull folds 3 stars into 4", () => {
    assert.deepEqual(lib.gachaRankWeights(portal(REGULAR), false), [5, 25, 70])
    assert.deepEqual(lib.gachaRankWeights(portal(REGULAR), true), [5, 95, 0])
    assert.deepEqual(lib.gachaRankWeights(portal(ARMAMENT), false), [5, 25, 70])
    assert.deepEqual(lib.gachaRankWeights(portal(FESTIVAL), false), [75, 250, 675])
    assert.deepEqual(lib.gachaRankWeights(portal(FESTIVAL), true), [75, 925, 0])
})

test("the weighted pick is exact: a weight of 0 is never picked, and all zero picks nothing", () => {
    for (let i = 0; i < 2000; i++) assert.notEqual(lib.randomWeightedIndex([1, 0, 3]), 1)
    assert.equal(lib.randomWeightedIndex([0, 0]), null)
    assert.equal(lib.randomWeightedIndex([0, 7]), 1)
})

test("draws land on the master rates (within 5 standard deviations)", () => {
    const pulls = 40000
    const near = (actual: number, expected: number, label: string) => {
        const deviation = 5 * Math.sqrt(expected * (1 - expected) / pulls)
        assert.ok(Math.abs(actual - expected) <= deviation, `${label}: ${actual} vs ${expected}`)
    }
    const regular = shares(portal(REGULAR), pulls)
    // a 40000-pull draw has 4000 guaranteed pulls, so the expected shares mix 9 normal pulls with 1 guaranteed
    near(regular[0], 0.05, "regular 5 stars")
    near(regular[1], 0.9 * 0.25 + 0.1 * 0.95, "regular 4 stars")
    const festival = shares(portal(FESTIVAL), pulls)
    near(festival[0], 0.075, "festival 5 stars")
    near(festival[1], 0.9 * 0.25 + 0.1 * 0.925, "festival 4 stars")
    const guaranteed = shares(portal(REGULAR), pulls, true)
    near(guaranteed[0], 0.05, "guaranteed 5 stars")
    assert.equal(guaranteed[2], 0, "a guaranteed pull is never 3 stars")
})

test("the 10th pull of every 10-pull is at least 4 stars; a single pull isn't guaranteed", () => {
    const gacha = portal(REGULAR)
    const threeStars = new Set((gacha.pool["3"] ?? []).map(unit => unit.id))
    for (let i = 0; i < 300; i++) {
        // in a 10-pull, the 9 normal pulls can all be 3 stars but the 10th can't: at most 9 three-star units
        const draw = lib.drawGachaSync(gacha, 10)
        const three = [...draw].reduce((sum, [id, count]) => sum + (threeStars.has(id) ? count : 0), 0)
        assert.ok(three <= 9)
    }
    let singleThree = 0
    for (let i = 0; i < 300; i++) if ([...lib.drawGachaSync(gacha, 1).keys()].some(id => threeStars.has(id))) singleThree++
    assert.ok(singleThree > 0, "single pulls give 3 stars")
})
