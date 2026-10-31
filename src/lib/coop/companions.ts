import characters from "../../../assets/character.json";
import gachas from "../../../assets/gacha.json";
/**
 * Default AI companions for `multi_battle_quest/summon`.
 *
 * These are the two companions the original server returned in the captured summon reply
 * (docs/routes/multi_battle_quest_summon.md): real high-level parties, so their shape is known to be
 * valid for the client. `com_id`s are reassigned per summon. Later, parties of other players in the
 * database could be used instead.
 */
export const DEFAULT_COMPANIONS: any[] = [
    {
        "com_id": 11525449,
        "rank": 138,
        "party": {
            "characters": [
                {
                    "id": 151165,
                    "mana_node_ids": [
                        302330201,
                        302330202,
                        302330203,
                        302330204,
                        302330205,
                        302330206,
                        302330207,
                        302330208,
                        302330209,
                        302330210,
                        302330211,
                        302330212,
                        302330213,
                        302330214,
                        302330215,
                        302330216,
                        302330217,
                        302330218,
                        302330219,
                        302330220,
                        302330221,
                        302330222,
                        302330223
                    ],
                    "evolution_level": 1,
                    "exp": 153988,
                    "over_limit_step": 0
                },
                {
                    "id": 151002,
                    "mana_node_ids": [
                        302004201,
                        302004202,
                        302004203,
                        302004204,
                        302004205,
                        302004206,
                        302004207,
                        302004208,
                        302004209,
                        302004210,
                        302004211,
                        302004212,
                        302004213,
                        302004214,
                        302004215,
                        302004216,
                        302004217,
                        302004218,
                        302004219,
                        302004220,
                        302004221,
                        302004222,
                        302004223,
                        302004401
                    ],
                    "evolution_level": 1,
                    "exp": 379988,
                    "over_limit_step": 4,
                    "ex_boost": {
                        "status_id": 2,
                        "ability_id_list": [
                            3,
                            40
                        ]
                    }
                },
                {
                    "id": 153001,
                    "mana_node_ids": [
                        306002201,
                        306002202,
                        306002203,
                        306002204,
                        306002205,
                        306002206,
                        306002207,
                        306002208,
                        306002209,
                        306002210,
                        306002211,
                        306002212,
                        306002213,
                        306002214,
                        306002215,
                        306002216,
                        306002217,
                        306002218,
                        306002219,
                        306002220,
                        306002221,
                        306002222,
                        306002223
                    ],
                    "evolution_level": 1,
                    "exp": 153988,
                    "over_limit_step": 0
                }
            ],
            "unison_characters": [
                {
                    "id": 151117,
                    "mana_node_ids": [
                        302234201,
                        302234202,
                        302234203,
                        302234204,
                        302234205,
                        302234206,
                        302234207,
                        302234208,
                        302234209,
                        302234210,
                        302234211,
                        302234212,
                        302234213,
                        302234214,
                        302234215,
                        302234216,
                        302234217,
                        302234218,
                        302234219,
                        302234220,
                        302234221,
                        302234222,
                        302234223
                    ],
                    "evolution_level": 1,
                    "exp": 153988,
                    "over_limit_step": 0
                },
                {
                    "id": 251059,
                    "mana_node_ids": [
                        502118201,
                        502118202,
                        502118203,
                        502118204,
                        502118205,
                        502118206,
                        502118207,
                        502118208,
                        502118209,
                        502118210,
                        502118211,
                        502118212,
                        502118213,
                        502118219,
                        502118220,
                        502118221,
                        502118222,
                        502118223
                    ],
                    "evolution_level": 1,
                    "exp": 102829,
                    "over_limit_step": 1
                },
                {
                    "id": 251010,
                    "mana_node_ids": [
                        502020201,
                        502020202,
                        502020203,
                        502020204,
                        502020205,
                        502020206,
                        502020207,
                        502020208,
                        502020209,
                        502020210,
                        502020211,
                        502020212,
                        502020213,
                        502020214,
                        502020215,
                        502020216,
                        502020217,
                        502020218,
                        502020219,
                        502020220,
                        502020221,
                        502020222,
                        502020223
                    ],
                    "evolution_level": 1,
                    "exp": 342410,
                    "over_limit_step": 6,
                    "ex_boost": {
                        "status_id": 1,
                        "ability_id_list": [
                            9,
                            40
                        ]
                    }
                }
            ],
            "equipments": [
                {
                    "equipment_id": 5020024,
                    "level": 1,
                    "enhancement_level": 0
                },
                {
                    "equipment_id": 5090014,
                    "level": 5,
                    "enhancement_level": 0
                },
                {
                    "equipment_id": 5060044,
                    "level": 1,
                    "enhancement_level": 0
                }
            ],
            "ability_soul_ids": [
                5050039,
                5010055,
                5010055
            ]
        },
        "degree_id": 90002
    },
    {
        "com_id": 11525943,
        "rank": 190,
        "party": {
            "characters": [
                {
                    "id": 151165,
                    "mana_node_ids": [
                        302330201,
                        302330202,
                        302330203,
                        302330204,
                        302330205,
                        302330206,
                        302330207,
                        302330208,
                        302330209,
                        302330210,
                        302330211,
                        302330212,
                        302330213,
                        302330214,
                        302330215,
                        302330216,
                        302330217,
                        302330218,
                        302330219,
                        302330220,
                        302330221,
                        302330222,
                        302330223
                    ],
                    "evolution_level": 1,
                    "exp": 153988,
                    "over_limit_step": 0
                },
                {
                    "id": 251011,
                    "mana_node_ids": [
                        502022201,
                        502022202,
                        502022203,
                        502022204,
                        502022205,
                        502022206,
                        502022207,
                        502022208,
                        502022209,
                        502022210,
                        502022211,
                        502022212,
                        502022213,
                        502022214,
                        502022215,
                        502022216,
                        502022217,
                        502022218,
                        502022219,
                        502022220,
                        502022221,
                        502022222,
                        502022223
                    ],
                    "evolution_level": 1,
                    "exp": 342410,
                    "over_limit_step": 6
                },
                {
                    "id": 153001,
                    "mana_node_ids": [
                        306002201,
                        306002202,
                        306002203,
                        306002204,
                        306002205,
                        306002206,
                        306002207,
                        306002208,
                        306002209,
                        306002210,
                        306002211,
                        306002212,
                        306002213,
                        306002214,
                        306002215,
                        306002216,
                        306002217,
                        306002218,
                        306002219,
                        306002220,
                        306002221,
                        306002222,
                        306002223
                    ],
                    "evolution_level": 1,
                    "exp": 153988,
                    "over_limit_step": 0
                }
            ],
            "unison_characters": [
                {
                    "id": 151117,
                    "mana_node_ids": [
                        302234201,
                        302234202,
                        302234203,
                        302234204,
                        302234205,
                        302234206,
                        302234207,
                        302234208,
                        302234209,
                        302234210,
                        302234211,
                        302234212,
                        302234213,
                        302234214,
                        302234215,
                        302234216,
                        302234217,
                        302234218,
                        302234219,
                        302234220,
                        302234221,
                        302234222,
                        302234223,
                        302234401,
                        302234402,
                        302234403,
                        302234404,
                        302234405,
                        302234406,
                        302234407,
                        302234408,
                        302234409,
                        302234410,
                        302234411,
                        302234412,
                        302234413,
                        302234414,
                        302234415,
                        302234416,
                        302234417,
                        302234418
                    ],
                    "evolution_level": 1,
                    "exp": 379988,
                    "over_limit_step": 4
                },
                {
                    "id": 251041,
                    "mana_node_ids": [
                        502082201,
                        502082202,
                        502082203,
                        502082204,
                        502082205,
                        502082206,
                        502082207,
                        502082208,
                        502082209,
                        502082210,
                        502082211,
                        502082212,
                        502082213,
                        502082214,
                        502082215,
                        502082216,
                        502082217,
                        502082218,
                        502082219,
                        502082220,
                        502082221,
                        502082222,
                        502082223,
                        502082401,
                        502082402,
                        502082403,
                        502082404,
                        502082405,
                        502082406
                    ],
                    "evolution_level": 1,
                    "exp": 342410,
                    "over_limit_step": 6
                },
                {
                    "id": 151105,
                    "mana_node_ids": [
                        302210201,
                        302210202,
                        302210203,
                        302210204,
                        302210205,
                        302210206,
                        302210207,
                        302210208,
                        302210209,
                        302210210,
                        302210211,
                        302210212,
                        302210213,
                        302210214,
                        302210215,
                        302210216,
                        302210217,
                        302210218,
                        302210219,
                        302210220,
                        302210221,
                        302210222,
                        302210223,
                        302210401,
                        302210402,
                        302210403,
                        302210404,
                        302210405,
                        302210406,
                        302210407,
                        302210408,
                        302210409,
                        302210410,
                        302210411,
                        302210412,
                        302210413,
                        302210414,
                        302210415,
                        302210416,
                        302210417,
                        302210418
                    ],
                    "evolution_level": 1,
                    "exp": 379988,
                    "over_limit_step": 4
                }
            ],
            "equipments": [
                {
                    "equipment_id": 5020039,
                    "level": 5,
                    "enhancement_level": 0
                },
                {
                    "equipment_id": 5090014,
                    "level": 5,
                    "enhancement_level": 0
                },
                {
                    "equipment_id": 5090025,
                    "level": 5,
                    "enhancement_level": 0
                }
            ],
            "ability_soul_ids": [
                5050039,
                4050004,
                5010055
            ]
        },
        "degree_id": 63001
    }
]


