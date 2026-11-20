// The light/dark theme switch, on the admin site and the game's public pages. The theme follows the system until
// the switch is used; its choice is kept in this browser (localStorage) and set as data-theme on <html>, which
// src/input.css reads. Loaded in <head> without defer so the page never flashes the other theme.
(function () {
    var KEY = "reflipped-theme"
    var root = document.documentElement
    function stored() {
        try { var value = window.localStorage.getItem(KEY); return value === "light" || value === "dark" ? value : null } catch (error) { return null }
    }
    function system() {
        return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    }
    function apply(theme) {
        root.setAttribute("data-theme", theme)
        var buttons = document.querySelectorAll("[data-theme-toggle]")
        for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute("aria-pressed", theme === "dark" ? "true" : "false")
    }
    apply(stored() || system())
    document.addEventListener("DOMContentLoaded", function () {
        apply(root.getAttribute("data-theme") || system())
        var buttons = document.querySelectorAll("[data-theme-toggle]")
        // the switches are hidden in the markup: without scripts (the app's page windows run none) they would do nothing
        for (var i = 0; i < buttons.length; i++) buttons[i].hidden = false
        for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener("click", function () {
            var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark"
            try { window.localStorage.setItem(KEY, next) } catch (error) { /* the choice just isn't kept */ }
            apply(next)
        })
    })
    // while no choice is stored, a change of the system's theme is followed
    if (window.matchMedia) {
        var query = window.matchMedia("(prefers-color-scheme: dark)")
        var follow = function () { if (stored() === null) apply(system()) }
        if (query.addEventListener) query.addEventListener("change", follow); else if (query.addListener) query.addListener(follow)
    }
})()
