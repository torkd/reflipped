import { PlayerBoxGachaDrawnReward, UserRushEventPlayedParty } from "../data/types"

// enums
export enum RewardType {
    ITEM,
    EQUIPMENT,
    CHARACTER,
    BEADS,
    MANA,
    EXP
}

export enum BoxGachaRewardType {
    ITEM,
    EQUIPMENT,
    EMPTY,
    MANA,
    EXP,
    CHARACTER
}

export enum QuestCategory {
    EMPTY,
    MAIN, //
    BOSS_BATTLE, //
    CHARACTER, //
    EX, //
    EMPTY2,
    DAILY_WEEK_EVENT, //
    ADVENT_EVENT_SINGLE, //
    ADVENT_EVENT_MULTI, //
    TUTORIAL,
    STORY_EVENT_SINGLE, //?
    RANKING_EVENT_SINGLE, //?
    EMPTY3,
    CHALLENGE_DUNGEON_EVENT, //?
    DAILY_EXP_MANA_EVENT, //
    PRACTICE,
    SKILL_PREVIEW,
    EMPTY4,
    WORLD_STORY_EVENT, //
    WORLD_STORY_EVENT_BOSS_BATTLE, //
    TOWER_DUNGEON_EVENT, //?
    EXPERT_SINGLE_EVENT, //?
    CARNIVAL_EVENT, //?
    RAID_EVENT, //?
    RUSH_EVENT, //?
    SOLO_TIME_ATTACK_EVENT, //?
    HARD_MULTI_EVENT,
    SCORE_ATTACK_EVENT //?
}

export enum Element {
    FIRE,
    WATER,
    LIGHTNING,
    WIND,
    LIGHT,
    DARK
}

export enum ScoreRewardType {
    ITEM,
    RARE_POOL
}

export enum ShopItemRewardType {
    ITEM,
    EXP,
    MANA,
    CHARACTER,
    EQUIPMENT
}

export enum ShopItemUserCostType {
    BEADS,
    MANA,
    AMITY_SCROLL,
}

export enum ShopType {
    U0,
    U1,
    TREASURE,
    SPECIAL_PACK,
    EVENT_ITEM,
    U5,
    U6,
    BOSS_COIN,
    GENERAL,
    STAR_GRAIN,
    /** the augment shop (FT-54, src/lib/augmentShop.ts) */
    EQUIPMENT_ENHANCEMENT
}

export enum RushEventFolder {
    NONE,
    INTERMEDIATE,
    ADVANCED,
    GODLY,
    ENDLESS
}

// clear rewards
export interface Reward {
    name?: string,
    type: RewardType,
}

export interface EquipmentItemReward extends Reward {
    id: number,
    count: number
}

export interface CharacterReward extends Reward {
    id: number
}

export interface CurrencyReward extends Reward {
    count: number
}

export interface RareScoreReward extends Reward {
    rarity: number
}

export type ClearRewards = Record<string, Reward>

// score rewards
export interface ScoreReward {
    name: string,
    type: ScoreRewardType,
}

export interface CommonScoreReward extends ScoreReward {
    reward_type: RewardType
}

export interface CurrencyScoreReward extends CommonScoreReward {
    count: number
    field5: number
}

export interface ItemScoreReward extends CommonScoreReward {
    id: number,
    count: number,
    field5: number
}

export interface RareScoreRewardGroup extends ScoreReward {
    id: number,
    rarity: number
}

export type ScoreRewardGroups = Record<string, ScoreReward[]>

export type RareScoreRewardGroups = Record<string, Reward[]>

// shop rewards
export interface ShopItemReward {
    type: ShopItemRewardType,
}

export interface EquipmentItemShopItemReward extends ShopItemReward {
    id: number,
    count: number
}

export interface CharacterShopItemReward extends ShopItemReward {
    id: number
}

export interface CurrencyShopItemReward extends ShopItemReward {
    count: number
}

