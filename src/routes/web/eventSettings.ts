import { playerSaveImportSetting } from "../../lib/playerSaveImport";
import { specialExchangeStarSlivers } from "../../lib/campaignGifts";
import { CampaignMode, campaignMode, originalCampaignMode } from "../../lib/campaignModes";
import { listStartDashCampaigns, START_DASH_STAR_SLIVERS } from "../../lib/startDash";
import { listSpecialExchangeCampaigns, specialExchangeBundlePrice } from "../../lib/specialExchange";
import { MailType } from "../../data/types";
import { getEventPolicy, EventMode } from "../../lib/eventPolicy";
import { getRewardPolicy, MAX_REWARD_MULTIPLIER, MIN_REWARD_MULTIPLIER, RewardManagement, rewardPercent } from "../../lib/rewardPolicy";
import { escapeHtml } from "./layout";
import { activePlayersThisWeek, getRaidHpPolicy, RAID_MAX_PLAYERS, RaidHpMode } from "../../lib/raid";
import { getServerDate } from "../../utils";
import { ComebackRule, getComebackRule } from "../../lib/comebackRule";
import { enabledPeriodicPacks, PERIODIC_PACKS, PeriodicPack } from "../../lib/periodicPacks";

export const EVENT_MODE_NAMES: Record<EventMode, string> = {
    classic: "Classic", accelerated: "Accelerated", "time-travel": "Time Travel", manual: "Manual"
}
const modeDescriptions: Record<EventMode, string> = {
    classic: "The complete historical timeline repeats at its original pace.",
    accelerated: "The same timeline runs faster; event progress counts its speed, so each event can still be finished.",
    "time-travel": "Players choose historical periods themselves. Daily resets still follow normal time.",
    manual: "Admins build a playlist of historical event periods on the Calendar page."
}
// Automatic first: it is the default
const managementNames: Record<RewardManagement, string> = { automatic: "Automatic", managed: "Managed" }
const managementDescriptions: Record<RewardManagement, string> = {
    automatic: "Rewards follow the server's rules: original amounts, and every event finishable at any speed. Locks the multiplier, admin gifts, save uploads, progress resets and developer unlocks.",
    managed: "Admins control rewards: gifts, save uploads, progress resets, developer mode and the multiplier."
}

// in tile order: Automatic, the default, first
const raidModeNames: Record<RaidHpMode, string> = { automatic: "Automatic", fixed: "Fixed" }
const raidModeDescriptions: Record<RaidHpMode, string> = {
    automatic: "The boss's HP grows with the players who have fought in the raid, so each does about the same work. The default.",
    fixed: "The boss's HP is sized for the number of players set below."
}

