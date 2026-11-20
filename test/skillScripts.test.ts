// FT-74: skills' battle scripts before a balance change. AMF3 decodes and encodes byte for byte, a patch applies its
// edits to the pinned source only, and the schedule overlay ships the patched script while its change is pending.
// Synthetic scripts only; no game data.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { deflateRawSync, inflateRawSync } from "zlib";
import { Amf3Double, Amf3Object, Amf3Value, decodeAmf3, encodeAmf3 } from "../src/lib/amf3";
import { buildPatchedScript, ScriptPatch, scriptAssetPath } from "../src/lib/skillScripts";
import { buildScheduleOverlay } from "../src/lib/scheduleOverlay";
import type { BalanceChange } from "../src/lib/balanceChanges";
import { digestPath, masterAssetPath, readArchiveMember, readCentralDirectory } from "../src/lib/cdnIndex";
import { buildOrderedMap, decodeOrderedMap } from "../src/lib/orderedmap";

let tmp: string
before(() => { tmp = mkdtempSync(path.join(os.tmpdir(), "skill-scripts-test-")) })
after(() => rmSync(tmp, { recursive: true, force: true }))

const range = (min: Amf3Value, max: Amf3Value) => new Amf3Object({ className: "", dynamic: true, sealed: [] }, new Map([["min", min], ["max", max]]))

// a script shaped like the client's: an attack in a hit area, then a follow-up after a wait
function script(): Amf3Value {
    const attack = ["Command", ["CreateNormalAttack", 7, 255, [], [], 7, [range(new Amf3Double(0.75), new Amf3Double(0.75))]]]
    const area = ["Command", ["CreateHitArea", "*", -18, ["CalculatedUsingMaxNumOfHits", 6], ["Block", [attack]]]]
    const followUp = ["Event", ["Wait", 57, "*", ["Block", [["Command", ["StopBall", -18, 10]]]]]]
    return ["ActionDsl", 3, ["None"], true, false, ["Block", [area, followUp]], range(1, new Amf3Double(2))]
}

const file = (value: Amf3Value) => deflateRawSync(encodeAmf3(value))
const sha256 = (data: Buffer) => createHash("sha256").update(inflateRawSync(data)).digest("hex")

test("AMF3: a value decodes and encodes to the same bytes (references, traits, doubles holding whole numbers)", () => {
    const bytes = encodeAmf3(script())
    assert.deepEqual(encodeAmf3(decodeAmf3(bytes)), bytes)
    const tree = decodeAmf3(bytes) as Amf3Value[]
    // a double stays a double; repeated strings and the second object's traits are written as references
    assert.ok((tree[6] as Amf3Object).values.get("max") instanceof Amf3Double)
    assert.equal(bytes.toString("latin1").split("min").length - 1, 1)
    assert.deepEqual(decodeAmf3(encodeAmf3([-5, 268435455, -268435456, "", null, undefined])), [-5, 268435455, -268435456, "", null, undefined])
    assert.throws(() => decodeAmf3(Buffer.concat([bytes, Buffer.from([1])])), /after the value/)
})

test("a patch sets values and wraps a node, only on the script it was made for", () => {
    const source = file(script())
    const patch: ScriptPatch = {
        source: "battle/action/skill/action/rare5/test$test_1", sha256: sha256(source), target: "battle/action/skill/action/rare5/test$test_1_before",
        edits: [
            { at: [5, 1, 0, 1, 3, 1], set: 10 },
            { at: [5, 1, 0, 1, 4, 1, 0, 1, 6, 0, "min"], set: 2 / 3 },
            { at: [5, 1, 1], wrap: ["Command", ["ConditionalsCombo", 20, ["Block", ["$node"]], ["Block", []]]] }
        ]
    }
    const tree = decodeAmf3(inflateRawSync(buildPatchedScript(source, patch))) as any[]
    assert.deepEqual(tree[5][1][0][1][3], ["CalculatedUsingMaxNumOfHits", 10])
    assert.equal(tree[5][1][0][1][4][1][0][1][6][0].values.get("min").value, 2 / 3)
    assert.deepEqual(tree[5][1][1][1].slice(0, 2), ["ConditionalsCombo", 20])
    assert.deepEqual(tree[5][1][1][1][2][1][0][1].slice(0, 2), ["Wait", 57])

    // a new node with the scripts' {min, max} objects, and a deleted one
    const more = decodeAmf3(inflateRawSync(buildPatchedScript(source, { ...patch, edits: [
        { at: [5, 1, 1], set: ["Command", ["CreateCondition", -17, [["ACDirectDamage", [{ min: 600, max: 600 }], [{ min: 0.5, max: 0.5 }]]]]] },
        { at: [5, 1, 0], delete: true }
    ] }))) as any[]
    assert.equal(more[5][1].length, 1)
    const range0 = more[5][1][0][1][2][0][1][0] as Amf3Object
    assert.deepEqual([range0.traits, range0.values.get("min")], [{ className: "", dynamic: true, sealed: [] }, 600])

    assert.throws(() => buildPatchedScript(file(["ActionDsl", 4]), patch), /not the one the patch was made for/)
    assert.throws(() => buildPatchedScript(source, { ...patch, edits: [{ at: [5, 9, 9], set: 1 }] }), /no 9 in the tree/)
})

