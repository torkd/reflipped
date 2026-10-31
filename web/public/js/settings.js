// Settings page: shows unsaved edits and how the edited values relate to the presets, and asks before a preset or
// leaving the page throws edits away. The page works without it; the server marks the saved state.
// The fields join the save form with form="settings-form" from several sections, so they are found through the form,
// and their input events (which bubble through the page, not the form) are caught on the document.
const form = document.getElementById("settings-form")
if (form) {
    const inputs = [...form.elements].filter(element => element.matches("input[type=number]"))
    const presets = [...document.querySelectorAll("form[data-preset-values]")].map(presetForm => ({
        form: presetForm,
        title: presetForm.dataset.presetTitle,
        values: JSON.parse(presetForm.dataset.presetValues)
    }))
    const status = document.getElementById("preset-status")
    const unsaved = document.getElementById("unsaved-status")
    const save = document.getElementById("save-settings")
    let leaving = false

    const changedInputs = () => inputs.filter(input => input.value !== input.defaultValue)
    const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`

    function describe(values) {
        const scored = presets.map(preset => ({
            preset,
            differences: Object.entries(preset.values).filter(([key, value]) => values[key] !== value).length
        })).sort((a, b) => a.differences - b.differences)
        const best = scored[0]
        if (!best) return "Custom"
        if (best.differences === 0) return best.preset.title
        return `Custom, based on ${best.preset.title} (${plural(best.differences, "change")})`
    }

    function update() {
        const changed = changedInputs()
        for (const input of inputs) {
            const edited = input.value !== input.defaultValue
            // the badge keeps its space (invisible, not removed), so the row never changes size
            input.closest(".setting-row")?.querySelector("[data-unsaved]")?.classList.toggle("invisible", !edited)
            input.closest(".unit-input")?.classList.toggle("unit-input-edited", edited)
        }
        if (save) save.disabled = changed.length === 0
        if (unsaved) unsaved.textContent = changed.length ? `${plural(changed.length, "unsaved change")}` : ""
        document.getElementById("preset-unsaved")?.classList.toggle("invisible", changed.length === 0)
        if (!status) return
        if (changed.length === 0) {
            status.textContent = status.dataset.saved
            return
        }
        const values = Object.fromEntries(inputs.map(input => [input.name, Number(input.value)]))
        status.textContent = describe(values)
    }

    document.addEventListener("input", event => {
        if (event.target.form === form) update()
    })
    form.addEventListener("submit", () => { leaving = true })
    for (const preset of presets) {
        preset.form.addEventListener("submit", event => {
            const changed = changedInputs().length
            if (changed && !confirm(`Apply ${preset.title}? Your ${plural(changed, "unsaved change")} will be discarded.`)) {
                event.preventDefault()
                return
            }
            leaving = true
        })
    }
    window.addEventListener("beforeunload", event => {
        if (leaving || changedInputs().length === 0) return
        event.preventDefault()
        event.returnValue = ""
    })
    update()
}