/** Material Symbols paths (viewBox 0 -960 960 960) for the tiles and the group headers. */
const ICONS: Record<string, string> = {
    // calendar_today
    classic: "M200-80q-33 0-56.5-23.5T120-160v-560q0-33 23.5-56.5T200-800h40v-80h80v80h320v-80h80v80h40q33 0 56.5 23.5T840-720v560q0 33-23.5 56.5T760-80H200Zm0-80h560v-400H200v400Zm0-480h560v-80H200v80Zm0 0v-80 80Z",
    // speed (the settings page's own speedometer)
    accelerated: "M418-340q24 24 62 23.5t56-27.5l224-336-336 224q-27 18-28.5 55t22.5 61Zm62-460q59 0 113.5 16.5T696-734l-76 48q-33-17-68.5-25.5T480-720q-133 0-226.5 93.5T160-400q0 42 11.5 83t32.5 77h552q23-38 33.5-79t10.5-85q0-36-8.5-70T766-540l48-76q30 47 47.5 100T880-406q1 57-13 109t-41 99q-11 18-30 28t-40 10H204q-21 0-40-10t-30-28q-26-45-40-95.5T80-400q0-83 31.5-155.5t86-127Q252-737 325-768.5T480-800Zm7 313Z",
    // schedule (a clock)
    "time-travel": "M480-880a400 400 0 1 0 0 800a400 400 0 1 0 0-800Zm0 80a320 320 0 1 1 0 640a320 320 0 1 1 0-640Zm-40 80v250l130 130 56-56-106-106v-218h-80Z",
    // list
    manual: "M120-280v-80h720v80H120Zm0-160v-80h720v80H120Zm0-160v-80h720v80H120Z",
    // tune
    managed: "M440-120v-240h80v80h320v80H520v80h-80Zm-320-80v-80h240v80H120Zm160-160v-80H120v-80h160v-80h80v240h-80Zm160-80v-80h400v80H440Zm160-160v-240h80v80h160v80H680v80h-80Zm-480-80v-80h400v80H120Z",
    // group: a fixed number of players
    "raid-fixed": "M40-160v-112q0-34 17.5-62.5T104-378q62-31 126-46.5T360-440q66 0 130 15.5T616-378q29 15 46.5 43.5T680-272v112H40Zm720 0v-120q0-44-24.5-84.5T666-434q51 6 96 20.5t84 35.5q35 20 54.5 44.5T920-280v120H760ZM360-480q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 66-47 113t-113 47Zm280-160q0 66-47 113t-113 47q-11 0-28-2.5t-28-5.5q36-32 55.5-71T499-640q0-42-19.5-81T424-792q14-5 28-6.5t28-1.5q66 0 113 47t47 113Z",
    // trending_up: the pool grows with participation
    "raid-automatic": "M120-240v-80l240-240 160 160 184-184H600v-80h240v240h-80v-104L520-288 360-448 200-288v48h-80Z",
    // lock
    automatic: "M240-80q-33 0-56.5-23.5T160-160v-400q0-33 23.5-56.5T240-640h40v-80q0-83 58.5-141.5T480-920q83 0 141.5 58.5T680-720v80h40q33 0 56.5 23.5T800-560v400q0 33-23.5 56.5T720-80H240Zm240-200q33 0 56.5-23.5T560-360q0-33-23.5-56.5T480-440q-33 0-56.5 23.5T400-360q0 33 23.5 56.5T480-280ZM360-640h240v-80q0-50-35-85t-85-35q-50 0-85 35t-35 85v80Z"
}

function icon(name: string): string {
    return `<span class="settings-group-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" aria-hidden="true"><path d="${ICONS[name]}"/></svg></span>`
}

/** A radio the whole tile selects: the page's preset cards, made selectable. The saved choice is marked "current". */
function tile(field: string, value: string, title: string, description: string, chips: string[], current: boolean, iconName = value): string {
    return `
                <label class="choice-tile">
                    <input type="radio" name="${field}" value="${value}"${current ? " checked" : ""} required />
                    <div class="card-header items-center">
                        <div class="settings-group-title">${icon(iconName)}<h4 class="card-title">${escapeHtml(title)}</h4></div>
                        ${current ? `<span class="badge-on">current</span>` : ""}
                    </div>
                    <p class="card-text">${escapeHtml(description)}</p>
                    <div class="setting-meta">${chips.map(chip => `<span class="chip">${escapeHtml(chip)}</span>`).join("")}</div>
                </label>`
}

function stepper(id: string, name: string, label: string, attributes: string, value: string, unit: string, disabled: boolean): string {
    return `<div class="unit-input">
                        <button type="button" class="stepper-btn" data-step="-1" aria-label="${escapeHtml(`Decrease: ${label}`)}"${disabled ? " disabled" : ""}>−</button>
                        <label class="unit-value" for="${id}">
                            <input id="${id}" name="${name}" type="number" ${attributes} value="${escapeHtml(value)}" inputmode="decimal"${disabled ? " disabled" : ""} />
                            <span class="unit">${unit}</span>
                        </label>
                        <button type="button" class="stepper-btn" data-step="1" aria-label="${escapeHtml(`Increase: ${label}`)}"${disabled ? " disabled" : ""}>+</button>
                    </div>`
}

