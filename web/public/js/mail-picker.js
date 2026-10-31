// Send mail card on the admin player page: an item/armament/unit/title picker over /api/catalog, and the submit.
(() => {
    const form = document.getElementById("send-mail")
    if (!form) return

    const playerId = form.dataset.playerId
    const typeSelect = form.elements.namedItem("type")
    const typeIdInput = form.elements.namedItem("typeId")
    const typeIdLabel = document.getElementById("mail-type-id-label")
    const picker = document.getElementById("mail-picker")
    const search = document.getElementById("mail-picker-search")
    const unitFilters = document.getElementById("mail-picker-unit-filters")
    const grid = document.getElementById("mail-picker-grid")
    const summary = document.getElementById("mail-picker-summary")
    const selection = document.getElementById("mail-picker-selection")
    const status = document.getElementById("send-mail-status")

    const maxTiles = 240
    const elements = [
        { name: "Fire", color: "#e5533d" },
        { name: "Water", color: "#3d8be5" },
        { name: "Thunder", color: "#d9b520" },
        { name: "Wind", color: "#38b36a" },
        { name: "Light", color: "#c9a85a" },
        { name: "Dark", color: "#8a5ad6" }
    ]
    const kinds = {
        CHARACTER: { list: "units", label: "Unit" },
        EQUIPMENT: { list: "equipment", label: "Armament" },
        ITEM: { list: "items", label: "Item" },
        DEGREE: { list: "degrees", label: "Title" }
    }

    let catalog = null
    const rarityFilter = new Set()
    const elementFilter = new Set()

    const kind = () => kinds[typeSelect.value]
    const entries = () => (catalog && kind()) ? catalog[kind().list] : []
    const selectedId = () => Number(typeIdInput.value) || null
    const titleOf = (entry) => entry.name ?? `${kind().label} ${entry.id}`

    function chip(label, active, onClick, color) {
        const button = document.createElement("button")
        button.type = "button"
        button.className = active ? "badge-on" : "badge-off"
        button.textContent = label
        if (color) button.style.boxShadow = `inset 3px 0 0 ${color}`
        button.addEventListener("click", onClick)
        return button
    }

    // style.display, not the hidden attribute: a display class such as `flex` would override it
    const show = (element, visible) => { element.style.display = visible ? "" : "none" }

    function renderUnitFilters() {
        unitFilters.replaceChildren()
        show(unitFilters, typeSelect.value === "CHARACTER")
        if (typeSelect.value !== "CHARACTER") return
        for (const rarity of [5, 4, 3, 2, 1]) {
            unitFilters.append(chip(`${rarity}★`, rarityFilter.has(rarity), () => toggle(rarityFilter, rarity)))
        }
        elements.forEach((element, index) => {
            unitFilters.append(chip(element.name, elementFilter.has(index), () => toggle(elementFilter, index), element.color))
        })
    }

    function toggle(set, value) {
        set.has(value) ? set.delete(value) : set.add(value)
        render()
    }

    function matches(entry) {
        const query = search.value.trim().toLowerCase()
        if (query && !String(entry.id).includes(query) && !(entry.name ?? "").toLowerCase().includes(query)) return false
        if (typeSelect.value === "CHARACTER") {
            if (rarityFilter.size > 0 && !rarityFilter.has(entry.rarity)) return false
            if (elementFilter.size > 0 && !elementFilter.has(entry.element)) return false
        }
        return true
    }

    function tile(entry) {
        const button = document.createElement("button")
        button.type = "button"
        const selected = entry.id === selectedId()
        button.className = `flex flex-col items-start gap-1 p-3 rounded-xl border text-left transition-colors hover:bg-surface-container-high ${selected ? "border-primary ring-2 ring-primary bg-surface-container-high" : "border-outline-variant"}`
        if (entry.element !== undefined) button.style.borderLeft = `4px solid ${elements[entry.element]?.color ?? "transparent"}`

        const title = document.createElement("span")
        title.className = "text-sm font-semibold text-on-surface truncate w-full"
        title.textContent = titleOf(entry)
        const meta = document.createElement("span")
        meta.className = "text-xs text-on-surface-variant"
        meta.textContent = entry.rarity !== undefined
            ? `${"★".repeat(entry.rarity)} · ${elements[entry.element]?.name ?? "?"} · #${entry.id}`
            : `#${entry.id}`
        button.append(title, meta)
        button.addEventListener("click", () => {
            typeIdInput.value = entry.id
            render()
        })
        return button
    }

    function renderSelection() {
        const id = selectedId()
        if (!kind() || id === null) {
            selection.textContent = ""
            return
        }
        const entry = entries().find(candidate => candidate.id === id)
        selection.className = `text-sm font-semibold ${entry ? "text-primary" : "text-error"}`
        selection.textContent = entry
            ? `Selected: ${titleOf(entry)} (#${id})`
            : `#${id} is not in the game data Reflipped knows; the game may fail to show it (C8601).`
    }

    function render() {
        const needsId = kind() !== undefined
        show(picker, needsId)
        show(typeIdLabel, needsId)
        typeIdInput.required = needsId
        if (!needsId) typeIdInput.value = ""
        renderSelection()
        if (!needsId) return
        renderUnitFilters()
        if (!catalog) {
            summary.textContent = "Loading the catalog…"
            return
        }

        const all = entries()
        const shown = all.filter(matches)
        grid.replaceChildren(...shown.slice(0, maxTiles).map(tile))
        const names = catalog.hasNames ? "" : " Names aren't extracted yet, so search by ID."
        summary.textContent = shown.length > maxTiles
            ? `Showing ${maxTiles} of ${shown.length} matches (${all.length} in total); narrow the search.${names}`
            : `${shown.length} of ${all.length} shown.${names}`
    }

    typeSelect.addEventListener("change", () => {
        typeIdInput.value = ""
        rarityFilter.clear()
        elementFilter.clear()
        search.value = ""
        render()
    })
    search.addEventListener("input", render)
    typeIdInput.addEventListener("input", render)

    fetch("/api/catalog")
        .then(response => response.json())
        .then(body => { catalog = body })
        .catch(() => { summary.textContent = "Couldn't load the catalog; type the ID instead." })
        .finally(render)

    form.addEventListener("submit", async (event) => {
        event.preventDefault()
        const data = new FormData(form)
        const expiry = data.get("rewardLimitTime")
        const response = await fetch(`/api/player/mail?id=${playerId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                type: data.get("type"),
                typeId: data.get("typeId") ? Number(data.get("typeId")) : null,
                number: Number(data.get("number")),
                subject: data.get("subject"),
                description: data.get("description"),
                rewardLimitTime: expiry ? `${expiry}Z` : null
            })
        })
        const body = await response.json()
        status.className = `text-sm font-semibold ${response.ok ? "text-primary" : "text-error"}`
        status.textContent = response.ok ? `Mail ${body.id} sent.` : body.message
    })

    render()
})()
