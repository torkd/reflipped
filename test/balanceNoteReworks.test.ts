// FT-74: more of global's patch notes on the timeline. Lines whose two columns only punctuate differently are number-only
// changes; lines whose later text adds an effect roll back by dropping that effect's record; numbers are placed only in
// the columns that hold an effect's value (Botan's leader once got its trigger's 100000 in column 26 changed instead).
import { test } from "node:test";
import assert from "node:assert/strict";
import balanceChanges from "../assets/balance_changes.json";
import type { BalanceChange } from "../src/lib/balanceChanges";

const changes = (balanceChanges as { changes: BalanceChange[] }).changes
const change = (id: string) => changes.find(c => c.id === id)!
const entry = (id: string, table: string, key: string) => change(id).entries.find(e => e.table === table && e.key.join("/") === key)

const WIDTH: Record<string, number> = { "ability/ability": 118, "ability/leader_ability": 116 }
// effect values; counts (28/29, 95/96; leader 26/27) and durations (55/56; leader 53/54); stack caps (32, 97; leader 30)
const VALUE_COLUMNS: Record<string, number[]> = {
    "ability/ability": [49, 50, 108, 109, 28, 29, 95, 96, 55, 56, 32, 97],
    "ability/leader_ability": [47, 48, 106, 107, 26, 27, 53, 54, 30]
}

test("an effect a round added is dropped before it: Suizen's leader is HP only, Barrek's attack is 65 % without Power Flip damage", () => {
    const suizen = entry("jp-2021-09-30", "ability/leader_ability", "121002")!
    assert.equal(suizen.records.length, 1)
    assert.equal(suizen.records[0][43], "203", "the HP effect")
    assert.equal(suizen.records[0][48], "40000")

    const barrek = entry("jp-2021-09-30", "ability/leader_ability", "131005")!
    assert.equal(barrek.records.length, 1)
    assert.deepEqual([barrek.records[0][43], barrek.records[0][47], barrek.records[0][48]], ["31", "50000", "65000"])

    // Falche's round (notice 1664) is its own change, on Japan's 2022-10-21
    const falche = change("jp-2022-10-21")
    assert.deepEqual(falche.units, ["261017"])
    assert.equal(falche.jpDate, "2022-10-21")
    assert.ok(falche.entries.length > 0)
})

test("rebuilt entries keep the table's record width", () => {
    for (const c of changes) for (const e of c.entries) {
        if (!(e.table in WIDTH)) continue
        for (const record of e.records) assert.equal(record.length, WIDTH[e.table], `${c.id} ${e.table} ${e.key.join("/")}`)
    }
})

const cell = (id: string, table: string, key: string, record: number, column: number) =>
    change(id).cells.find(c => c.table === table && c.key.join("/") === key && c.record === record && c.column === column)?.before

test("counts, durations and stack caps: each in its own columns, as the rows store them", () => {
    // 253001: "every 3 time(s)" was "every 5" (×100000, level 1 and maximum alike)
    assert.equal(cell("jp-2021-09-30", "ability/ability", "2530012", 0, 28), "500000")
    assert.equal(cell("jp-2021-09-30", "ability/ability", "2530012", 0, 29), "500000")
    // 261005: Pierce "for 10 second(s)" was 5 (600 frames ×100000; level 1 half of it)
    assert.equal(cell("jp-2021-09-30", "ability/ability", "2610053", 0, 56), "30000000")
    assert.equal(cell("jp-2021-09-30", "ability/ability", "2610053", 0, 55), "15000000")
    // Leon's main-unit ability: "(Max +80 %)" at +20 %, 4 stacks (the later note leaves the main-unit condition out)
    assert.equal(cell("jp-2021-09-30", "ability/ability", "1410043", 0, 32), "4")
    // 151007: a stack cap in a record's second block (column 97); Marina's leader: a leader's cap (column 30)
    assert.equal(cell("jp-2021-09-30", "ability/ability", "1510073", 0, 97), "16")
    assert.equal(cell("jp-2021-09-30", "ability/leader_ability", "111002", 2, 30), "5")
})