export function eventSettingsHtml(): string {
    const range = `${rewardPercent(MIN_REWARD_MULTIPLIER)}–${rewardPercent(MAX_REWARD_MULTIPLIER)}%`
    const multiplierAttributes = `min="${rewardPercent(MIN_REWARD_MULTIPLIER)}" max="${rewardPercent(MAX_REWARD_MULTIPLIER)}" step="5" required`
    const policy = getEventPolicy()
    const reward = getRewardPolicy()
    const fixed = reward.management === "automatic"
    const modeTiles = (Object.keys(EVENT_MODE_NAMES) as EventMode[]).map(mode => tile("mode", mode, EVENT_MODE_NAMES[mode],
        modeDescriptions[mode], [mode === "accelerated" ? `event progress ×${policy.acceleration}` : "original pace"], policy.mode === mode)).join("")
    const managementTiles = (Object.keys(managementNames) as RewardManagement[]).map(management => tile("management", management,
        managementNames[management], managementDescriptions[management], [], reward.management === management)).join("")
    return `<script src="/public/js/event-settings.js" defer></script>
            <form method="post" action="/api/server/events" class="flex flex-col gap-6" data-event-settings data-tab-panel="events rewards">
                <div id="events" class="flex flex-col gap-6" data-tab-panel="events">
                    <div class="settings-section-header">
                        <h2 class="settings-section-title">Events</h2>
                        <p class="card-text">Event availability changes independently of the running clock. Apply changes between battles.</p>
                    </div>
                <div class="flex flex-col gap-3">
                    <h3 class="card-title">Event mode</h3>
                    <div class="grid-cards">${modeTiles}
                    </div>
                </div>
                <div class="settings-group">
                    <div class="settings-group-header">
                        <div class="settings-group-title">${icon("time-travel")}<h3 class="card-title">Speed and time travel</h3></div>
                        <p class="card-text">Players can choose a period only in Time Travel mode. Admin travel is a separate permission; switching either off suspends its saved personal periods.</p>
                    </div>
                    <div class="setting-row${policy.mode === "accelerated" ? "" : " setting-row-locked"}" data-locked-unless="mode=accelerated">
                        <div class="setting-text">
                            <label for="setting-acceleration" class="setting-label">Accelerated speed</label>
                            <p class="card-text">How many times faster the timeline runs. Only used in Accelerated mode.</p>
                            <div class="setting-meta"><span class="chip">2–10×</span><span class="chip">default 2×</span></div>
                        </div>
                        ${stepper("setting-acceleration", "acceleration", "Accelerated speed", `min="2" max="10" step="1" required`, String(policy.acceleration), "×", policy.mode !== "accelerated")}
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <label for="setting-admin-travel" class="setting-label">Admin time travel</label>
                            <p class="card-text">Lets admins travel, including assigning periods to players and travelling in their own portal save.</p>
                        </div>
                        <input id="setting-admin-travel" class="check" type="checkbox" name="adminTimeTravel" value="1"${policy.adminTimeTravel ? " checked" : ""} />
                    </div>
                </div>
                </div>
                <div id="rewards" class="flex flex-col gap-6" data-tab-panel="rewards" hidden>
                    <div class="settings-section-header">
                        <h2 class="settings-section-title">Rewards</h2>
                        <p class="card-text">Changes affect future earnings; rewards already earned keep their original amounts.</p>
                    </div>
                <div class="flex flex-col gap-3">
                    <h3 class="card-title">Reward management</h3>
                    <div class="grid-cards">${managementTiles}
                    </div>
                </div>
                <div class="settings-group">
                    <div class="settings-group-header">
                        <div class="settings-group-title">${icon("managed")}<h3 class="card-title">Reward multipliers</h3></div>
                        <p class="card-text">Scale earned beads, mana, EXP and items. Unique rewards and manually entered gifts keep their specified amounts.</p>
                    </div>
                    <div class="setting-row${fixed ? " setting-row-locked" : ""}" data-locked-unless="management=managed">
                        <div class="setting-text">
                            <label for="setting-multiplier" class="setting-label">Reward multiplier</label>
                            <p class="card-text">Managed only: Automatic uses the profile's own amount. Setting it to the profile's default follows that default when the profile changes.</p>
                            <div class="setting-meta">
                                <span class="chip">${range}</span>
                                <span class="chip">${escapeHtml(EVENT_MODE_NAMES[policy.mode])} default ${rewardPercent(reward.profileMultiplier)}%</span>
                                <span class="chip-custom">in effect ${rewardPercent(reward.multiplier)}%</span>
                            </div>
                        </div>
                        ${stepper("setting-multiplier", "multiplierPercent", "Reward multiplier", multiplierAttributes,
                            String(rewardPercent(reward.multiplier)), "%", fixed)}
                    </div>
                    <div class="setting-row${fixed ? " setting-row-locked" : ""}" data-locked-unless="management=managed">
                        <div class="setting-text">
                            <label for="setting-boss-multiplier" class="setting-label">Boss reward multiplier</label>
                            <p class="card-text">For boss battles and every co-op battle, whichever event it belongs to. Setting it to the reward multiplier above follows that one.</p>
                            <div class="setting-meta">
                                <span class="chip">${range}</span>
                                <span class="chip">default: same as the reward multiplier</span>
                                <span class="chip-custom">in effect ${rewardPercent(reward.bossMultiplier)}%</span>
                            </div>
                        </div>
                        ${stepper("setting-boss-multiplier", "bossMultiplierPercent", "Boss reward multiplier", multiplierAttributes,
                            String(rewardPercent(reward.bossMultiplier)), "%", fixed)}
                    </div>
                </div>
                </div>
                <div class="action-bar" data-tab-panel="events rewards">
                    <button class="btn-primary" type="submit">Save event and reward settings</button>
                </div>
            </form>
            ${raidSettingsHtml("events")}
            ${campaignGiftsHtml("events")}
            ${saveImportSettingsHtml("rewards")}
            ${comebackRuleSettingsHtml("rewards")}
            ${periodicPacksSettingsHtml("rewards")}`
}

