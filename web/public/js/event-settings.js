// Events and rewards form (Settings page): a row that another choice has made irrelevant is dimmed and its controls
// are disabled, so a locked value is not sent (the server keeps what it has). data-locked-unless="field=value" names
// the choice that unlocks the row. The page works without this; the server renders the saved state the same way.
for (const form of document.querySelectorAll("form[data-event-settings]")) {
    const rows = [...form.querySelectorAll("[data-locked-unless]")]
    const update = () => {
        for (const row of rows) {
            const [field, value] = row.dataset.lockedUnless.split("=")
            const locked = form.elements[field]?.value !== value
            row.classList.toggle("setting-row-locked", locked)
            row.querySelectorAll("input, button").forEach(control => { control.disabled = locked })
        }
    }
    form.addEventListener("change", update)
    update()
}