test("the notes' numbers are placed only in value columns (and the stack cap)", () => {
    for (const c of changes.filter(c => c.source.startsWith("note 12") || c.source.startsWith("note 26"))) {
        for (const cell of c.cells) {
            if (!(cell.table in VALUE_COLUMNS)) continue
            assert.ok(VALUE_COLUMNS[cell.table].includes(cell.column), `${c.id} ${cell.table} ${cell.key.join("/")} ${cell.record}:${cell.column}`)
        }
    }
    const botan = change("jp-2021-09-30").cells.filter(cell => cell.table === "ability/leader_ability" && cell.key[0] === "131012")
    assert.deepEqual(botan.filter(cell => cell.record === 1).map(cell => [cell.column, cell.before]).sort(), [[47, "55000"], [48, "70000"]])
})

test("the balance data's digest, which the schedule view's identity carries, so new data makes new views", async () => {
    const { BALANCE_DATA_DIGEST } = await import("../src/lib/balanceChanges")
    assert.match(BALANCE_DATA_DIGEST, /^[0-9a-f]{16}$/)
})

test("Japan's detail notices fill the 2021-09 round for units global's note lacks (261047's leader)", () => {
    // 闇属性キャラの攻撃力 + 20 % ／ … + 10 %[最大 + 90 % ] → + 50 % ／ … + 15 %[最大 + 150 % ]
    assert.equal(cell("jp-2021-09-30", "ability/leader_ability", "261047", 0, 48), "20000")
    assert.equal(cell("jp-2021-09-30", "ability/leader_ability", "261047", 1, 48), "10000")
    assert.equal(cell("jp-2021-09-30", "ability/leader_ability", "261047", 1, 30), "9")
})

test("the Zombie Land Saga buff (notice 817) lands before the 2021-09 round, with the leaders' values before evolution", () => {
    const collab = change("jp-2021-04-24")
    assert.equal(collab.source, "jp 817")
    assert.ok(collab.units.includes("121009"))
    // Sakura: before evolution the Power Flip buff lasted 7.5 s (column 53), after it 15 s (54), at +60 % (48)
    assert.equal(cell("jp-2021-04-24", "ability/leader_ability", "121009", 0, 53), "45000000")
    assert.equal(cell("jp-2021-04-24", "ability/leader_ability", "121009", 0, 54), "90000000")
    assert.equal(cell("jp-2021-04-24", "ability/leader_ability", "121009", 0, 48), "60000")
    // in the 2021-09 round her value before evolution is 817's (+90 %), not the table's three quarters of +120 %
    assert.equal(cell("jp-2021-09-30", "ability/leader_ability", "121009", 0, 47), "90000")
    assert.equal(cell("jp-2021-09-30", "ability/leader_ability", "121009", 0, 48), "120000")
})

test("the wiki's thunder and wind lines fill notice 1057's part; Saki's leader then rolls back to 2021-04 too", () => {
    // Saki (141009): after evolution +100 % attack / +70 % Power Flip in the round, +60 % / +60 % before it (the wiki), and
    // before evolution notice 817's +45 % / +45 % (not the convention's three quarters)
    assert.equal(cell("jp-2021-09-30", "ability/leader_ability", "141009", 0, 48), "60000")
    assert.equal(cell("jp-2021-09-30", "ability/leader_ability", "141009", 1, 48), "60000")
    assert.equal(cell("jp-2021-09-30", "ability/leader_ability", "141009", 0, 47), "45000")
    // and the collab buff before that: +40 % / +40 % after evolution, +30 % / +30 % before
    assert.equal(cell("jp-2021-04-24", "ability/leader_ability", "141009", 0, 48), "40000")
    assert.equal(cell("jp-2021-04-24", "ability/leader_ability", "141009", 0, 47), "30000")
    assert.ok(change("jp-2021-09-30").units.length >= 190)
})

