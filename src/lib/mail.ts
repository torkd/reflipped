// Mail (gift box): sending mail to players and granting its contents on receive.

import { clientSerializeJapanDate } from "../data/utils";
import { DailyChallengePointListEntry, MailType, Player, PlayerMail, PlayerPeriodicRewardPoint } from "../data/types";
import { getAllPlayersSync, getPlayerItemSync, getPlayerMailHistorySync, getPlayerMailSync, insertPlayerDegreeSync, getPlayerReceivableMailCountSync, getPlayerSync, getReceivableMailCountsSync, givePlayerItemSync, insertPlayerMailSync, runInTransactionSync, setPlayerMailReceivedSync, trimPlayerMailHistorySync, updatePlayerSync, setPlayerDailyChallengePointSync, setPlayerPeriodicRewardPointSync, getPlayerDailyChallengePointListSync, getPlayerPeriodicRewardPointsSync } from "../data/wdfpData";
import { getServerDate, getServerTime } from "../utils";
import { gameDayOf, GAME_DAY_MS } from "./calendar";
import { getPlayableCharacterIds } from "./catalog";
import { getEquipmentMaxLevelSync } from "./assets";
import { getItemMaxCountSync, mailLimits, playerLimits } from "./limits";
import { getPlayerCharacterSync, getPlayerEquipmentSync } from "../data/wdfpData";
import { givePlayerCharacterSync } from "./character";
import { givePlayerEquipmentSync } from "./equipment";
import { isKnownDegree } from "./degrees";
import { requestClockOf, runOnPlayerClockSync } from "./playerClock";
import { getAllPlayerClocksSync, SERVER_CLOCK } from "../data/accountClocks";
import { runOnClock } from "./serverClock";
import { dailyChallengePointTotal, getDailyChallengePoint, getPeriodicRewardPoint, getPlayerDailyChallengePointSync, getPlayerPeriodicRewardPointValueSync, serializeDailyChallengePoints } from "./rewardPoints";
import { recordRewardMailSourceSync } from "../data/rewardMailSources";

// mail/index pages hold this many mails; the client's list pager is hardcoded to the same size.
export const mailPageSize = 100

// The client looks reason_id up in its mail reason master table first and only uses the mail's own
// subject and description when the id is missing there. Reflipped mail carries its own text, so it uses
// an id outside the table.
export const customMailReasonId = 0

// Mail types Reflipped can grant: every type the client has.
const supportedMailTypes = new Set<MailType>([
    MailType.ITEM,
    MailType.PAID_VMONEY,
    MailType.FREE_VMONEY,
    MailType.CHARACTER,
    MailType.EQUIPMENT,
    MailType.STAR_CRUMB,
    MailType.FREE_MANA,
    MailType.EXP_POOL,
    MailType.BOND_TOKEN,
    MailType.BOSS_BOOST_POINT,
    MailType.BOOST_POINT,
    MailType.DEGREE,
    MailType.DAILY_CHALLENGE_POINT,
    MailType.PERIODIC_REWARD_POINT
])

// Types the client requires a type_id for; every other type must not have one.
const typeIdMailTypes = new Set<MailType>([
    MailType.ITEM,
    MailType.CHARACTER,
    MailType.EQUIPMENT,
    MailType.DEGREE,
    MailType.DAILY_CHALLENGE_POINT,
    MailType.PERIODIC_REWARD_POINT
])

const playableCharacterIds = new Set(getPlayableCharacterIds())

/**
 * The most one mail can carry: what the client allows a player to own, since it can't grant more (and past
 * 2^31 its 32-bit arithmetic overflows). Items have their own limit each.
 */
export function maxMailNumber(type: MailType, typeId: number | null): number {
    switch (type) {
        case MailType.ITEM: return (typeId !== null ? getItemMaxCountSync(typeId) : null) ?? 0
        case MailType.CHARACTER: return playerLimits.unitCopies
        case MailType.EQUIPMENT: return playerLimits.equipmentCopies
        case MailType.PAID_VMONEY:
        case MailType.FREE_VMONEY: return playerLimits.virtualMoney
        case MailType.STAR_CRUMB: return playerLimits.starCrumb
        case MailType.FREE_MANA: return playerLimits.mana
        case MailType.EXP_POOL: return playerLimits.expPool
        case MailType.BOND_TOKEN: return playerLimits.bondToken
        case MailType.BOSS_BOOST_POINT: return playerLimits.bossBoostPoint
        case MailType.BOOST_POINT: return playerLimits.boostPoint
        // a title is owned or not
        case MailType.DEGREE: return 1
        case MailType.DAILY_CHALLENGE_POINT: return (typeId !== null ? getDailyChallengePoint(typeId)?.max : null) ?? 0
        case MailType.PERIODIC_REWARD_POINT: return (typeId !== null ? getPeriodicRewardPoint(typeId)?.max : null) ?? 0
        default: return 0
    }
}

