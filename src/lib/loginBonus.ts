// FT-3: /load earns login gifts. bonus/shown acknowledges their presentation, never grants again.
// FT-24: the conditional calendars. Comeback goes to players with no login during the master's condition window (new
// players too when includeBeginner is set); ActiveUser to everyone its comeback group (comebackGroupId) doesn't take;
// ComebackAlways to a player back after COMEBACK_ABSENCE_DAYS away, whatever the date. Who the one-off Comeback
// calendars take is the owner's choice (FT-65, src/lib/comebackRule.ts). Sources in docs/login-rewards.md.
import getDatabase, { Database } from "../data";
import { LoginBonusGroup, LoginBonusGroupType, LoginBonusReward, loginBonusGroups } from "../data/loginBonusData";
import { MailType } from "../data/types";
import { getPlayerReceivableMailCountSync, runInTransactionSync } from "../data/wdfpData";
import { getServerDate, masterDate } from "../utils";
import { mailLimits } from "./limits";
import { InvalidMailError, SendMailOptions, sendPlayerMailSync } from "./mail";
import { isContentPeriodOpen, contentDate, currentEventOccurrenceKey, currentRunSpeed, getEventScheduleView, scheduledContentEnabled, scheduledMasterTime } from "./eventSchedule";
import { GAME_DAY_MS, gameDayOf } from "./calendar";
import { scaleEarnedMailAmount } from "./rewardPolicy";
import { gameDay } from "./resets";
import { ComebackRule, getComebackRule, GLOBAL_COMEBACK_ABSENCE, OPEN_COMEBACK_GROUPS } from "./comebackRule";

const db = getDatabase(Database.WDFP_DATA)

/**
 * Days away after which a returning player gets the permanent comeback present (ComebackAlways). The master holds no
 * threshold; Japan's "welcome back bonus" went to players who hadn't logged in for 60 days or more since their
 * previous login (2nd anniversary broadcast, https://gameo.jp/worldflipper/16451).
 */
export const COMEBACK_ABSENCE_DAYS = 60
const DAY_MS = 24 * 60 * 60 * 1000

export interface LoginBonusIndex {
    bonus_group_id: string
    bonus_group_type: LoginBonusGroupType
    index: number
}

export interface LoginBonusesResult {
    bonusIndexList: LoginBonusIndex[]
    loginBonusReceivedAt: number | null
    mailArrived: boolean
}

interface Receipt {
    id: number
    group_id: string
    bonus_index: number
    received_at: number
    reward_json: string
    mailed_rewards: number
    shown: number
}

/** A group's current calendar occurrence. Dates and annual windows use Japan time, like the client. */
export function loginBonusPeriod(group: LoginBonusGroup, date: Date): { key: string } | null {
    const period = loginBonusOccurrence(group, date)
    return period === null ? null : { key: period.key }
}

/** The occurrence with the master time it opens at (Limited ladders pace their entries from it, FT-32). */
function loginBonusOccurrence(group: LoginBonusGroup, date: Date): { key: string, start?: number } | null {
    const time = contentDate(date).getTime()
    const open = (start: number | undefined, end: number | undefined) => scheduledContentEnabled()
        ? isContentPeriodOpen(start, end, date)
        : isContentPeriodOpen(start, end === undefined ? undefined : end + 1000, date, false)
    if (!open(group.startDate === null ? undefined : masterDate(group.startDate).getTime(),
        group.endDate === null ? undefined : masterDate(group.endDate).getTime())) return null
    if (group.annualStart === null || group.annualEnd === null) return { key: "once", start: group.startDate === null ? undefined : masterDate(group.startDate).getTime() }

    const year = new Date(time + 9 * 60 * 60 * 1000).getUTCFullYear()
    // Testing the previous year also handles a season that crosses New Year.
    for (const startYear of [year - 1, year]) {
        const start = masterDate(`${startYear}-${group.annualStart}`).getTime()
        let end = masterDate(`${startYear}-${group.annualEnd}`).getTime()
        if (end < start) end = masterDate(`${startYear + 1}-${group.annualEnd}`).getTime()
        if (open(start, end)) return { key: `annual:${startYear}`, start }
    }
    return null
}

