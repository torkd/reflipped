// The admin Settings page: every setting in src/data/serverSettings.ts, a card per group, a row per setting.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { activePreset, getSetting, presetKeys, SETTING_GROUPS, SETTING_PRESETS, SETTING_SECTIONS, SETTINGS, SettingDefinition, SettingGroup, SettingPreset } from "../../data/serverSettings";
import { recruitmentSummary } from "../../lib/coop/recruitment";
import { escapeHtml, renderPage } from "./layout";
import { query, string } from "../schemas";

// Fixed notice texts for `?error=` / `?message=`, so a crafted link can't put its own words on the page (SEC-10).
const errorNotices = new Map([
    ["invalid_setting", "Nothing was saved: every value must be a whole number of seconds within its range."],
    ["unknown_preset", "Nothing was saved: that preset doesn't exist."]
])
const messageNotices = new Map([
    ["settings_saved", "Settings saved. They apply to new requests right away."],
    ["settings_reset", "All settings are back to their defaults."],
    ["preset_applied", "Preset applied. The new timings apply to new requests right away."]
])

/** Material Symbols paths (viewBox 0 -960 960 960) for the preset cards. */
const PRESET_ICONS: Record<string, string> = {
    // balance (scales)
    balanced: "M80-120v-80h360v-447q-26-9-45-28t-28-45H240l120 280q0 50-41 85t-99 35q-58 0-99-35t-41-85l120-280h-80v-80h247q12-35 43-57.5t70-22.5q39 0 70 22.5t43 57.5h247v80h-80l120 280q0 50-41 85t-99 35q-58 0-99-35t-41-85l120-280H593q-9 26-28 45t-45 28v447h360v80H80Zm585-320h150l-75-174-75 174Zm-520 0h150l-75-174-75 174Zm335-280q17 0 28.5-11.5T520-760q0-17-11.5-28.5T480-800q-17 0-28.5 11.5T440-760q0 17 11.5 28.5T480-720Z",
    // speed (speedometer)
    responsive: "M418-340q24 24 62 23.5t56-27.5l224-336-336 224q-27 18-28.5 55t22.5 61Zm62-460q59 0 113.5 16.5T696-734l-76 48q-33-17-68.5-25.5T480-720q-133 0-226.5 93.5T160-400q0 42 11.5 83t32.5 77h552q23-38 33.5-79t10.5-85q0-36-8.5-70T766-540l48-76q30 47 47.5 100T880-406q1 57-13 109t-41 99q-11 18-30 28t-40 10H204q-21 0-40-10t-30-28q-26-45-40-95.5T80-400q0-83 31.5-155.5t86-127Q252-737 325-768.5T480-800Zm7 313Z"
}

/** How the saved values relate to the presets: the matching one, else the closest one and how many values differ. */
function presetState(): { active: SettingPreset | null, base: SettingPreset, differences: number } {
    const active = activePreset()
    if (active) return { active, base: active, differences: 0 }
    const scored = SETTING_PRESETS.map(preset => ({
        preset,
        differences: presetKeys().filter(key => getSetting(key) !== preset.values[key]).length
    })).sort((a, b) => a.differences - b.differences)
    return { active: null, base: scored[0].preset, differences: scored[0].differences }
}

/** "Responsive", or "Custom, based on Balanced (2 changes)". */
function presetStatusText(state: ReturnType<typeof presetState>): string {
    if (state.active) return state.active.title
    return `Custom, based on ${state.base.title} (${state.differences} ${state.differences === 1 ? "change" : "changes"})`
}

/**
 * The preset cards: the one matching the saved values is "current"; when none does, the closest one is "modified"
 * and offers to re-apply it. Each card carries its values for the live status in settings.js.
 */