export interface RawQuest {
    name: string,
    clearRewardId?: number,
    sPlusRewardId?: number,
    scoreRewardGroup?: number,
    /** how many times the quest draws its score reward group's fixed items per battle (the master's own column) */
    scoreRewardRolls?: number | null,
    bRankTime?: number,
    aRankTime?: number,
    sRankTime?: number,
    sPlusRankTime?: number,
    rankPointReward?: number,
    characterExpReward?: number,
    manaReward?: number,
    poolExpReward?: number,
    fixedParty?: number,
    /** Boss battle master column 107, the client's battle_quest_rank. */
    questRankId?: number,
    rushEventId?: number
    rushEventFolderId?: number
    rushEventRound?: number
    /** a battle the player is meant to lose (main quest kind 2, LoseBattle): finished lost, it counts as cleared */
    loseBattle?: boolean
    /** the quest's enemy element (0-5), which picks the item of an element or aether reward (FT-26) */
    enemyElement?: number
    /** Hanifolk Carnival (FT-11): the quest's boss, its battle time limit and its difficulty's base score */
    folderId?: number
    timeLimitMs?: number
    difficultyScore?: number
    /** the Haunt (FT-6): the quest's cycle period, master dates (Japan time); the last cycles have no end */
    start?: string
    end?: string | null
    /** Solo Boss Challenges (FT-7) and Chrono Trials (FT-30): the quest's event, whose daily challenge point it spends */
    eventId?: number
    /** the quest's own daily challenge point (world story and story event quests, FT-30) */
    challengePointId?: number
    /** Solo Boss Challenges (FT-7): the player rank needed to start the quest */
    playerRank?: number
    /** the quest to clear first (the client's QuestReferenceIdKind code, multiplied id): expert quests (FT-7), challenge
     * dungeon quests (FT-8) */
    needQuest?: { kind: number, questId: number }
    /** items the quest takes on a clear (FT-8): every clear (`always`, the Treasure Zone's Golden Skull) or the first */
    useItems?: { always: boolean, items: { id: number, count: number }[] }
    /** the stamina a start takes (`battle_stamina_cost`, FT-25) */
    staminaCost?: number
    /** the quest's enemy level (`battle_enemy_level`): which collect item event drops it gives (FT-2) */
    enemyLevel?: number
}

export interface StoryQuest {
    name: string,
    clearReward?: Reward
}

export interface BattleQuest {
    name: string,
    clearReward?: Reward,
    sPlusReward?: Reward,
    scoreRewardGroupId?: number,
    scoreRewardRolls?: number,
    scoreRewardGroup?: ScoreReward[],
    bRankTime: number,
    aRankTime: number,
    sRankTime: number,
    sPlusRankTime: number,
    rankPointReward: number,
    characterExpReward: number,
    manaReward: number,
    poolExpReward: number,
    fixedParty?: number,
    /** Boss battle master column 107, the client's battle_quest_rank. */
    questRankId?: number,
    rushEventId?: number
    rushEventFolderId?: RushEventFolder
    rushEventRound?: number
    /** a battle the player is meant to lose (main quest kind 2, LoseBattle): finished lost, it counts as cleared */
    loseBattle?: boolean
    /** the quest's enemy element (0-5), which picks the item of an element or aether reward (FT-26) */
    enemyElement?: number
    /** the quest's event (Solo Boss Challenges, Chrono Trials) and its own daily challenge point (FT-30) */
    eventId?: number
    challengePointId?: number
    /** Hanifolk Carnival (FT-11): the quest's boss, its battle time limit and its difficulty's base score */
    folderId?: number
    timeLimitMs?: number
    difficultyScore?: number
    /** the quest to clear first (FT-7, FT-8) and the items it takes on a clear (FT-8) */
    needQuest?: { kind: number, questId: number }
    useItems?: { always: boolean, items: { id: number, count: number }[] }
    /** the stamina a start takes (`battle_stamina_cost`, FT-25) */
    staminaCost?: number
    /** the quest's enemy level (`battle_enemy_level`): which collect item event drops it gives (FT-2) */
    enemyLevel?: number
}

export type RawQuests = Record<string, RawQuest>

export interface AssetCharacter {
    name: string
    rarity: number,
    element: Element,
    skill_count: number
}

export type RawAssetCharacters = Record<string, AssetCharacter>

export interface AddExpListItem {
    character_id: number,
    add_exp: number,
    after_exp: number,
    add_exp_pool: number
}

export type AddExpList = AddExpListItem[]

export interface ClientReturnCharacter {
    character_id: number
    exp: number
    create_time: string
    update_time: string
    join_time: string
    exp_total: number
}

export interface ClientReturnBondTokenStatus {
    mana_board_index: number,
    status: number
}

export interface ClientReturnBondTokenStatusListItem {
    before: ClientReturnBondTokenStatus[]
    after: ClientReturnBondTokenStatus[]
}

export type ClientReturnBondTokenStatusList = Record<string, ClientReturnBondTokenStatusListItem>

export interface RewardPlayerCharacterExpResult {
    add_exp_list: AddExpList
    character_list: ClientReturnCharacter[]
    bond_token_status_list: ClientReturnBondTokenStatusList
    exp_pool: number
}

// quest types
export interface GivePlayerCharacterResult {
    character: Object,
    /** whether the player didn't own the character before (a duplicate stacks instead) */
    isNew: boolean,
    item?: {
        id: number,
        count: number
    }
}

export interface PlayerRewardResult {
    user_info: {
        free_mana: number
        free_vmoney: number
        exp_pool: number
    },
    character_list: Object[]
    joined_character_id_list: number[]
    equipment_list: Object[]
    items: Record<string, number>
}

export interface DropScoreRewardId {
    group_id: number,
    index: number,
    number: number
}

export interface GivePlayerScoreRewardsResult extends PlayerRewardResult {
    drop_score_reward_ids: DropScoreRewardId[]
    drop_rare_reward_ids: DropScoreRewardId[]
}