// no control characters in the text (a line break is fine in the description)
const controlCharacters = /[\u0000-\u0009\u000b-\u001f\u007f]/

export interface SendMailOptions {
    type: MailType
    typeId?: number | null
    number: number
    subject: string
    description: string
    rewardLimitTime?: Date | null
    /** a row of the client's mail reason table (`master/mail/reason`), whose text then replaces subject and description */
    reasonId?: number
    /** Earned gameplay mail keeps its identity and receipt state through save replacement and history trimming. */
    durableReward?: boolean
}

/** A mail that can't be sent or imported as it is; the message says why (for the admin page). */
export class InvalidMailError extends Error { }

/** What a mail grants: the part of it the game checks. */
type MailContents = Pick<PlayerMail, "type" | "typeId" | "number">

/**
 * Checks that a mail grants something the game has, in an amount it can grant.
 *
 * @throws If the mail type, type ID or number is not valid (the message says why, for the admin page).
 */
export function checkMailContents(mail: MailContents): void {
    const typeId = mail.typeId
    if (!supportedMailTypes.has(mail.type)) throw new InvalidMailError(`Unsupported mail type ${mail.type}.`);
    if (typeIdMailTypes.has(mail.type) !== (typeId !== null)) throw new InvalidMailError(`Mail type ${mail.type} ${typeIdMailTypes.has(mail.type) ? "needs" : "takes no"} type ID.`);
    if (!Number.isInteger(mail.number) || mail.number <= 0) throw new InvalidMailError("Mail number must be a positive integer.");
    // 7xxxxx event and guest units break the client's unit list (C8601), so only playable units
    if (mail.type === MailType.CHARACTER && !playableCharacterIds.has(typeId!)) throw new InvalidMailError(`${typeId} is not a playable unit.`);
    // ids the game has no data for crash the client's lists (C8601)
    if (mail.type === MailType.ITEM && getItemMaxCountSync(typeId!) === null) throw new InvalidMailError(`${typeId} is not an item the game has.`);
    if (mail.type === MailType.EQUIPMENT && getEquipmentMaxLevelSync(typeId!) === null) throw new InvalidMailError(`${typeId} is not an armament the game has.`);
    if (mail.type === MailType.DEGREE && !isKnownDegree(typeId!)) throw new InvalidMailError(`${typeId} is not a title the game has.`);
    // the client looks these up in its master tables and throws on a missing row
    if (mail.type === MailType.DAILY_CHALLENGE_POINT && getDailyChallengePoint(typeId!) === null) throw new InvalidMailError(`${typeId} is not a daily challenge point the game has.`);
    if (mail.type === MailType.PERIODIC_REWARD_POINT && getPeriodicRewardPoint(typeId!) === null) throw new InvalidMailError(`${typeId} is not a periodic reward point the game has.`);
    const max = maxMailNumber(mail.type, typeId)
    if (mail.number > max) throw new InvalidMailError(`A mail of this kind can carry at most ${max}; the game can't grant more.`);
}

/**
 * Checks a mail's own text. Null is allowed for mail stored without text (it then shows its reason's text).
 *
 * @throws If the subject or description is too long, empty (the subject) or has control characters.
 */
export function checkMailText(subject: string | null, description: string | null): void {
    if (subject !== null && (typeof subject !== "string" || subject.trim() === "" || subject.length > mailLimits.subjectLength || controlCharacters.test(subject)))
        throw new InvalidMailError(`The subject must be 1 to ${mailLimits.subjectLength} characters without control characters.`);
    if (description !== null && (typeof description !== "string" || description.length > mailLimits.descriptionLength || controlCharacters.test(description)))
        throw new InvalidMailError(`The description must be at most ${mailLimits.descriptionLength} characters without control characters.`);
}

/** Mail can't expire past this year; a later date is a typo. */
const latestMailYear = 2100

