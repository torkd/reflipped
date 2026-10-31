// Mail (gift box): sending mail to players and granting its contents on receive.

import { clientSerializeDate } from "../data/utils";
import { MailType, PlayerMail } from "../data/types";
import { getPlayerItemSync, getPlayerMailSync, insertPlayerDegreeSync, getPlayerReceivableMailCountSync, getPlayerSync, givePlayerItemSync, insertPlayerMailSync, setPlayerMailReceivedSync, updatePlayerSync } from "../data/wdfpData";
import { getServerDate, getServerTime } from "../utils";
import { getPlayableCharacterIds } from "./catalog";
import { getEquipmentMaxLevelSync } from "./assets";
import { getItemMaxCountSync, mailLimits, playerLimits } from "./limits";
import { getPlayerCharacterSync, getPlayerEquipmentSync } from "../data/wdfpData";
import { givePlayerCharacterSync } from "./character";
import { givePlayerEquipmentSync } from "./equipment";
import { isKnownDegree } from "./degrees";

// mail/index pages hold this many mails; the client's list pager is hardcoded to the same size.
export const mailPageSize = 100

// The client looks reason_id up in its mail reason master table first and only uses the mail's own
// subject and description when the id is missing there. Reflipped mail carries its own text, so it uses
// an id outside the table.
export const customMailReasonId = 0

// Mail types Reflipped can grant. DAILY_CHALLENGE_POINT and PERIODIC_REWARD_POINT are valid in the client
// but have no storage on the server yet.
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
    MailType.DEGREE
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
}

/**
 * Sends a mail to a player's gift box.
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
    const typeId = options.typeId ?? null
    if (!supportedMailTypes.has(options.type)) throw new Error(`Unsupported mail type ${options.type}.`);
    if (typeIdMailTypes.has(options.type) !== (typeId !== null)) throw new Error(`Mail type ${options.type} ${typeIdMailTypes.has(options.type) ? "needs" : "takes no"} type ID.`);
    if (!Number.isInteger(options.number) || options.number <= 0) throw new Error("Mail number must be a positive integer.");
    // 7xxxxx event and guest units break the client's unit list (C8601), so only playable units
    if (options.type === MailType.CHARACTER && !playableCharacterIds.has(typeId!)) throw new Error(`${typeId} is not a playable unit.`);
    // ids the game has no data for crash the client's lists (C8601)
    if (options.type === MailType.ITEM && getItemMaxCountSync(typeId!) === null) throw new Error(`${typeId} is not an item the game has.`);
    if (options.type === MailType.EQUIPMENT && getEquipmentMaxLevelSync(typeId!) === null) throw new Error(`${typeId} is not an armament the game has.`);
    if (options.type === MailType.DEGREE && !isKnownDegree(typeId!)) throw new Error(`${typeId} is not a title the game has.`);
    const max = maxMailNumber(options.type, typeId)
    if (options.number > max) throw new Error(`A mail of this kind can carry at most ${max}; the game can't grant more.`);

    if (typeof options.subject !== "string" || options.subject.trim() === "" || options.subject.length > mailLimits.subjectLength || controlCharacters.test(options.subject))
        throw new Error(`The subject must be 1 to ${mailLimits.subjectLength} characters without control characters.`);
    if (typeof options.description !== "string" || options.description.length > mailLimits.descriptionLength || controlCharacters.test(options.description))
        throw new Error(`The description must be at most ${mailLimits.descriptionLength} characters without control characters.`);
    if (options.rewardLimitTime && options.rewardLimitTime.getFullYear() > 2100) throw new Error("The expiry date is too far away.");
    if (getPlayerReceivableMailCountSync(playerId, getServerDate()) >= mailLimits.pendingMails) throw new Error(`The gift box is full (${mailLimits.pendingMails} mails waiting).`);

    return insertPlayerMailSync(playerId, {
        type: options.type,
        typeId: typeId,
        number: options.number,
        reasonId: options.reasonId ?? customMailReasonId,
        subject: options.subject,
        description: options.description,
        createTime: getServerDate(),
        receiveTime: null,
        rewardLimitTime: options.rewardLimitTime ?? null
    })
}

/**
 * Serializes a mail into the entry format of the mail/index response.
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
        "create_time": clientSerializeDate(mail.createTime),
        // the client treats this exact value as "not received"
        "receive_time": mail.receiveTime === null ? "0000-00-00 00:00:00" : clientSerializeDate(mail.receiveTime),
        "reward_limit_time": mail.rewardLimitTime === null ? null : clientSerializeDate(mail.rewardLimitTime),
        "reward_period_limited": mail.rewardLimitTime !== null
    }
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
    remainingCount: number
}

/** Whether granting a mail would take the player past what the game lets them own. */
function wouldExceedLimit(
    playerId: number,
    mail: PlayerMail,
    balances: { vmoney: number, freeVmoney: number, starCrumb: number, freeMana: number, expPool: number, bondToken: number, bossBoostPoint: number, boostPoint: number }
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
        remainingCount: 0
    }

    const characters: Map<number, Object> = new Map()
    const equipment: Map<number, Object> = new Map()
    const itemIds: Set<number> = new Set()
    const balances = {
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
            default:
                // not grantable yet (see supportedMailTypes); leave it in the box
                continue
        }

        setPlayerMailReceivedSync(playerId, mail.id, now)
        result.receivedMailIds.push(mail.id)
    }

    updatePlayerSync({ id: playerId, ...balances })

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
    result.remainingCount = getPlayerReceivableMailCountSync(playerId, now)

    return result
}