test("the schedule overlay ships a patched script while its change is pending, under the patch's path", () => {
    const sourcePath = "battle/action/skill/action/rare5/test$test_1"
    const source = file(script())
    const patch: ScriptPatch = { source: sourcePath, sha256: sha256(source), target: `${sourcePath}_before`, edits: [{ at: [1], set: 2 }] }
    const change = { id: "jp-test", cells: [], entries: [], scripts: [patch] } as unknown as BalanceChange
    const reader = { readMaster: () => undefined, readAsset: (p: string) => p === scriptAssetPath(sourcePath) ? source : undefined }
    const members = (pending: BalanceChange[]) => {
        const archive = path.join(tmp, `overlay-${pending.length}.zip`)
        writeFileSync(archive, buildScheduleOverlay(reader, null, [], { hiddenBoard2: new Set(), pending }).archive)
        return new Map(readCentralDirectory(archive).map(entry => [entry.name, readArchiveMember(archive, entry)]))
    }
    const shipped = members([change]).get(digestPath(scriptAssetPath(patch.target)))
    assert.ok(shipped, "the patched script is in the overlay")
    assert.equal((decodeAmf3(inflateRawSync(shipped)) as Amf3Value[])[1], 2)
    assert.equal(members([]).size, 0, "nothing once the change has landed")
    // a source missing from the CDN fails the build rather than ship a skill pointing at nothing (when the skills ship)
    const skills = buildOrderedMap([["mia", [["Name"]]]]).encode()
    const noScript = { readMaster: (t: string) => t === "skill/action_skill" ? skills : undefined }
    assert.throws(() => buildScheduleOverlay(noScript, null, [], { hiddenBoard2: new Set(), pending: [change] }), /no battle script/)
    // a CDN without the skill table (a test fixture) builds without the scripts too
    assert.doesNotThrow(() => buildScheduleOverlay({ readMaster: () => undefined }, null, [], { hiddenBoard2: new Set(), pending: [change] }))
})

test("a text cell (a skill's earlier description) is written in its language's masters only", () => {
    const skills = buildOrderedMap([["mia", [["Name", "Afterward, follows up", "7"]]]]).encode()
    const change = { id: "jp-test", cells: [
        { table: "skill/action_skill", key: ["mia"], record: 0, column: 1, before: "Extra damage at 20 combo", language: "en" },
        { table: "skill/action_skill", key: ["mia"], record: 0, column: 2, before: "6" }
    ], entries: [] } as unknown as BalanceChange
    const text = (language: string) => {
        const archive = path.join(tmp, `text-${language}.zip`)
        writeFileSync(archive, buildScheduleOverlay({ readMaster: t => t === "skill/action_skill" ? skills : undefined }, null, [],
            { hiddenBoard2: new Set(), pending: [change], language }).archive)
        const entry = readCentralDirectory(archive).find(e => e.name === digestPath(masterAssetPath("skill/action_skill")))!
        const node = decodeOrderedMap(readArchiveMember(archive, entry))
        const leaf = node.kind === "map" ? node.at(["mia"]) : undefined
        return leaf?.kind === "leaf" ? leaf.records[0] : null
    }
    assert.deepEqual(text("en"), ["Name", "Extra damage at 20 combo", "6"])
    assert.deepEqual(text("ko"), ["Name", "Afterward, follows up", "6"], "other languages keep their text; numbers apply to all")
})