// --- balancing -----------------------------------------------------------------------------------

/** Names for companions Reflipped adds itself (the client names the ones it summons). */
export const COMPANION_NAMES = ["Mira", "Kael", "Lumi", "Rook", "Sena", "Taro"]

/** Released characters and equipment (every id in a gacha pool), grouped by rarity. */
interface Pools {
    characters: Map<number, number[]>
    equipment: Map<number, number[]>
}
let pools: Pools | null = null
function gachaPools(): Pools {
    if (pools) return pools
    const found = { characters: new Map<number, Set<number>>(), equipment: new Map<number, Set<number>>() }
    const add = (map: Map<number, Set<number>>, rarity: number, id: number) => {
        if (!map.has(rarity)) map.set(rarity, new Set())
        map.get(rarity)!.add(id)
    }
    for (const gacha of Object.values(gachas as Record<string, any>)) {
        for (const entries of Object.values(gacha.pool ?? {}) as any[]) {
            for (const entry of entries) {
                const id = Number(entry.id)
                if (String(id) in characters) add(found.characters, characterRarity(id), id)
                else add(found.equipment, equipmentRarity(id), id)
            }
        }
    }
    const sorted = (map: Map<number, Set<number>>) => new Map([...map].map(([rarity, ids]) => [rarity, [...ids].sort((a, b) => a - b)]))
    pools = { characters: sorted(found.characters), equipment: sorted(found.equipment) }
    return pools
}

