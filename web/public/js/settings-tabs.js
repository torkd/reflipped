// Page tabs (Settings, Security): one panel at a time. The tabs are plain links (#events, #rewards, #performance, #identity), so the page
// still shows everything (and the links jump) without this script. The chosen tab is in the URL hash and in
// sessionStorage, which is how it survives the redirect after a save.
const tabs = [...document.querySelectorAll("[data-tab]")]
const panels = [...document.querySelectorAll("[data-tab-panel]")]
if (tabs.length > 0) {
    const names = tabs.map(tab => tab.dataset.tab)
    // one remembered tab per page; the Settings page keeps its first key
    const storageKey = location.pathname === "/settings" ? "settings-tab" : `tab:${location.pathname}`
    const show = name => {
        for (const tab of tabs) {
            const selected = tab.dataset.tab === name
            tab.classList.toggle("tab-active", selected)
            tab.setAttribute("aria-selected", String(selected))
        }
        for (const panel of panels) panel.hidden = !panel.dataset.tabPanel.split(" ").includes(name)
    }
    const remembered = () => { try { return sessionStorage.getItem(storageKey) } catch { return null } }
    const initial = [location.hash.slice(1), remembered()].find(name => names.includes(name)) ?? names[0]
    show(initial)
    for (const tab of tabs) {
        tab.addEventListener("click", event => {
            event.preventDefault()
            show(tab.dataset.tab)
            history.replaceState(null, "", `#${tab.dataset.tab}`)
            try { sessionStorage.setItem(storageKey, tab.dataset.tab) } catch { /* private mode: the hash still works */ }
        })
    }
    window.addEventListener("hashchange", () => { if (names.includes(location.hash.slice(1))) show(location.hash.slice(1)) })
}