/**
 * A Comeback group's condition window (conditionStart to conditionEnd, the master's last second included) on the
 * server's clock. With event scheduling it is projected like the campaign's own period, so it keeps its place before
 * the projected campaign. Where the global server used its own rule (GLOBAL_COMEBACK_ABSENCE, src/lib/comebackRule.ts)
 * the window runs from that date until this login.
 */
function conditionWindow(group: LoginBonusGroup, date: Date): { from: number, to: number } | null {
    const project = (time: number) => scheduledContentEnabled() ? scheduledMasterTime(time, getEventScheduleView(date.getTime())) : time
    const global = GLOBAL_COMEBACK_ABSENCE[group.id]
    if (global !== undefined) return { from: project(masterDate(global.since).getTime()), to: date.getTime() }
    if (group.conditionStart === null || group.conditionEnd === null) return null
    const start = masterDate(group.conditionStart).getTime()
    const end = masterDate(group.conditionEnd).getTime()
    return { from: project(start), to: project(end) + 1000 }
}

/**
 * What the server knows of a player's past logins: the login before this one (players.last_login_time before /load
 * updated it) and every login-bonus receipt, one per login game day. Read before this login earns anything.
 */
interface LoginHistory {
    /** whether the player logged in at any time in [from, to) */
    loggedInBetween(from: number, to: number): boolean
    /** the latest login known, for the absence of ComebackAlways */
    lastLogin: number
}

function loginHistory(playerId: number, previousLogin: Date): LoginHistory {
    const previous = previousLogin.getTime()
    const latest = db.prepare(`SELECT MAX(received_at) AS latest FROM players_login_bonus_receipts WHERE player_id = ?`)
        .get(playerId) as { latest: number | null }
    return {
        lastLogin: Math.max(previous, (latest.latest ?? 0) * 1000),
        loggedInBetween: (from, to) => (previous >= from && previous < to)
            || db.prepare(`SELECT 1 FROM players_login_bonus_receipts WHERE player_id = ? AND received_at >= ? AND received_at < ? LIMIT 1`)
                .get(playerId, Math.ceil(from / 1000), Math.ceil(to / 1000)) !== undefined
    }
}

/** Whether a login at `date` comes after COMEBACK_ABSENCE_DAYS or more without one (see isReturningLoginSync). */
function returnsAfterAbsence(history: LoginHistory, date: Date): boolean {
    return date.getTime() - history.lastLogin >= COMEBACK_ABSENCE_DAYS * DAY_MS
}

/**
 * Whether a login at `date` returns after COMEBACK_ABSENCE_DAYS or more away: the login before it (`previousLogin`,
 * players.last_login_time before /load updates it) and the latest login the server recorded (login-bonus receipts,
 * which a save import keeps) are both that old. The comeback present uses it, and the Welcome Back Portals can (FT-62).
 * Call it before the login earns anything: earning adds receipts.
 */
export function isReturningLoginSync(playerId: number, date: Date, previousLogin: Date): boolean {
    return returnsAfterAbsence(loginHistory(playerId, previousLogin), date)
}

/**
 * When the player last returned (a login isReturningLoginSync accepted), as the comeback present's receipt recorded it,
 * or null. Japan's comeback portal stayed open for 3 days from that login (https://gameo.jp/worldflipper/16451).
 * Every return is recorded, whatever the date (the present ignores its master period, FT-65).
 */
export function latestReturnSync(playerId: number): Date | null {
    const ids = loginBonusGroups.filter(group => group.groupType === "ComebackAlways").map(group => group.id)
    if (ids.length === 0) return null
    const row = db.prepare(`SELECT received_at FROM players_login_bonus_receipts
        WHERE player_id = ? AND group_id IN (${ids.map(() => "?").join(", ")}) AND period_key LIKE 'return:%'
        ORDER BY received_at DESC, id DESC LIMIT 1`).get(playerId, ...ids) as { received_at: number } | undefined
    return row === undefined ? null : new Date(row.received_at * 1000)
}