/** Every released character id (from the gacha pools). */
export function companionCharacterPool(): number[] {
    return [...gachaPools().characters.values()].flat().sort((a, b) => a - b)
}

/** An equipment (or ability soul) id's first digit is its rarity: 3010007 is 3★. */
function equipmentRarity(id: number): number {
    return Number(String(id)[0])
}

function characterRarity(id: number): number {
    return (characters as Record<string, { rarity: number }>)[String(id)]?.rarity ?? 3
}

/**
 * A random id of `rarity` from `byRarity`, not in `exclude`; if that rarity has none left, the
 * nearest rarity below, then above. Adds the pick to `exclude` when one is given.
 */
function drawSimilar(byRarity: Map<number, number[]>, rarity: number, random: () => number, exclude?: Set<number>): number | null {
    const order = [rarity, ...[1, 2, 3, 4].flatMap(d => [rarity - d, rarity + d])]
    for (const r of order) {
        const candidates = (byRarity.get(r) ?? []).filter(id => !exclude?.has(id))
        if (candidates.length === 0) continue
        const id = candidates[Math.floor(random() * candidates.length)]
        exclude?.add(id)
        return id
    }
    return null
}

/** Unwraps a TypePacker Option list (Some(x) = [0, x], None = [1]) into values and nulls. */
function options(list: any): any[] {
    return (Array.isArray(list) ? list : []).map((slot: any) => Array.isArray(slot) && slot[0] === 0 ? slot[1] ?? null : null)
}

