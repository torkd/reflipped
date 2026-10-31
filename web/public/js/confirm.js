// Asks before submitting a form with data-confirm="question" (the CSP allows no inline onsubmit handlers).
document.querySelectorAll("form[data-confirm]").forEach(form => {
    form.addEventListener("submit", event => {
        if (!confirm(form.dataset.confirm)) event.preventDefault()
    })
})