/** What a periodic pack gives, for its row (every bead a free bead). */
function periodicPackSummary(pack: PeriodicPack): string {
    const start = pack.start.map(reward => reward.type === MailType.FREE_MANA ? `${reward.number.toLocaleString("en")} mana`
        : reward.typeId === undefined ? `${reward.number.toLocaleString("en")} beads` : `${reward.number} items`).join(" and ")
    if (pack.kind === "term") {
        const daily = pack.daily.typeId === 106 ? `${pack.daily.number} Staminade Decanter` : `${pack.daily.number} beads`
        return `${start} at the start of each ${pack.days}-day term, then ${daily} at the first login of each day. Renews by itself while on.`
    }
    return `${start} once, then ${pack.beads.toLocaleString("en")} beads at every ${pack.step}th rank from ${pack.from} to ${pack.to}, ranks already reached included.`
}

/**
 * Periodic packs (FT-89, src/lib/periodicPacks.ts): the original's monthly and Rank Achievement packs, each on for every
 * player or for none. Its own form, in the Rewards tab or, without event scheduling, with the other settings. Not
 * locked by Automatic reward rules: every player gets the same.
 */
export function periodicPacksSettingsHtml(panel: string): string {
    const enabled = enabledPeriodicPacks()
    const rows = PERIODIC_PACKS.map(pack => `
                    <div class="setting-row">
                        <div class="setting-text">
                            <label for="setting-pack-${pack.id}" class="setting-label">${escapeHtml(pack.name)}</label>
                            <p class="card-text">${escapeHtml(periodicPackSummary(pack))}</p>
                        </div>
                        <input id="setting-pack-${pack.id}" class="check" type="checkbox" name="pack_${pack.id}" value="1"${enabled.has(pack.id) ? " checked" : ""} />
                    </div>`).join("")
    return `<form method="post" action="/api/server/periodicPacks" class="flex flex-col gap-3" data-tab-panel="${panel}"${panel === "rewards" ? " hidden" : ""}>
                <div class="settings-group">
                    <div class="settings-group-header">
                        <div class="settings-group-title">${icon("managed")}<h3 class="card-title">Periodic packs</h3></div>
                        <p class="card-text">The original's monthly and Rank Achievement packs, given to every player while on, through the gift box. All their beads are free beads, which every bead cost here accepts. Turning a pack off starts no new term; a running one ends as it would.</p>
                    </div>${rows}
                </div>
                <div class="action-bar">
                    <button class="btn-primary" type="submit">Save periodic packs</button>
                </div>
            </form>`
}