test("armaments: Durendal before its HP effect, Knight's Shield before its awakening-5 resistance (global's note 1242)", () => {
    const update = change("jp-2020-12-18")
    const durendal = update.entries.find(e => e.table === "ability/ability_soul" && e.key[0] === "5010005")!
    assert.equal(durendal.records.length, 1, "the HP effect it gained is dropped")
    assert.deepEqual([durendal.records[0][44], durendal.records[0][48], durendal.records[0][49]], ["31", "140000", "140000"])
    const shield = update.entries.find(e => e.table === "ability/ability_soul" && e.key[0] === "3080009")!
    assert.equal(shield.records.length, 1, "the awakening-5 record is dropped")
    assert.deepEqual([shield.records[0][48], shield.records[0][49]], ["2500", "5000"])
})

test("reworked kits rebuilt from records that encode the old wording (Japan's notice 1793, Inaho, Rhode, Eleanor)", () => {
    const round = change("jp-2022-12-31")
    for (const unit of ["131001", "131032", "231004"]) assert.ok(round.units.includes(unit), unit)
    // Inaho's leader: + 40 % Thunder attack / + 30 % Fever Mode time (FeverTimeExtension, 55)
    const leader = entry("jp-2022-12-31", "ability/leader_ability", "131001")!
    assert.deepEqual(leader.records.map(r => [r[0], r[43], r[48]]), [["fox_oracle", "31", "40000"], ["fox_oracle", "55", "30000"]])
    // her ability 3: main unit, while in Fever Mode (second block, condition Fever 4), own attack + 200 %
    const a3 = entry("jp-2022-12-31", "ability/ability", "1310013")!.records[0]
    assert.deepEqual([a3[0], a3[1], a3[3], a3[92], a3[109]], ["fox_oracle_3", "false", "1", "4", "200000"])
    // her skill's gauge: 630 once evolved
    assert.equal(change("jp-2022-12-31").cells.find(c => c.table === "skill/action_skill" && c.key.join("/") === "fox_oracle/2" && c.column === 5)?.before, "630")
    // Rhode: Electrify capped at 3, her ability 3 without its unconditional record
    assert.equal(cell("jp-2022-12-31", "character/unique_condition", "2", 0, 4), "3")
    assert.equal(entry("jp-2022-12-31", "ability/ability", "1310323")!.records.length, 3)
    // Eleanor's ability 6: once at 50 combos (+ 20 %), once at 100 (+ 30 %), on the Combo trigger (7)
    const a6 = entry("jp-2022-12-31", "ability/ability", "2310046")!.records
    assert.deepEqual(a6.map(r => [r[25], r[28], r[32], r[50]]), [["7", "5000000", "1", "20000"], ["7", "10000000", "1", "30000"]])
})

test("Renoir's and Karyl's 2021-09 lines: Japan's wording, not global's note's", () => {
    // Renoir (231002): the note has the Halloween Renoir's leader; Japan's wiki: skill damage + 60 % → + 80 %
    assert.equal(cell("jp-2021-09-30", "ability/leader_ability", "231002", 0, 48), "60000")
    assert.equal(entry("jp-2021-09-30", "ability/ability", "2310021")!.records.length, 1, "his ability 1 without its added attack")
    // Karyl: while her skill damage is boosted by 500 % or more (condition SkillDamageUp 74), skill damage (2) + 200 %
    const karyl = entry("jp-2021-09-30", "ability/ability", "1610073")!.records[0]
    assert.deepEqual([karyl[92], karyl[95], karyl[104], karyl[109]], ["74", "500000", "2", "200000"])
})