// mana nodes
export interface ManaNode {
    items: Record<string, number>,
    manaCost: number,
    field1: string,
    field5: string,
    field6: string
}

export type ManaNodes = Record<string, Record<string, Record<string, ManaNode>>>

// ex ability
export type ExAbilities = Record<string, number[]>

export type ExStatus = ExAbilities

export interface ExBoostItem {
    tier: number,
    count: number,
    element?: Element
}

export type ExBoostItems = Record<string, ExBoostItem>;

// box gachas
export enum BoxGachaRewardTier {
    COMMON,
    RARE,
    FEATURED
}

export interface BoxGachaReward {
    type: BoxGachaRewardType,
    count: number,
    available: number,
    tier: BoxGachaRewardTier,
}

export interface BoxGachaIdReward extends BoxGachaReward {
    id: number
}

export type BoxGachaBox = Record<string, BoxGachaReward>
export type BoxGachaBoxes = Record<string, BoxGachaBox>

export interface RawBoxGacha {
    itemId: number,
    count: number,
    availableCounts: Record<string, number>
}

export type RawBoxGachas = Record<string, RawBoxGacha>

export type RawBoxRewards = Record<string, BoxGachaBoxes>

export interface BoxGacha {
    redeemItemId: number,
    redeemItemCount: number,
    boxes: Record<string, BoxGachaBox>
    availableCounts: Record<string, number>
}

export interface BoxGachaDrawResult {
    rewards: PlayerBoxGachaDrawnReward[]
    mana: number
    exp: number
    characters: Map<number, number>
    equipment: Map<number, number>
    items: Map<number, number>
}

// gacha
export enum GachaType {
    CHARACTER,
    WEAPON
}

export enum GachaMovieType {
    NORMAL,
    GUARANTEE
}

export interface GachaPoolItem {
    id: number,
    rank: number,
    odds: number,
    isRateUp: boolean,
    rarity: number
}

export interface Gacha {
    type: GachaType,
    paymentType: number,
    singleCost: number,
    multiCost: number,
    discountCost: number,
    /** "YYYY-MM-DD HH:MM:SS", Japan time (read with `masterDate()`); open from `startDate` to `endDate`, both included */
    startDate: string,
    endDate: string,
    /**
     * The star weights from the portal's master rarity table (`gacha_odds/<rarity>`), by pool key ("1" 5 stars, "2" 4
     * stars, "3" 3 stars): 5 / 25 / 70 on most portals, 75 / 250 / 675 on festival ones
     */
    rankWeights: Record<string, number>,
    /** how many pulls of a 10-pull are guaranteed (1), and their least stars (4) */
    guaranteeNumber: number,
    guaranteeRarity: number,
    pool: Record<string, GachaPoolItem[]>
}

export interface CharacterGacha extends Gacha {
    movieName: string,
    guaranteeMovieName: string
}

export type Gachas = Record<string, Gacha>

export type GachaDrawResult = Map<number, number>

export interface RewardPlayerGachaDrawResult {
    draw: GachaDraws,
    characters: Object[],
    equipment: Object[],
    items: Record<number, number>
}

export interface GachaCharacterDraw {
    character_id: number,
    movie_id: string,
    seed: number,
    entry_count: number,
    ex_boost_item?: {
        id: number,
        count: number
    } | []
}

export interface GachaEquipmentDraw {
    equipment_id: number,
    treasure_up_type: number
}

export type GachaDraws = (GachaCharacterDraw | GachaEquipmentDraw)[]

export type GachaMovieSeeds = Record<string, Record<string, number[]>>

// shops
export interface ShopItemCost {
    id: number,
    amount: number
}

export interface ShopItemUserCost {
    type: ShopItemUserCostType
    amount: number
}

export interface ShopItem {
    costs: ShopItemCost[] | never[],
    rewards: ShopItemReward[] | never[],
    availableFrom: string,
    availableUntil: string | null,
    /** most bought in one purchase (`buy_max_count`) */
    buyMaxCount: number
    /** lowest player rank that may buy it */
    releaseRank?: number
    /** most bought ever (`max_frequency`) */
    maxFrequency?: number
    /** most bought per game day */
    dailyStock?: number
    /** most bought per game month */
    monthlyStock?: number
    /** sold only in these months (1-12) */
    specifiedMonths?: number[]
    userCost?: ShopItemUserCost
}

export interface EventItemShopIdMapItem {
    eventType: number
    eventId: number
}

export type ShopItems = Record<string, ShopItem>
export type BossCoinShopItems = Record<string, ShopItems>
export type EventShopItems = Record<string, BossCoinShopItems>

// rush event
export type RushEventFolders = Record<string, Record<string, Reward[]>>
export type SerializedPlayerRushEventPlayedPartyList = Record<number, UserRushEventPlayedParty>
export interface SerializedPlayerRushEventPlayedParties {
    folderParties: SerializedPlayerRushEventPlayedPartyList
    endlessParties: SerializedPlayerRushEventPlayedPartyList
}