const comebackRuleNames: Record<ComebackRule, string> = { global: "As on the global server", everyone: "Everyone" }
const comebackRuleDescriptions: Record<ComebackRule, string> = {
    global: "Welcome Back Login Perks (10 days of 150 beads) go to existing players who hadn't logged in since 1 December 2022, as Kakao ran them; the 3rd anniversary's 5-day comeback calendar to players away from 1 March to 20 April 2024, new players included.",
    everyone: "Both calendars go to every player who logs in while they run, new players included. The anniversary's thank-you present still goes to players who stayed."
}

/**
 * The one-off comeback login calendars (FT-65, src/lib/comebackRule.ts): the global server's rule, or everyone. Its own
 * form, in the Rewards tab or, without event scheduling, with the other settings. The standing Welcome Back Gift (60+
 * days away) isn't a choice.
 */
export function comebackRuleSettingsHtml(panel: string): string {
    const rule = getComebackRule()
    const tiles = (Object.keys(comebackRuleNames) as ComebackRule[])
        .map(value => tile("comebackRule", value, comebackRuleNames[value], comebackRuleDescriptions[value], [], rule === value, value === "global" ? "classic" : "managed")).join("")
    return `<form method="post" action="/api/server/comebackRule" class="flex flex-col gap-3" data-tab-panel="${panel}"${panel === "rewards" ? " hidden" : ""}>
                <div class="settings-group">
                    <div class="settings-group-header">
                        <div class="settings-group-title">${icon("managed")}<h3 class="card-title">Comeback login calendars</h3></div>
                        <p class="card-text">Who gets the two one-off comeback calendars when they come round. The Welcome Back Gift is always on: a player back after 60 days or more away gets it at any date.</p>
                    </div>
                    <div class="grid-cards px-5 py-4 md:px-6 md:py-5">${tiles}
                    </div>
                </div>
                <div class="action-bar">
                    <button class="btn-primary" type="submit">Save comeback setting</button>
                </div>
            </form>`
}

/**
 * Save imports (ACC-15): whether players may import their own save on the portal. Its own form, shown in the Rewards
 * tab or, without event scheduling, with the other settings; locked while the reward rules are Automatic, which lock
 * every save upload.
 */
export function saveImportSettingsHtml(panel: string): string {
    const automatic = getRewardPolicy().management === "automatic"
    return `<form method="post" action="/api/server/saveImport" class="flex flex-col gap-3" data-tab-panel="${panel}"${panel === "rewards" ? " hidden" : ""}>
                <div class="settings-group">
                    <div class="settings-group-header">
                        <div class="settings-group-title">${icon("managed")}<h3 class="card-title">Save imports</h3></div>
                        <p class="card-text">Admins can replace any player's save on the Players page. A save file can be edited, so players importing their own is off unless you allow it.</p>
                    </div>
                    <div class="setting-row${automatic ? " setting-row-locked" : ""}">
                        <div class="setting-text">
                            <label for="setting-player-save-import" class="setting-label">Players can import their own save</label>
                            <p class="card-text">On the player portal, next to the save download: a signed-in player replaces their progress with a save file, for example one from Local play or another server. The same checks as an admin import, once a day per player, logged.${automatic ? " Needs Managed reward rules: Automatic locks every save upload." : ""}</p>
                        </div>
                        <input id="setting-player-save-import" class="check" type="checkbox" name="playerSaveImport" value="1"${playerSaveImportSetting() ? " checked" : ""}${automatic ? " disabled" : ""} />
                    </div>
                </div>
                <div class="action-bar">
                    <button class="btn-primary" type="submit"${automatic ? " disabled" : ""}>Save import setting</button>
                </div>
            </form>`
}

/**
 * Raid bosses (FT-12): the shared HP pool's size, for a number of players (one player's share is the original pool /
 * 30,000) or for the raid's participants. The suggestion is the players who logged in within the last week.
 */