function presetsHtml(state: ReturnType<typeof presetState>): string {
    const cards = SETTING_PRESETS.map(preset => {
        const isActive = state.active?.id === preset.id
        const isModifiedBase = !state.active && state.base.id === preset.id
        const v = preset.values
        const facts = [
            `invitations every ${v["client.attention_polling_seconds"]} s`,
            `in battle ${v["client.attention_polling_battle_seconds"]} s`,
            `re-send every ${v["coop.recruit_interval_seconds"]} s`,
            `keepalive ${v["coop.lobby_keepalive_seconds"]} s`
        ].map(fact => `<span class="chip">${escapeHtml(fact)}</span>`).join("")
        const badge = isActive ? `<span class="badge-on">current</span>`
            : isModifiedBase ? `<span class="badge-off">modified</span>` : ""
        const button = isActive ? `<button type="submit" class="btn-outline" disabled>Applied</button>`
            : `<button type="submit" class="btn-primary">${isModifiedBase ? "Re-apply" : "Apply"} ${escapeHtml(preset.title)}</button>`
        const icon = PRESET_ICONS[preset.id]
        return `
                <form class="card preset-card${isActive ? " preset-card-active" : ""}" method="post" action="/api/server/settingsPreset" data-preset-title="${escapeHtml(preset.title)}" data-preset-values="${escapeHtml(JSON.stringify(preset.values))}">
                    <input type="hidden" name="preset" value="${escapeHtml(preset.id)}" />
                    <div class="card-header items-center">
                        <div class="settings-group-title">
                            ${icon ? `<span class="settings-group-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" aria-hidden="true"><path d="${icon}"/></svg></span>` : ""}
                            <h3 class="card-title">${escapeHtml(preset.title)}</h3>
                        </div>
                        ${badge}
                    </div>
                    <p class="card-text">${escapeHtml(preset.description)} ${escapeHtml(preset.cost)}</p>
                    <div class="setting-meta">${facts}</div>
                    <div class="flex justify-end mt-auto">
                        ${button}
                    </div>
                </form>`
    }).join("\n")
    return `
                <div class="flex flex-col gap-3">
                    <div class="flex items-center justify-between gap-x-4 gap-y-1 flex-wrap">
                        <h3 class="card-title">Presets</h3>
                        <div class="flex items-center gap-2 min-w-0">
                            <span class="card-text">Current values: <strong class="text-on-background" id="preset-status" data-saved="${escapeHtml(presetStatusText(state))}">${escapeHtml(presetStatusText(state))}</strong></span>
                            <span class="chip-unsaved invisible" id="preset-unsaved">unsaved</span>
                        </div>
                    </div>
                    <div class="grid-cards">
${cards}
                    </div>
                </div>`
}

/** Material Symbols paths (viewBox 0 -960 960 960) for the group headers. */
const GROUP_ICONS: Record<string, string> = {
    // smart_toy
    companions: "M160-360q-50 0-85-35t-35-85q0-50 35-85t85-35v-80q0-33 23.5-56.5T240-760h120q0-50 35-85t85-35q50 0 85 35t35 85h120q33 0 56.5 23.5T800-680v80q50 0 85 35t35 85q0 50-35 85t-85 35v160q0 33-23.5 56.5T720-120H240q-33 0-56.5-23.5T160-200v-160Zm200-80q25 0 42.5-17.5T420-500q0-25-17.5-42.5T360-560q-25 0-42.5 17.5T300-500q0 25 17.5 42.5T360-440Zm240 0q25 0 42.5-17.5T660-500q0-25-17.5-42.5T600-560q-25 0-42.5 17.5T540-500q0 25 17.5 42.5T600-440ZM320-280h320v-80H320v80Zm-80 80h480v-480H240v480Zm240-240Z",
    // notifications
    invitations: "M160-200v-80h80v-280q0-83 50-147.5T420-792v-28q0-25 17.5-42.5T480-880q25 0 42.5 17.5T540-820v28q80 20 130 84.5T720-560v280h80v80H160Zm320-300Zm0 420q-33 0-56.5-23.5T400-160h160q0 33-23.5 56.5T480-80ZM320-280h320v-280q0-66-47-113t-113-47q-66 0-113 47t-47 113v280Z",
    // wifi
    connection: "M480-120q-42 0-71-29t-29-71q0-42 29-71t71-29q42 0 71 29t29 71q0 42-29 71t-71 29ZM254-346l-84-86q59-59 138.5-93.5T480-560q92 0 171.5 35T790-430l-84 84q-44-44-102-69t-124-25q-66 0-124 25t-102 69ZM84-516 0-600q92-94 215-147t265-53q142 0 265 53t215 147l-84 84q-77-77-178.5-120.5T480-680q-116 0-217.5 43.5T84-516Z"
}