test("Mia's skill before notice 1458: a patched script per skill level, the row pointing at it, her old text in English", () => {
    const round = change("jp-2022-05-31")
    assert.ok(round.units.includes("111009"))
    const scripts = (round.scripts ?? []).filter(s => s.source.includes("tiger_treasure_hunter_smr20$"))
    assert.equal(scripts.length, 2)
    for (const [level, script] of [["1", scripts[0]], ["2", scripts[1]]] as const) {
        assert.ok(script.target.startsWith(script.source) && script.target !== script.source)
        assert.match(script.sha256, /^[0-9a-f]{64}$/)
        assert.equal(cell("jp-2022-05-31", "skill/action_skill", `tiger_treasure_hunter_smr20/${level}`, 0, 7), script.target)
        // the follow-up wrapped in the client's combo condition, last (the other edits' paths run through it)
        assert.deepEqual((script.edits[script.edits.length - 1] as { wrap: unknown[] }).wrap.slice(0, 1), ["Command"])
    }
    const text = round.cells.find(c => c.table === "skill/action_skill" && c.column === 1 && c.key[0] === "tiger_treasure_hunter_smr20")!
    assert.equal(text.language, "en")
    assert.match(text.before, /20 combo or higher/)
    // her old leader: every 20 combos (Combo 7, no puller) + 7.5 %, 12 stacks
    const leader = entry("jp-2022-05-31", "ability/leader_ability", "111009")!.records
    assert.deepEqual([leader.length, leader[1][23], leader[1][24], leader[1][30], leader[1][48]], [2, "7", "", "12", "7500"])
})

test("batch 2: Kuramaru, Soushiro, Mormia and Alk before their reworks; Kuramaru's 2021-09 lines on the rebuilt kit", () => {
    // Soushiro's own round (notice 1566), with his skill's Fever Gauge back and his gauge at 570 evolved
    const soushiro = change("jp-2022-08-08")
    assert.deepEqual([soushiro.units, soushiro.source, soushiro.jpDate], [["131003"], "note 2610", "2022-08-08"])
    assert.equal(cell("jp-2022-08-08", "skill/action_skill", "samurai_xm19/2", 0, 5), "570")
    assert.deepEqual(soushiro.scripts!.map(s => s.edits[0]), [
        { at: [11, 1, 3], set: ["Command", ["AddFeverPoint", [{ min: 50, max: 50 }]]] },
        { at: [11, 1, 3], set: ["Command", ["AddFeverPoint", [{ min: 75, max: 100 }]]] }])
    // his old leader: a Fever heal (RatioHeal 204), three times, as a leader record (116 columns)
    const leader = entry("jp-2022-08-08", "ability/leader_ability", "131003")!.records
    assert.deepEqual([leader[1].length, leader[1][23], leader[1][30], leader[1][43], leader[1][48]], [116, "4", "3", "204", "20000"])
    // Kuramaru (2022-12) and global's 1241 lines on top (2021-09): the leader's HP 15 → 12 %, attack 65 → 40 %
    assert.deepEqual(entry("jp-2022-12-31", "ability/leader_ability", "211013")!.records.map(r => [r[43], r[48]]), [["203", "15000"], ["31", "65000"]])
    assert.equal(cell("jp-2021-09-30", "ability/leader_ability", "211013", 0, 48), "12000")
    assert.equal(cell("jp-2021-09-30", "ability/leader_ability", "211013", 1, 48), "40000")
    // Mormia's skill without the Pierce; Alk's with the party's Power Flip buff, and his gauge 570 before the 2021-09 round
    assert.deepEqual(change("jp-2022-05-31").scripts!.filter(s => s.source.includes("blade_witch$")).map(s => s.edits), [
        [{ at: [11, 1, 3], delete: true }], [{ at: [11, 1, 3], delete: true }]])
    assert.equal(cell("jp-2021-09-30", "skill/action_skill", "white_tiger/2", 0, 5), "570")
})