export function raidSettingsHtml(panel: string): string {
    const raid = getRaidHpPolicy()
    const active = activePlayersThisWeek(getServerDate())
    const tiles = (Object.keys(raidModeNames) as RaidHpMode[]).map(mode => tile("raidHpMode", mode, raidModeNames[mode], raidModeDescriptions[mode], [], raid.mode === mode, `raid-${mode}`)).join("")
    // its own form: it saves apart from the event and reward settings, and the page shows it with or without them
    return `<form method="post" action="/api/server/raids" class="flex flex-col gap-3" data-event-settings data-tab-panel="${panel}">
                <div class="settings-group">
                    <div class="settings-group-header">
                        <div class="settings-group-title">${icon("managed")}<h3 class="card-title">Raid bosses</h3></div>
                        <p class="card-text">The whole server shares one boss HP pool in a raid; every full pool defeated counts toward the tally rewards. The original pools were sized for the global server, so here they are sized for this server's players.</p>
                    </div>
                    <div class="grid-cards px-5 py-4 md:px-6 md:py-5">${tiles}
                    </div>
                    <div class="setting-row${raid.mode === "fixed" ? "" : " setting-row-locked"}" data-locked-unless="raidHpMode=fixed">
                        <div class="setting-text">
                            <label for="setting-raid-players" class="setting-label">Raid boss HP sized for</label>
                            <p class="card-text">Players the pool is sized for. With 1, an active player reaches every tally reward over a raid. Fixed mode only.</p>
                            <div class="setting-meta">
                                <span class="chip">1–${RAID_MAX_PLAYERS.toLocaleString("en")}</span>
                                <span class="chip">default 1</span>
                                <span class="chip-custom">suggested ${Math.max(1, active)}: players active this week</span>
                            </div>
                        </div>
                        ${stepper("setting-raid-players", "raidHpPlayers", "Raid boss HP sized for", `min="1" max="${RAID_MAX_PLAYERS}" step="1" required`, String(raid.players), "players", raid.mode !== "fixed")}
                    </div>
                </div>
                <div class="action-bar">
                    <button class="btn-primary" type="submit">Save raid settings</button>
                </div>
            </form>`
}

/**
 * Campaign bundles (FT-39, FT-44, src/lib/campaignModes.ts): a row per Scouting / Dream Armament Selection season and
 * Start Dash bundle, with what it costs, what it gives and a Paid / Free choice whose original is marked.
 */
