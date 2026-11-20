import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";

// FIX-7: every unit gets bond token entries for boards 1 and 2, as in the original's captures, even one with a single
// mana board (skill_count 3 or less); board 2 opens only where the mana node data has it.

const apiPrefix = "/latest/api/index.php"
const SHROOMBO = 512001 // 1★, skill_count 2, board 1 only
const ONE_BOARD_5STAR = 131152 // 5★, skill_count 3, board 1 only
const TWO_BOARD_5STAR = 111001 // 5★, skill_count 6

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let character: typeof import("../src/lib/character")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    character = await import("../src/lib/character")
})

after(async () => {
    await cleanup()
})

async function signUp() {
    const player = await createTestPlayer(fastify)
    return { ...player, playerId: data.getViewerPlayerIdSync(player.viewerId)! }
}

const boards = (playerId: number, characterId: number) =>
    data.getPlayerCharacterSync(playerId, characterId)!.bondTokenList.map(token => [token.manaBoardIndex, token.status])

describe("a new unit's bond tokens", () => {
    test("units with one mana board get both entries, as the original sent them", async () => {
        const { playerId } = await signUp()
        for (const characterId of [SHROOMBO, ONE_BOARD_5STAR, TWO_BOARD_5STAR]) {
            const result = character.givePlayerCharacterSync(playerId, characterId)! as unknown as { character: { bond_token_list: unknown } }
            assert.deepEqual(result.character.bond_token_list, [{ mana_board_index: 1, status: 0 }, { mana_board_index: 2, status: 0 }])
            assert.deepEqual(boards(playerId, characterId), [[1, 0], [2, 0]])
        }
        // the town capture (Shroombo) has the same list
        const captured = readCapturedRoute("character_add_character_from_town").responseBody.data.character_list[0]
        const given = character.givePlayerCharacterSync((await signUp()).playerId, SHROOMBO)! as unknown as { character: { bond_token_list: unknown } }
        assert.deepEqual(given.character.bond_token_list, captured.bond_token_list)
    })
})

describe("character/open_mana_board", () => {
    async function openBoard2(viewerId: number, udid: string, characterId: number) {
        const response = await fastify.inject({
            method: "POST",
            url: `${apiPrefix}/character/open_mana_board`,
            headers: gameHeaders(udid),
            payload: encodeGameBody({ viewer_id: viewerId, character_id: characterId, mana_board_index: 2 })
        })
        return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : null }
    }

    test("board 2 opens only for a unit that has one, though both have a board 2 bond token", async () => {
        const player = await signUp()
        for (const characterId of [ONE_BOARD_5STAR, TWO_BOARD_5STAR]) {
            character.givePlayerCharacterSync(player.playerId, characterId)
            // fully uncapped, board 1 done and its token taken
            data.updatePlayerCharacterSync(player.playerId, characterId, { overLimitStep: 4 })
            data.updatePlayerCharacterBondTokenSync(player.playerId, characterId, { manaBoardIndex: 1, status: 2 })
        }
        assert.equal((await openBoard2(player.viewerId, player.udid, ONE_BOARD_5STAR)).status, 400)
        assert.equal(data.getPlayerCharacterSync(player.playerId, ONE_BOARD_5STAR)!.manaBoardIndex, 1)

        const opened = await openBoard2(player.viewerId, player.udid, TWO_BOARD_5STAR)
        assert.equal(opened.status, 200)
        assert.equal(data.getPlayerCharacterSync(player.playerId, TWO_BOARD_5STAR)!.manaBoardIndex, 2)
    })
})

describe("database update to version 14", () => {
    test("adds the missing board 2 entry, keeps existing ones, and can run again", async () => {
        const { playerId } = await signUp()
        const { default: getDatabase, Database } = await import("../src/data")
        const { addMissingSecondBondTokens } = await import("../src/data/updaters/wdfpData")
        const db = getDatabase(Database.WDFP_DATA)

        character.givePlayerCharacterSync(playerId, SHROOMBO)
        character.givePlayerCharacterSync(playerId, TWO_BOARD_5STAR)
        data.updatePlayerCharacterBondTokenSync(playerId, TWO_BOARD_5STAR, { manaBoardIndex: 2, status: 1 })
        // a unit given before the fix: board 1's entry only, already taken
        db.prepare(`DELETE FROM players_characters_bond_tokens WHERE player_id = ? AND character_id = ? AND mana_board_index = 2`).run(playerId, SHROOMBO)
        data.updatePlayerCharacterBondTokenSync(playerId, SHROOMBO, { manaBoardIndex: 1, status: 2 })
        assert.deepEqual(boards(playerId, SHROOMBO), [[1, 2]])

        assert.ok(addMissingSecondBondTokens(db) >= 1)
        assert.deepEqual(boards(playerId, SHROOMBO), [[1, 2], [2, 0]])
        assert.deepEqual(boards(playerId, TWO_BOARD_5STAR), [[1, 0], [2, 1]])

        assert.equal(addMissingSecondBondTokens(db), 0)
        assert.deepEqual(boards(playerId, SHROOMBO), [[1, 2], [2, 0]])
    })
})

describe("save import", () => {
    test("a save from before the fix gets board 2's entry back (admin import, developer mode Off)", async () => {
        const { playerId } = await signUp()
        const { getClientSerializedData, deserializePlayerData } = await import("../src/data/utils")
        character.givePlayerCharacterSync(playerId, SHROOMBO)
        data.updatePlayerCharacterBondTokenSync(playerId, SHROOMBO, { manaBoardIndex: 1, status: 2 })
        const save = getClientSerializedData(playerId, { serializeSaveData: true })!
        // the save was made when the unit had board 1's entry only
        save.user_character_list[String(SHROOMBO)].bond_token_list = [{ mana_board_index: 1, status: 2 }]

        data.replacePlayerDataSync(deserializePlayerData(playerId, save))
        assert.deepEqual(boards(playerId, SHROOMBO), [[1, 2], [2, 0]])
    })

    test("a save naming a board other than 1 and 2, or one board twice, is refused with a clear reason", async () => {
        const { playerId } = await signUp()
        const { getClientSerializedData } = await import("../src/data/utils")
        const { validateSaveData, InvalidSaveError } = await import("../src/data/saveSchema")
        character.givePlayerCharacterSync(playerId, SHROOMBO)
        const save = JSON.parse(JSON.stringify(getClientSerializedData(playerId, { serializeSaveData: true })))
        const withBoards = (...list: number[]) => {
            const copy = structuredClone(save)
            copy.user_character_list[String(SHROOMBO)].bond_token_list = list.map(board => ({ mana_board_index: board, status: 0 }))
            return copy
        }

        assert.doesNotThrow(() => validateSaveData(withBoards(1, 2)))
        assert.doesNotThrow(() => validateSaveData(withBoards(1)))
        // [1, 1] passed the length check before and then failed the import's insert on the board key
        assert.throws(() => validateSaveData(withBoards(1, 1)), (error: Error) => error instanceof InvalidSaveError && /same board twice/.test(error.message))
        assert.throws(() => validateSaveData(withBoards(1, 3)), InvalidSaveError)
        assert.throws(() => validateSaveData(withBoards(0)), InvalidSaveError)
    })
})