test("Falche before notice 1664: her Light resistance kit, and her skill's own buffs and Dark-boosted two-coffin heal", () => {
    const round = change("jp-2022-10-21")
    // her ability 3 stays note_changes.py's entry; the rest of her kit from rework_kits.py
    assert.deepEqual(round.entries.map(e => e.key[0]).sort(), ["2610171", "2610172", "2610173", "2610174", "2610176", "261017"].sort())
    const leader = entry("jp-2022-10-21", "ability/leader_ability", "261017")!.records
    assert.deepEqual([leader[1][43], leader[1][44], leader[1][45], leader[1][48]], ["40", "5", "(None)", "20000"], "the whole party's Light resistance")
    const [base, evolved] = round.scripts!
    assert.deepEqual(base.edits[0], { at: [11, 1, 1, 1, 13, 1], set: 300 }, "the aura for 5 s")
    // the heal in the two-coffin branch, boosted + 50 % for Dark units (element 6)
    const heal = JSON.stringify(evolved.edits[2])
    assert.match(heal, /"CreateRatioHeal",4,2,\[\{"min":0\.06,"max":0\.08\}\],\[6\],\[\{"min":0\.5,"max":0\.5\}\]/)
})

test("Alice before notice 1609: her foe-destroyed kit, Levitate in her skill and on her mana board", () => {
    const round = change("jp-2022-09-07")
    assert.deepEqual(round.entries.map(e => e.key[0]).sort(), ["1610081", "1610082", "1610083", "1610085", "1610086"])
    // every 4 foes destroyed (EnemyKill 6), + 10 %, 10 stacks
    const a1 = entry("jp-2022-09-07", "ability/ability", "1610081")!.records[0]
    assert.deepEqual([a1[25], a1[28], a1[32], a1[50]], ["6", "400000", "10", "10000"])
    // the skill grants Levitate (ACFlying) where it granted Pierce, and the mana board upgrade reads 'Boost Levitate'
    assert.deepEqual(round.scripts!.map(s => s.edits), [[{ at: [11, 1, 1, 1, 9, 1, 0, 1, 2, 0, 0], set: "ACFlying" }],
        [{ at: [11, 1, 1, 1, 9, 1, 0, 1, 2, 0, 0], set: "ACFlying" }]])
    assert.equal(cell("jp-2022-09-07", "mana_board/upskill", "161008", 0, 2), "condition_flying_up")
    assert.equal(cell("jp-2022-09-07", "mana_board/upskill", "161008", 0, 8), "condition_flying_up")
})

test("Pecorine and Amelia before notice 1793: kits, skills, Amelia's support Power Flip; their HP and ATK stay (no source)", () => {
    const round = change("jp-2022-12-31")
    for (const unit of ["151011", "221003"]) assert.ok(round.units.includes(unit), unit)
    // Pecorine's skill: base 24 / 72 and all-element resistance (ACToleranceOfElement, element 254) instead of attack
    const pecorine = round.scripts!.filter(s => s.source.includes("pecorine$"))
    assert.equal(pecorine.length, 2)
    assert.match(JSON.stringify(pecorine[1].edits), /"ACToleranceOfElement",\[\{"min":900,"max":900\}\],254,\[\{"min":0\.2,"max":0\.25\}\]/)
    assert.equal(cell("jp-2022-12-31", "ability/leader_ability", "151008", 1, 107), "55000")
    // Amelia: Fever Gauge on every use, and Power Flip type 3 (support) in character/character
    assert.deepEqual(round.scripts!.filter(s => s.source.includes("mermaid$")).map(s => s.edits[0]), [
        { at: [11, 1, 1], set: ["Command", ["AddFeverPoint", [{ min: 20, max: 20 }]]] },
        { at: [11, 1, 1], set: ["Command", ["AddFeverPoint", [{ min: 30, max: 40 }]]] }])
    assert.equal(cell("jp-2022-12-31", "character/character", "221003", 0, 6), "3")
    assert.ok(!round.cells.some(c => c.table === "character/character_status" && ["151011", "221003"].includes(c.key[0])))
})