/**
 * Whether a Comeback group takes the player: no login during its condition window (Japan's 3rd anniversary "Hello
 * 10K" login bonus: "players who didn't log in from 1 October 5:00 to 20 November 4:59", new players included;
 * Kakao's "Welcome Back Login Perks": returning players only). A login in the window rules the player out, even a
 * first one; a player with no login before the window either is new: taken only when the group includes beginners.
 * comeback_01's master window lasts one hour; the global server's rule replaces it (conditionWindow). With the
 * owner's "everyone" rule, the calendars of OPEN_COMEBACK_GROUPS take every player.
 */
function comebackEligible(group: LoginBonusGroup, date: Date, history: LoginHistory, rule: ComebackRule): boolean {
    if (rule === "everyone" && OPEN_COMEBACK_GROUPS.includes(group.id)) return true
    const window = conditionWindow(group, date)
    if (window === null) return false
    if (history.loggedInBetween(window.from, window.to)) return false
    return history.loggedInBetween(Number.MIN_SAFE_INTEGER, window.from) || group.includeBeginner === true
}

function rewardMail(reward: LoginBonusReward, reasonId: number): SendMailOptions {
    const type = [MailType.FREE_VMONEY, MailType.ITEM, MailType.CHARACTER, MailType.FREE_MANA, MailType.EXP_POOL][reward.kind]
    if (type === undefined) throw new Error(`Unsupported login bonus reward ${reward.kind}`)
    return {
        type, typeId: reward.kind === 1 ? reward.itemId : reward.kind === 2 ? reward.characterId : undefined,
        number: scaleEarnedMailAmount(type, reward.amount, reward.itemId), reasonId, subject: "Login Bonus", description: "Your daily login reward.", durableReward: true
    }
}

/**
 * How many entries of a Limited ladder the day's login earns (FT-32). A ladder has one entry per game day of its window
 * (docs/event-reward-cadence.md), so a run at speed k earns up to k a day: as many as the run's historical game days
 * reached since the ladder opened, at least one. Missed days stay lost, as in the original. At speed 1, one.
 */
function limitedEntriesToday(group: LoginBonusGroup, start: number | undefined, count: number, date: Date): number {
    const speed = currentRunSpeed()
    if (speed <= 1 || start === undefined) return 1
    const historicalDay = (time: number) => Date.parse(gameDayOf(time)) / GAME_DAY_MS
    const reached = historicalDay(contentDate(date).getTime()) - historicalDay(start) + 1
    return Math.max(1, Math.min(speed, reached - count, group.days.length - count))
}

/** Deliver old entitlements as capacity becomes available, including after their campaign has closed. */
function deliverPending(playerId: number, date: Date): boolean {
    let capacity = mailLimits.pendingMails - getPlayerReceivableMailCountSync(playerId, date)
    let delivered = false
    if (capacity <= 0) return false
    const pending = db.prepare(`SELECT id, reward_json, mailed_rewards FROM players_login_bonus_receipts
        WHERE player_id = ? AND mailed_rewards < json_array_length(reward_json) ORDER BY id`).all(playerId) as Receipt[]
    for (const receipt of pending) {
        const mails = JSON.parse(receipt.reward_json) as SendMailOptions[]
        for (let i = receipt.mailed_rewards; i < mails.length; i++) {
            if (capacity <= 0) return delivered
            try {
                // Entitlements remain source-owned even when an older queued snapshot predates the flag.
                sendPlayerMailSync(playerId, { ...mails[i], durableReward: true })
                delivered = true
                capacity--
            } catch (error) {
                // There is room (checked above), so the game can't grant this reward (an unplayable unit, an amount
                // past a limit): skip it, as missions do, rather than failing this and every later /load.
                if (!(error instanceof InvalidMailError)) throw error
            }
            db.prepare(`UPDATE players_login_bonus_receipts SET mailed_rewards = ? WHERE id = ?`).run(i + 1, receipt.id)
        }
    }
    return delivered
}

/**
 * Earn one entry per actual login game day, with no offline backfill. The day receipt, reward snapshot,
 * gift-box delivery and presentation state commit atomically. A full box keeps the entitlement queued;
 * the next /load tries delivery again. Historical day receipts prevent rewards being duplicated by clock travel.
 */