/** Used when the host's own party is unknown: three 3★ characters at level 1, nothing else. */
const FALLBACK_HOST_PARTY = {
    characters: [0, 1, 2].map(() => [0, { id: 0, exp: 0, evolution_level: 0, over_limit_step: 0 }]),
    unison_characters: [[1], [1], [1]],
    equipments: [[1], [1], [1]],
    abilitySoulIds: [[1], [1], [1]]
}

/**
 * `count` companions in the summon reply format ({com_id, rank, degree_id, party}), each
 * equivalent to the host's party slot by slot, but not a copy:
 * - where the host has a character: a random released character of the same rarity, with the
 *   host's experience, evolution and over-limit for that slot (no mana nodes, which belong to
 *   one character; no EX boost);
 * - where the host has equipment or an ability soul: a random one of the same rarity, with the
 *   same level and enhancement;
 * - empty slots stay empty.
 * No character appears twice in the room, the host's included.
 */
export function balancedCompanions(hostMate: any | null, count: number, firstComId: number, random: () => number = Math.random): any[] {
    const party = hostMate?.party ?? FALLBACK_HOST_PARTY
    const hostCharacters = options(party.characters)
    const hostUnison = options(party.unison_characters)
    const hostEquipment = options(party.equipments)
    const hostSouls = options(party.abilitySoulIds)
    const { characters: characterPool, equipment: equipmentPool } = gachaPools()

    const used = new Set<number>([...hostCharacters, ...hostUnison].filter(Boolean).map((c: any) => Number(c.id)))
    const character = (slot: any) => {
        if (!slot) return null
        const id = drawSimilar(characterPool, slot.id ? characterRarity(Number(slot.id)) : 3, random, used)
        if (id === null) return null
        return {
            id,
            exp: Number(slot.exp ?? 0),
            evolution_level: Number(slot.evolution_level ?? 0),
            over_limit_step: Number(slot.over_limit_step ?? 0),
            mana_node_ids: []
        }
    }
    const equipment = (slot: any) => {
        const id = slot ? drawSimilar(equipmentPool, equipmentRarity(Number(slot.equipmentId)), random) : null
        return id === null ? null : { equipment_id: id, level: Number(slot.level ?? 1), enhancement_level: Number(slot.enhancementLevel ?? 0) }
    }

    const out: any[] = []
    for (let i = 0; i < count; i++) {
        out.push({
            com_id: firstComId + i,
            rank: Number(hostMate?.rank ?? 1),
            degree_id: DEFAULT_COMPANIONS[i % DEFAULT_COMPANIONS.length].degree_id,
            party: {
                characters: hostCharacters.map(character),
                unison_characters: hostUnison.map(character),
                equipments: hostEquipment.map(equipment),
                ability_soul_ids: hostSouls.map((soul: any) => soul ? drawSimilar(equipmentPool, equipmentRarity(Number(soul)), random) : null)
            }
        })
    }
    return out
}

/** Converts a summon-format party to the lobby (TypePacker) format the client uses in EnterComs. */
export function toMateParty(party: any): any {
    const some = (value: any) => value === null || value === undefined ? [1] : [0, value]
    const character = (c: any) => some(c && {
        id: c.id, exp: c.exp, evolution_level: c.evolution_level, over_limit_step: c.over_limit_step,
        mana_node_ids: c.mana_node_ids ?? [], ex_boost: c.ex_boost ? [0, c.ex_boost] : [1], illustration_settings: [1]
    })
    return {
        characters: (party.characters ?? []).map(character),
        unison_characters: (party.unison_characters ?? []).map(character),
        equipments: (party.equipments ?? []).map((e: any) => some(e && { equipmentId: e.equipment_id, level: e.level, enhancementLevel: e.enhancement_level })),
        abilitySoulIds: (party.ability_soul_ids ?? []).map(some),
        options: null
    }
}