/** Checks everything about a mail to send that doesn't depend on the player. */
function checkSendMailOptions(options: SendMailOptions): void {
    checkMailContents({ type: options.type, typeId: options.typeId ?? null, number: options.number })
    if (typeof options.subject !== "string" || typeof options.description !== "string") throw new InvalidMailError("The mail needs a subject and a description.");
    checkMailText(options.subject, options.description)
    if (options.rewardLimitTime && options.rewardLimitTime.getUTCFullYear() > latestMailYear) throw new InvalidMailError("The expiry date is too far away.");
}

/** Whether a mail to send has expired at `now` (a player's "now"): it would arrive in the box already past receiving. */
function hasExpired(options: SendMailOptions, now: Date): boolean {
    return options.rewardLimitTime != null && options.rewardLimitTime.getTime() <= now.getTime()
}

function insertSendMailSync(playerId: number, options: SendMailOptions): number {
    return runInTransactionSync(() => {
        const id = insertPlayerMailSync(playerId, {
            type: options.type,
            typeId: options.typeId ?? null,
            number: options.number,
            reasonId: options.reasonId ?? customMailReasonId,
            subject: options.subject,
            description: options.description,
            createTime: getServerDate(),
            receiveTime: null,
            rewardLimitTime: options.rewardLimitTime ?? null
        })
        if (options.durableReward) recordRewardMailSourceSync(playerId, id)
        return id
    })
}

/**
 * Sends a mail to a player's gift box. It is dated, and its limits checked, on the player's clock (FT-5), as if the
 * player's own request had sent it.
 *
 * @param playerId The ID of the player.
 * @param options What the mail contains.
 * @returns The new mail's ID.
 * @throws If the mail type, type ID or number is not valid.
 */
export function sendPlayerMailSync(
    playerId: number,
    options: SendMailOptions
): number {
    checkSendMailOptions(options)
    return runOnPlayerClockSync(playerId, () => {
        if (hasExpired(options, getServerDate())) throw new InvalidMailError("The expiry date has passed on this player's clock: the mail could never be received.");
        if (getPlayerReceivableMailCountSync(playerId, getServerDate()) >= mailLimits.pendingMails) throw new InvalidMailError(`The gift box is full (${mailLimits.pendingMails} mails waiting).`);
        return insertSendMailSync(playerId, options)
    })
}

export interface SendToAllResult {
    /** players on the server */
    players: number
    sent: number
    /** players whose gift box was full */
    skippedFull: number
    /** players the mail would take past what the game lets them own */
    skippedLimit: number
    /** players on whose clock the mail's expiry date has passed already */
    skippedExpired: number
}

/**
 * Sends the same mail to every player, in one transaction. A player whose gift box is full, whom the mail would take
 * past a limit with what they own now, or on whose clock its expiry date has passed, is skipped and counted: a mail
 * like that would only wait in the box (the client can't receive it). Players created later don't get it. Each mail
 * is dated on its player's clock (FT-5).
 *
 * @throws If the mail isn't valid; nothing is sent then.
 */
export function sendMailToAllPlayersSync(options: SendMailOptions): SendToAllResult {
    checkSendMailOptions(options)
    const contents: MailContents = { type: options.type, typeId: options.typeId ?? null, number: options.number }
    return runInTransactionSync(() => {
        const now = getServerDate()
        // one query for every gift box, rather than one per player
        const pending = getReceivableMailCountsSync(now)
        const players = getAllPlayersSync(0, Number.MAX_SAFE_INTEGER)
        // and one for every player's clock
        const clocks = getAllPlayerClocksSync()
        const result: SendToAllResult = { players: players.length, sent: 0, skippedFull: 0, skippedLimit: 0, skippedExpired: 0 }
        for (const player of players) {
            const clock = clocks.get(player.id) ?? SERVER_CLOCK
            runOnClock(requestClockOf(clock), () => {
                // what has expired depends on the player's clock, so a player off the server clock is counted alone
                const waiting = clock.offsetDays !== 0
                    ? getPlayerReceivableMailCountSync(player.id, getServerDate())
                    : pending.get(player.id) ?? 0
                if (hasExpired(options, getServerDate())) {
                    result.skippedExpired++
                } else if (waiting >= mailLimits.pendingMails) {
                    result.skippedFull++
                } else if (wouldExceedLimit(player.id, contents, player)) {
                    result.skippedLimit++
                } else {
                    insertSendMailSync(player.id, options)
                    result.sent++
                }
            })
        }
        return result
    })
}

/**
 * Serializes a mail into the entry format of the mail/index response. Its times are Japan time.
 *
 * @param mail The mail to serialize.
 * @returns The serialized mail.
 */