export function campaignGiftsHtml(panel: string): string {
    const beads = (n: number) => `${n.toLocaleString("en")} beads`
    const date = (value: string) => escapeHtml(value.slice(0, 10))
    const choice = (field: string, mode: CampaignMode, original: CampaignMode, paidText: string, label: string) => {
        const option = (value: CampaignMode, text: string) =>
            `<option value="${value}"${mode === value ? " selected" : ""}>${escapeHtml(text)}${original === value ? " (original)" : ""}</option>`
        return `<select id="setting-${field}" class="input md:w-64 shrink-0" name="${field}" aria-label="${escapeHtml(label)}">${option("paid", `Paid: ${paidText}`)}${option("free", "Free: mailed to everyone")}</select>`
    }
    const changed = (mode: CampaignMode, original: CampaignMode) => mode === original ? "" : `<span class="chip-custom">changed from the original</span>`
    const row = (field: string, name: string, lines: string[], chips: string[], control: string) => `
                    <div class="setting-row">
                        <div class="setting-text">
                            <label for="setting-${field}" class="setting-label">${escapeHtml(name)}</label>
                            ${lines.map(line => `<p class="card-text">${line}</p>`).join("")}
                            <div class="setting-meta">${chips.join("")}</div>
                        </div>
                        ${control}
                    </div>`

    // the five Scouting Ticket Gift Promos share a name: a repeated one gets its sale start
    const names = new Map<string, number>()
    for (const [, campaign] of listSpecialExchangeCampaigns()) names.set(campaign.name, (names.get(campaign.name) ?? 0) + 1)
    const seasons = listSpecialExchangeCampaigns().map(([id, campaign]) => {
        const field = `special_${id}`
        const mode = campaignMode("specialExchange", id), original = originalCampaignMode("specialExchange", id)
        const unit = campaign.kind === "character" ? "unit" : "armament"
        const ticket = campaign.kind === "character" ? "Scouting ticket" : "Dream Armament ticket"
        const price = specialExchangeBundlePrice(campaign)
        const reward = (forMode: CampaignMode) => {
            const slivers = specialExchangeStarSlivers(campaign, forMode)
            return slivers > 0 ? `1 ${ticket} and ${slivers} Star Slivers` : `1 ${ticket}`
        }
        const name = (names.get(campaign.name) ?? 0) > 1 ? `${campaign.name} (from ${campaign.saleStart.slice(0, 10)})` : campaign.name
        return row(field, name, [
            `<strong>Paid:</strong> ${escapeHtml(reward("paid"))} for ${beads(price)}, bought once in the season's Shop screen.`,
            `<strong>Free:</strong> ${escapeHtml(reward("free"))}, mailed once at a player's first login of the sale period.`,
            `The ticket trades for 1 of ${campaign.targets.length} ${unit}s.`
        ], [
            `<span class="chip">${campaign.kind === "character" ? "Units" : "Armaments"}</span>`,
            `<span class="chip">on sale ${date(campaign.saleStart)} to ${date(campaign.saleEnd)}</span>`,
            `<span class="chip">exchange until ${date(campaign.exchangeEnd)}</span>`,
            `<span class="chip">original: ${original === "paid" ? `paid, ${beads(price)}` : "free gift"}</span>`,
            changed(mode, original)
        ], choice(field, mode, original, beads(price), `${name}: paid or free`))
    }).join("")

    const startDash = listStartDashCampaigns().map(([id, campaign]) => {
        const field = `startdash_${id}`
        const mode = campaignMode("startDash", id), original = originalCampaignMode("startDash", id)
        const reward = `the Start Dash ticket, a 10-Pull Summoning Ticket and ${START_DASH_STAR_SLIVERS} Star Slivers`
        return row(field, campaign.bundleName, [
            `<strong>Paid:</strong> ${reward} for ${beads(campaign.price)}, bought once in the Shop.`,
            `<strong>Free:</strong> the same, mailed at the player's first login.`,
            `Every new player, in their first ${campaign.days} days, whatever the server's date. The ticket trades for 1 of the open portal's 4- and 5-star units.`
        ], [
            `<span class="chip">new players</span>`,
            `<span class="chip">${campaign.days} days per player</span>`,
            `<span class="chip">original: paid, ${beads(campaign.price)}</span>`,
            changed(mode, original)
        ], choice(field, mode, original, beads(campaign.price), `${campaign.bundleName}: paid or free`))
    }).join("")

    return `<form method="post" action="/api/server/campaignGifts" class="flex flex-col gap-3" data-event-settings data-tab-panel="${panel}">
                <div class="settings-group">
                    <div class="settings-group-header">
                        <div class="settings-group-title">${icon("managed")}<h3 class="card-title">Campaign bundles</h3></div>
                        <p class="card-text">Each Scouting and Dream Armament Selection season, and the Start Dash bundle, gives an exchange ticket that trades for one unit or armament from its list. <strong>Paid</strong>: players buy the bundle once, with any beads (free beads first). <strong>Free</strong>: it isn't sold; every player gets the same rewards by mail, once. "(original)" marks what the original server did. Dates are in Japan time and follow the event schedule.</p>
                    </div>
                    <div class="px-5 pt-4 md:px-6"><h4 class="setting-label">Start Dash</h4></div>${startDash}
                    <div class="px-5 pt-4 md:px-6"><h4 class="setting-label">Scouting and Dream Armament Selection seasons</h4></div>${seasons}
                </div>
                <div class="action-bar">
                    <button class="btn-primary" type="submit">Save campaign bundles</button>
                </div>
            </form>`
}

/**
 * The page's tabs: anchors that work without the script (settings-tabs.js shows one panel at a time). Without the
 * modern schedule there are no Events and Rewards tabs, and the "performance" panel, which then also holds the raid and
 * campaign gift settings, is called General.
 */
export function settingsTabsHtml(scheduled: boolean): string {
    const tabs: [string, string][] = scheduled
        ? [["events", "Events"], ["rewards", "Rewards"], ["performance", "Performance"], ["identity", "Server identity"]]
        : [["performance", "General"], ["identity", "Server identity"]]
    return `            <nav class="tabs" role="tablist" aria-label="Settings">
${tabs.map(([id, label], position) => `                <a class="tab${position === 0 ? " tab-active" : ""}" role="tab" href="#${id}" data-tab="${id}" aria-selected="${position === 0}">${label}</a>`).join("\n")}
            </nav>`
}
