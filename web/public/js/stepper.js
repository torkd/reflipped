// − / + buttons next to a number field (data-step="-1" / "1"), in place of the browser's own spinners.
// The CSP allows no inline handlers, so the buttons are wired up here.

// Size each field to its value, so the number and its unit stay centred between the buttons.
function fitWidth(input) {
    input.style.width = `${Math.max(1, String(input.value).length) + 0.25}ch`
}

document.querySelectorAll(".unit-input input[type=number]").forEach(input => {
    fitWidth(input)
    input.addEventListener("input", () => fitWidth(input))
})

document.addEventListener("click", event => {
    const button = event.target.closest("[data-step]")
    if (!button) return
    const input = button.parentElement.querySelector("input[type=number]")
    if (!input) return
    if (Number(button.dataset.step) < 0) input.stepDown()
    else input.stepUp()
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
})