export function clientSerializeMail(
    mail: PlayerMail
): Object {
    return {
        "id": mail.id,
        "type": mail.type,
        "type_id": mail.typeId,
        "number": mail.number,
        "reason_id": mail.reasonId,
        "subject": mail.subject,
        "description": mail.description,
        "create_time": clientSerializeJapanDate(mail.createTime),
        // the client treats this exact value as "not received"
        "receive_time": mail.receiveTime === null ? "0000-00-00 00:00:00" : clientSerializeJapanDate(mail.receiveTime),
        "reward_limit_time": mail.rewardLimitTime === null ? null : clientSerializeJapanDate(mail.rewardLimitTime),
        "reward_period_limited": mail.rewardLimitTime !== null
    }
}

// history/receive pages: the client's pager holds 100 (VerticalListPagerConfig), like the capture's first page
export const mailHistoryPageSize = 100

/**
 * How far back the history goes: the client's footer says it shows "the latest 500 received within 1 week"
 * (`receive_history_footer_notice`). Older received mail stays stored (and in a save) up to `mailLimits.historyMails`.
 */
const mailHistoryDays = 7

/**
 * The history at `now` (the player's clock), most recently received first: the mail received in the week up to now,
 * since the clock last went back to an earlier game day. The order is the order of receipt (`receive_seq`), not the
 * receive dates, which go back with the clock (a calendar wrap, a player clock, Reset). Walking back through the
 * receipts, a mail received on a later game day than the one received after it, or than today, was received before
 * the clock went back: it and everything older is left out, so the history starts over after each jump back like
 * the eras do (src/lib/serverClock.ts) and never shows a stretch of the loop that has not come round again. A mail
 * from today dated after now (the clock went back within the day) is left out too.
 */
export function listMailHistorySync(playerId: number, now: Date): PlayerMail[] {
    const since = now.getTime() - mailHistoryDays * GAME_DAY_MS
    const listed: PlayerMail[] = []
    let laterDay = gameDayOf(now.getTime())
    // at most mailLimits.historyMails rows are kept, so reading them all is cheap
    for (const mail of getPlayerMailHistorySync(playerId, 0, mailLimits.historyMails)) {
        const time = (mail.receiveTime ?? mail.createTime).getTime()
        const day = gameDayOf(time)
        if (day > laterDay) break
        laterDay = day
        if (since <= time && time <= now.getTime()) listed.push(mail)
    }
    return listed
}

/**
 * Serializes a received mail into the entry format of the history/receive response. The capture's times are Japan
 * time (its newest entry is 4 minutes before the reply's `servertime` in UTC+9) and are the receive time: each claim
 * shares one time across mails created at different moments. Every captured entry carries `"null": 1`, which the
 * client ignores; it is kept as captured. The client shows the reason table's text, and for a reason missing there
 * (Reflipped's own mail, reason 0) the mail's subject and description, so those are sent too.
 *
 * @param mail A received mail.
 * @returns The serialized history entry.
 */
export function clientSerializeMailHistory(
    mail: PlayerMail
): Object {
    return {
        "null": 1,
        "reason_id": mail.reasonId,
        "type": mail.type,
        "type_id": mail.typeId,
        "number": mail.number,
        "subject": mail.subject,
        "description": mail.description,
        "create_time": clientSerializeJapanDate(mail.receiveTime ?? mail.createTime)
    }
}

/**
 * The daily challenge and periodic reward points a mail receive changed, as the mail/receive replies send them: the
 * client upserts both lists by id, so only the changed entries go out, and only when there are any.
 */
export function rewardPointReplyFields(result: ReceiveMailsResult): Record<string, Object[]> {
    const fields: Record<string, Object[]> = {}
    if (result.dailyChallengePointList.length > 0) fields["user_daily_challenge_point_list"] = serializeDailyChallengePoints(result.dailyChallengePointList)
    if (result.periodicRewardPointList.length > 0) fields["user_periodic_reward_point_list"] = result.periodicRewardPointList.map(entry => ({ "id": entry.id, "point": entry.point }))
    return fields
}

export interface ReceiveMailsResult {
    receivedMailIds: number[]
    deletedMailCount: number // not found
    alreadyMailCount: number // already received
    outdatedMailCount: number // past its reward_limit_time
    maxOveredMailCount: number // left in the box: the player would pass the game's limit for it
    userInfo: Record<string, number>
    characterList: Object[]
    equipmentList: Object[]
    itemList: Record<string, number>
    /** the daily challenge and periodic reward points that changed */
    dailyChallengePointList: DailyChallengePointListEntry[]
    periodicRewardPointList: PlayerPeriodicRewardPoint[]
    remainingCount: number
}