test("no master table is both a balance table and a date-scheduled one (the overlay would write it twice)", async () => {
    const { BALANCE_MASTER_TABLES, SCHEDULE_MASTER_TABLES } = await import("../src/lib/scheduleOverlay")
    assert.deepEqual(BALANCE_MASTER_TABLES.filter(t => SCHEDULE_MASTER_TABLES.includes(t)), [])
})

test("Arum before notice 1793: her HP-low kit, a skill that only summons (60 s, 15 % of her HP), multiballs without Anti-Healing", () => {
    const round = change("jp-2022-12-31")
    assert.ok(round.units.includes("261001"))
    const [base] = round.scripts!.filter(s => s.source.includes("devil_princess$"))
    assert.deepEqual(base.edits.map(e => Object.keys(e).find(k => k !== "at")), ["set", "delete", "set", "set", "wrap"])
    assert.match(JSON.stringify(base.edits[4]), /"CreateRatioAttack",-17,2,\[\{"min":0\.15,"max":0\.15\}\]/)
    for (const mb of ["2610011", "2610012"]) assert.equal(cell("jp-2022-12-31", "battle/multiball/multiball", mb, 0, 22), "(None)")
    // ability 1: 20 % of her max HP at battle start (RatioDamageMaxHp 207) and + 35 % attack
    assert.deepEqual(entry("jp-2022-12-31", "ability/ability", "2610011")!.records.map(r => [r[45], r[50]]), [["207", "20000"], ["31", "35000"]])
})

test("the 2021-09 round's skill gauge cuts: nine skills' gauges before it (the blog), Yuwel's and Liesel's added buffs removed", () => {
    // Vagner 650 once evolved (now 550): rows 700/700 and 700/650
    for (const [level, column, value] of [["1", 4, "700"], ["1", 5, "700"], ["2", 4, "700"], ["2", 5, "650"]] as const)
        assert.equal(cell("jp-2021-09-30", "skill/action_skill", `fire_dragon/${level}`, 0, column), value)
    // Liao and Torene: in Japan's notices only
    assert.equal(cell("jp-2021-09-30", "skill/action_skill", "doctor_pirate/2", 0, 5), "600")
    assert.equal(cell("jp-2021-09-30", "skill/action_skill", "cool_woman_soldier_xm20/2", 0, 5), "590")
    const scripts = change("jp-2021-09-30").scripts!
    assert.deepEqual(scripts.filter(s => s.source.includes("swallow_knight$")).map(s => s.edits), [
        [{ at: [11, 1, 1], delete: true }], [{ at: [11, 1, 1], delete: true }]])
    assert.equal(scripts.filter(s => s.source.includes("monster_cook$")).length, 2)
})

test("the 2021-09 round's other skill changes, rolled back where the blog has the numbers", () => {
    const scripts = change("jp-2021-09-30").scripts!
    const of = (skill: string) => scripts.filter(s => s.source.includes(`${skill}$`))
    // 31 skills patched besides the gauge round's three; both levels each
    assert.equal(new Set(scripts.map(s => s.source.split("$")[0])).size, 34)
    // Toria: the shockwave 3 hits, base power 73 and 22
    assert.match(JSON.stringify(of("halberd_princess")[0].edits), /"set":73.*"set":3.*"set":22/)
    // Selene: her attack buff for herself again (-17), not a FindAllSubjects for Water units
    assert.match(JSON.stringify(of("commander")[0].edits[0]), /"CreateCondition",-17,\[\["ACAttackPoint"/)
    // Prika, Hayz, Fluffy, Yakumo, Festive Yuwel, Halloween Dia: the added buff deleted
    for (const skill of ["fake_princess", "pirates_gunner", "combat_animal", "silent_ninja", "swallow_knight_ny20", "sing_android_hw20"])
        assert.ok(of(skill).every(s => s.edits.length === 1 && "delete" in s.edits[0]), skill)
})