export function applyLoginBonuses(playerId: number, date: Date = getServerDate(), previousLogin?: Date): LoginBonusesResult {
    return runInTransactionSync(() => {
        const day = gameDay(date).day
        const receivedAt = Math.floor(date.getTime() / 1000)
        const active: { group: LoginBonusGroup, periodKey: string }[] = []
        // Only /load knows the previous login: elsewhere (the tutorial's end) the conditional calendars present and
        // continue what was earned but start nothing.
        const history = previousLogin === undefined ? null : loginHistory(playerId, previousLogin)
        const occurrenceOf = (group: LoginBonusGroup): { key: string, start?: number } | null => {
            const period = loginBonusOccurrence(group, date)
            // a new scheduled run reopens a finite calendar (and re-decides who a conditional one takes)
            if (period !== null && group.groupType !== "Normal" && scheduledContentEnabled()) period.key += `:run:${currentEventOccurrenceKey()}`
            return period
        }
        const periodKeyOf = (group: LoginBonusGroup): string | null => occurrenceOf(group)?.key ?? null
        const started = (group: LoginBonusGroup, periodKey: string) => db.prepare(`SELECT 1 FROM players_login_bonus_receipts
            WHERE player_id = ? AND group_id = ? AND period_key = ? LIMIT 1`).get(playerId, group.id, periodKey) !== undefined
        // Whether a Comeback group takes the player this run; once a calendar has started, its decision stands. The
        // owner's rule decides the calendar itself; the ActiveUser present of its campaign follows the global rule
        // (src/lib/comebackRule.ts), so with "everyone" a player who stayed gets both.
        const rule = getComebackRule()
        const takesComeback = (group: LoginBonusGroup, periodKey: string, ruleFor: ComebackRule = rule): boolean => {
            // a started calendar answers for the rule in force, not for the global rule the present asks about
            if (ruleFor === rule && started(group, periodKey)) return true
            if (history === null) return false
            // the ActiveUser present of the same campaign already went to the player
            const present = loginBonusGroups.find(other => other.groupType === "ActiveUser" && other.comebackGroupId === group.id)
            const presentKey = present === undefined ? null : periodKeyOf(present)
            // (with "everyone" the calendar takes the player anyway: getting both is the point)
            if (!(ruleFor === "everyone" && OPEN_COMEBACK_GROUPS.includes(group.id))
                && present !== undefined && presentKey !== null && started(present, presentKey)) return false
            return comebackEligible(group, date, history, ruleFor)
        }
        for (const group of loginBonusGroups) {
            if (group.groupType === "ComebackAlways") {
                const returning = applyComebackPresent(playerId, group, date, day, receivedAt, history)
                if (returning !== null) active.push({ group, periodKey: returning })
                continue
            }
            const period = occurrenceOf(group)
            if (period === null || group.days.length === 0) continue
            if (group.groupType === "Comeback" && !takesComeback(group, period.key)) continue
            if (group.groupType === "ActiveUser") {
                // everyone the campaign's comeback calendar doesn't take (Japan's "3rd anniversary thank-you
                // present": "for players the Hello 10K login bonus doesn't cover")
                const comeback = loginBonusGroups.find(other => other.id === group.comebackGroupId)
                const comebackKey = comeback === undefined ? null : periodKeyOf(comeback)
                const takes = started(group, period.key)
                    || (history !== null && (comeback === undefined || comebackKey === null || !takesComeback(comeback, comebackKey, "global")))
                if (!takes) continue
            }
            active.push({ group, periodKey: period.key })
            const existing = db.prepare(`SELECT 1 FROM players_login_bonus_receipts
                WHERE player_id = ? AND group_id = ? AND period_key = ? AND game_day = ?`)
                .get(playerId, group.id, period.key, day)
            if (existing !== undefined) continue
            const count = (db.prepare(`SELECT COUNT(*) AS count FROM players_login_bonus_receipts
                WHERE player_id = ? AND group_id = ? AND period_key = ?`).get(playerId, group.id, period.key) as { count: number }).count
            if (group.groupType !== "Normal" && count >= group.days.length) continue
            const entries = group.groupType === "Limited" ? limitedEntriesToday(group, period.start, count, date) : 1
            for (let i = 0; i < entries; i++) {
                const entry = group.days[(count + i) % group.days.length]
                const mails = entry.rewards.map(reward => rewardMail(reward, group.reasonId))
                // the day's further entries (an accelerated run) keep the receipt's one-row-per-day key unique
                db.prepare(`INSERT INTO players_login_bonus_receipts
                    (player_id, group_id, period_key, game_day, bonus_index, received_at, reward_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
                    .run(playerId, group.id, period.key, i === 0 ? day : `${day}+${i}`, entry.index, receivedAt, JSON.stringify(mails))
            }
        }

        const mailArrived = deliverPending(playerId, date)
        // Remember exactly which receipts the latest /load presented. Old expired groups stay earned, but
        // must not be sent to a client whose scene/calendar can no longer display them.
        db.prepare(`UPDATE players_login_bonus_receipts SET presented = 0 WHERE player_id = ? AND presented = 1`).run(playerId)
        const bonusIndexList: LoginBonusIndex[] = []
        let loginBonusReceivedAt: number | null = null
        for (const { group, periodKey } of active) {
            const latest = db.prepare(`SELECT id, bonus_index, received_at FROM players_login_bonus_receipts
                WHERE player_id = ? AND group_id = ? AND period_key = ? AND shown = 0 AND received_at <= ?
                ORDER BY id DESC LIMIT 1`)
                .get(playerId, group.id, periodKey, receivedAt) as Receipt | undefined
            if (latest === undefined) continue
            bonusIndexList.push({ bonus_group_id: group.id, bonus_group_type: group.groupType, index: latest.bonus_index })
            loginBonusReceivedAt = Math.max(loginBonusReceivedAt ?? latest.received_at, latest.received_at)
            db.prepare(`UPDATE players_login_bonus_receipts SET presented = 1
                WHERE player_id = ? AND group_id = ? AND period_key = ? AND shown = 0 AND received_at <= ?`)
                .run(playerId, group.id, periodKey, receivedAt)
        }
        return { bonusIndexList, loginBonusReceivedAt, mailArrived }
    })
}

/**
 * The permanent comeback present (ComebackAlways, one entry): earned at the first login after COMEBACK_ABSENCE_DAYS
 * or more away, again after each such absence (period key `return:<game day>`), whatever the server's date: its
 * master period (from 2023-07-25) isn't checked (owner decision 2026-11-18, FT-65). Returns the period to present:
 * this login's, or the latest one not yet shown (a relaunch before the calendar was acknowledged), else null.
 */
function applyComebackPresent(playerId: number, group: LoginBonusGroup, date: Date, day: string, receivedAt: number,
    history: LoginHistory | null): string | null {
    if (group.days.length === 0) return null
    if (history !== null && returnsAfterAbsence(history, date)) {
        const periodKey = `return:${day}`
        const mails = group.days[0].rewards.map(reward => rewardMail(reward, group.reasonId))
        db.prepare(`INSERT OR IGNORE INTO players_login_bonus_receipts
            (player_id, group_id, period_key, game_day, bonus_index, received_at, reward_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(playerId, group.id, periodKey, day, group.days[0].index, receivedAt, JSON.stringify(mails))
        return periodKey
    }
    const pending = db.prepare(`SELECT period_key FROM players_login_bonus_receipts
        WHERE player_id = ? AND group_id = ? AND shown = 0 AND received_at <= ? ORDER BY id DESC LIMIT 1`)
        .get(playerId, group.id, receivedAt) as { period_key: string } | undefined
    return pending?.period_key ?? null
}

/** Acknowledges the player's latest /load presentation; safe on duplicate calls and after a restart. */
export function acknowledgeLoginBonuses(playerId: number): void {
    db.prepare(`UPDATE players_login_bonus_receipts SET shown = 1, presented = 0 WHERE player_id = ? AND presented = 1`).run(playerId)
}