/** The balances a mail can add to (a `Player` has them all). */
type MailBalances = Pick<Player, "vmoney" | "freeVmoney" | "starCrumb" | "freeMana" | "expPool" | "bondToken" | "bossBoostPoint" | "boostPoint">

/** Whether granting a mail would take the player past what the game lets them own. */
function wouldExceedLimit(
    playerId: number,
    mail: MailContents,
    balances: MailBalances
): boolean {
    const typeId = mail.typeId
    switch (mail.type) {
        case MailType.ITEM: {
            const max = getItemMaxCountSync(typeId!)
            return max === null || (getPlayerItemSync(playerId, typeId!) ?? 0) + mail.number > max
        }
        case MailType.EQUIPMENT: {
            const owned = getPlayerEquipmentSync(playerId, typeId!)
            return getEquipmentMaxLevelSync(typeId!) === null || (owned === null ? 0 : owned.stack + 1) + mail.number > playerLimits.equipmentCopies
        }
        case MailType.CHARACTER: {
            const owned = getPlayerCharacterSync(playerId, typeId!)
            return (owned === null ? 0 : owned.stack + 1) + mail.number > playerLimits.unitCopies
        }
        case MailType.PAID_VMONEY:
        case MailType.FREE_VMONEY: return balances.vmoney + balances.freeVmoney + mail.number > playerLimits.virtualMoney
        case MailType.STAR_CRUMB: return balances.starCrumb + mail.number > playerLimits.starCrumb
        case MailType.FREE_MANA: return balances.freeMana + mail.number > playerLimits.mana
        case MailType.EXP_POOL: return balances.expPool + mail.number > playerLimits.expPool
        case MailType.BOND_TOKEN: return balances.bondToken + mail.number > playerLimits.bondToken
        case MailType.BOSS_BOOST_POINT: return balances.bossBoostPoint + mail.number > playerLimits.bossBoostPoint
        case MailType.BOOST_POINT: return balances.boostPoint + mail.number > playerLimits.boostPoint
        // the client's own check: point plus open campaigns plus the mail within max_challenge_point
        case MailType.DAILY_CHALLENGE_POINT: {
            const max = getDailyChallengePoint(typeId!)?.max
            return max === undefined || dailyChallengePointTotal(getPlayerDailyChallengePointSync(playerId, typeId!), typeId!, getServerDate()) + mail.number > max
        }
        // the client doesn't check these; the server keeps them within max_reward_point
        case MailType.PERIODIC_REWARD_POINT: {
            const max = getPeriodicRewardPoint(typeId!)?.max
            return max === undefined || getPlayerPeriodicRewardPointValueSync(playerId, typeId!) + mail.number > max
        }
        default: return false
    }
}

/**
 * Receives mails: grants their contents and marks them received.
 * Mails that don't exist, were already received or have expired are skipped and counted.
 *
 * @param playerId The ID of the player.
 * @param mailIds The IDs of the mails to receive.
 * @returns What was received, in the shape the mail/receive responses need.
 */