function noticeHtml(error: unknown, message: unknown): string {
    const errorText = typeof error === "string" ? errorNotices.get(error) : undefined
    if (errorText !== undefined) return `<div class="notice-error">${escapeHtml(errorText)}</div>`
    const messageText = typeof message === "string" ? messageNotices.get(message) : undefined
    return messageText !== undefined ? `<div class="notice-info">${escapeHtml(messageText)}</div>` : ""
}

/** The save form; the fields sit in several sections around the preset forms and join it with `form="…"`. */
const SETTINGS_FORM_ID = "settings-form"

/**
 * A setting's row. When the saved values match no preset, a preset-controlled row whose value differs from the closest
 * preset says so and shows the preset's value; settings.js adds an "unsaved" tag while the field is edited.
 */
function settingRow(setting: SettingDefinition, state: ReturnType<typeof presetState>): string {
    const id = `setting-${setting.key.replace(/\W/g, "-")}`
    const value = getSetting(setting.key)
    const presetValue = state.base.values[setting.key]
    const custom = !state.active && presetValue !== undefined && value !== presetValue
        ? `<span class="chip-custom">custom</span><span class="chip">${escapeHtml(state.base.title)}: ${presetValue} s</span>`
        : ""
    return `
                    <div class="setting-row">
                        <div class="setting-text">
                            <label for="${id}" class="setting-label">${escapeHtml(setting.label)}</label>
                            <p class="card-text">${escapeHtml(setting.description)}</p>
                            <div class="setting-meta">
                                <span class="chip">${setting.min}–${setting.max} s</span>
                                <span class="chip">default ${setting.defaultValue()} s</span>
                                ${custom}
                                <span class="chip-unsaved invisible" data-unsaved>unsaved</span>
                            </div>
                        </div>
                        <div class="unit-input">
                            <button type="button" class="stepper-btn" data-step="-1" aria-label="${escapeHtml(`Decrease: ${setting.label}`)}">−</button>
                            <label class="unit-value" for="${id}">
                                <input id="${id}" form="${SETTINGS_FORM_ID}" name="${escapeHtml(setting.key)}" type="number" min="${setting.min}" max="${setting.max}" step="1" value="${value}" inputmode="numeric" required />
                                <span class="unit">s</span>
                            </label>
                            <button type="button" class="stepper-btn" data-step="1" aria-label="${escapeHtml(`Increase: ${setting.label}`)}">+</button>
                        </div>
                    </div>`
}

function groupHtml(group: SettingGroup, state: ReturnType<typeof presetState>): string {
    const rows = SETTINGS.filter(setting => setting.group === group.id).map(setting => settingRow(setting, state)).join("\n")
    if (!rows) return ""
    const icon = GROUP_ICONS[group.id]
    return `
                <div class="settings-group">
                    <div class="settings-group-header">
                        <div class="settings-group-title">
                            ${icon ? `<span class="settings-group-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" aria-hidden="true"><path d="${icon}"/></svg></span>` : ""}
                            <h3 class="card-title">${escapeHtml(group.title)}</h3>
                        </div>
                        <p class="card-text">${escapeHtml(group.description)}</p>
                    </div>
${rows}
                </div>`
}

/** The page's sections: a heading, then (for performance) the presets, then the section's cards. */
function sectionsHtml(state: ReturnType<typeof presetState>): string {
    return SETTING_SECTIONS.map(section => {
        const groups = SETTING_GROUPS.filter(group => group.section === section.id).map(group => groupHtml(group, state)).join("\n")
        if (!groups.trim()) return ""
        return `
            <section class="settings-section">
                <div class="settings-section-header">
                    <h2 class="settings-section-title">${escapeHtml(section.title)}</h2>
                    <p class="card-text">${escapeHtml(section.description)}</p>
                </div>
${section.id === "performance" ? presetsHtml(state) : ""}
${groups}
            </section>`
    }).join("\n")
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", { schema: query({ error: string, message: string }) }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { error, message } = request.query as { error?: string, message?: string }
        const recruitment = recruitmentSummary()
        const state = presetState()
        const html = renderPage("settings", "Settings", "settings", {
            notice: noticeHtml(error, message),
            sections: sectionsHtml(state),
            formId: SETTINGS_FORM_ID,
            recruitingRooms: String(recruitment.recruitingRooms),
            availablePlayers: String(recruitment.availablePlayers)
        })
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })
}

export default routes;