export function receivePlayerMailsSync(
    playerId: number,
    mailIds: number[]
): ReceiveMailsResult | null {
    const player = getPlayerSync(playerId)
    if (player === null) return null

    const now = getServerDate()
    const result: ReceiveMailsResult = {
        receivedMailIds: [],
        deletedMailCount: 0,
        alreadyMailCount: 0,
        outdatedMailCount: 0,
        maxOveredMailCount: 0,
        userInfo: {},
        characterList: [],
        equipmentList: [],
        itemList: {},
        dailyChallengePointList: [],
        periodicRewardPointList: [],
        remainingCount: 0
    }

    const characters: Map<number, Object> = new Map()
    const equipment: Map<number, Object> = new Map()
    const itemIds: Set<number> = new Set()
    const dailyChallengePointIds: Set<number> = new Set()
    const periodicRewardPointIds: Set<number> = new Set()
    const balances: MailBalances = {
        vmoney: player.vmoney,
        freeVmoney: player.freeVmoney,
        starCrumb: player.starCrumb,
        freeMana: player.freeMana,
        expPool: player.expPool,
        bondToken: player.bondToken,
        bossBoostPoint: player.bossBoostPoint,
        boostPoint: player.boostPoint
    }

    for (const mailId of new Set(mailIds)) {
        const mail = getPlayerMailSync(playerId, mailId)
        if (mail === null) {
            result.deletedMailCount++
            continue
        }
        if (mail.receiveTime !== null) {
            result.alreadyMailCount++
            continue
        }
        if (mail.rewardLimitTime !== null && mail.rewardLimitTime <= now) {
            result.outdatedMailCount++
            continue
        }

        // The client only receives mail that fits (owned + amount <= max) and the server answers the same:
        // a mail that would go past a limit stays in the box and is counted in max_overed_mail_count.
        if (wouldExceedLimit(playerId, mail, balances)) {
            result.maxOveredMailCount++
            continue
        }

        switch (mail.type) {
            case MailType.ITEM:
                givePlayerItemSync(playerId, mail.typeId!, mail.number)
                itemIds.add(mail.typeId!)
                break;
            case MailType.EQUIPMENT:
                equipment.set(mail.typeId!, givePlayerEquipmentSync(playerId, mail.typeId!, mail.number))
                break;
            case MailType.CHARACTER:
                for (let i = 0; i < mail.number; i++) {
                    const giveResult = givePlayerCharacterSync(playerId, mail.typeId!)
                    if (giveResult?.character !== undefined) characters.set(mail.typeId!, giveResult.character)
                    if (giveResult?.item !== undefined) itemIds.add(giveResult.item.id)
                }
                break;
            case MailType.PAID_VMONEY: balances.vmoney += mail.number; break;
            case MailType.FREE_VMONEY: balances.freeVmoney += mail.number; break;
            case MailType.STAR_CRUMB: balances.starCrumb += mail.number; break;
            case MailType.FREE_MANA: balances.freeMana += mail.number; break;
            case MailType.EXP_POOL: balances.expPool += mail.number; break;
            case MailType.BOND_TOKEN: balances.bondToken += mail.number; break;
            case MailType.BOSS_BOOST_POINT: balances.bossBoostPoint += mail.number; break;
            case MailType.BOOST_POINT: balances.boostPoint += mail.number; break;
            // a title the player owns already is received all the same
            case MailType.DEGREE: insertPlayerDegreeSync(playerId, mail.typeId!); break;
            case MailType.DAILY_CHALLENGE_POINT:
                setPlayerDailyChallengePointSync(playerId, mail.typeId!, (getPlayerDailyChallengePointSync(playerId, mail.typeId!)?.point ?? 0) + mail.number)
                dailyChallengePointIds.add(mail.typeId!)
                break;
            case MailType.PERIODIC_REWARD_POINT:
                setPlayerPeriodicRewardPointSync(playerId, mail.typeId!, getPlayerPeriodicRewardPointValueSync(playerId, mail.typeId!) + mail.number)
                periodicRewardPointIds.add(mail.typeId!)
                break;
            default:
                // a type the client doesn't have (sending refuses it); leave it in the box
                continue
        }

        setPlayerMailReceivedSync(playerId, mail.id, now)
        result.receivedMailIds.push(mail.id)
    }

    updatePlayerSync({ id: playerId, ...balances })
    // the history keeps the mails received last only
    if (result.receivedMailIds.length > 0) trimPlayerMailHistorySync(playerId, mailLimits.historyMails)

    result.userInfo = {
        "vmoney": balances.vmoney,
        "free_vmoney": balances.freeVmoney,
        "star_crumb": balances.starCrumb,
        "free_mana": balances.freeMana,
        "exp_pool": balances.expPool,
        // The client shows exp_pool + the exp gained since exp_pooled_time on its clock, which is the
        // server clock. The stored time is a real date, later than the default 2025 clock, so sending it
        // makes the elapsed time negative and the client clamps the pool to 0. Send what /load sends.
        "exp_pooled_time": getServerTime(player.expPooledTime),
        "bond_token": balances.bondToken,
        "boss_boost_point": balances.bossBoostPoint,
        "boost_point": balances.boostPoint
    }
    result.characterList = [...characters.values()]
    result.equipmentList = [...equipment.values()]
    for (const itemId of itemIds) {
        result.itemList[itemId] = getPlayerItemSync(playerId, itemId) ?? 0
    }
    result.dailyChallengePointList = getPlayerDailyChallengePointListSync(playerId).filter(entry => dailyChallengePointIds.has(entry.id))
    result.periodicRewardPointList = getPlayerPeriodicRewardPointsSync(playerId).filter(entry => periodicRewardPointIds.has(entry.id))
    result.remainingCount = getPlayerReceivableMailCountSync(playerId, now)

    return result
}
