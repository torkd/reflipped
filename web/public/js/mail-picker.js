// Send mail card on the admin player page (and, for every player, on the Players page): an item/armament/unit/title/
// challenge point picker over /api/catalog, and the submit.
(() => {
    const form = document.getElementById("send-mail")
    if (!form || form.dataset.rewardLocked === "true") return

    const playerId = form.dataset.playerId
    const toAll = playerId === "all"
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
        DEGREE: { list: "degrees", label: "Title" },
        DAILY_CHALLENGE_POINT: { list: "dailyChallengePoints", label: "Challenge and quest attempts" },
        PERIODIC_REWARD_POINT: { list: "periodicRewardPoints", label: "Daily reward count (co-op)" }
    }

    let catalog = null
    const rarityFilter = new Set()
    const elementFilter = new Set()
    const categoryFilter = new Set()

    const kind = () => kinds[typeSelect.value]
    const entries = () => (catalog && kind()) ? catalog[kind().list] : []
    const selectedId = () => Number(typeIdInput.value) || null
    const titleOf = (entry) => entry.name ?? `${kind().label} ${entry.id}`

    // Thumbnails: loaded only when their tile scrolls into view, a few at a time, and retried when a request fails
    // (the admin listener may refuse a burst, or a request may be lost). A tile never loses its place: when an image
    // keeps failing, it keeps a blank placeholder.
    const maxParallelImages = 6
    const retryDelays = [400, 1200, 3000]
    const pendingImages = []
    let activeImages = 0

    // loads `src` into `image`, retrying with a growing delay, then calls `done(ok)`; `attached()` says whether the
    // tile still exists (a later render replaces them)
    function loadImage(image, src, attached, done, attempt = 0) {
        pendingImages.push({ image, src, attached, done, attempt })
        pumpImages()
    }

    function pumpImages() {
        while (activeImages < maxParallelImages && pendingImages.length > 0) {
            const job = pendingImages.shift()
            if (!job.attached()) continue
            activeImages++
            const finish = (ok) => {
                job.image.removeEventListener("load", onLoad)
                job.image.removeEventListener("error", onError)
                activeImages--
                if (ok || job.attempt >= retryDelays.length) {
                    job.done(ok)
                } else {
                    const delay = retryDelays[job.attempt] * (0.75 + Math.random() * 0.5)
                    setTimeout(() => loadImage(job.image, job.src, job.attached, job.done, job.attempt + 1), delay)
                }
                pumpImages()
            }
            const onLoad = () => finish(true)
            const onError = () => finish(false)
            job.image.addEventListener("load", onLoad)
            job.image.addEventListener("error", onError)
            job.image.removeAttribute("src")
            job.image.src = job.src
        }
    }

    // calls `callback` once when `element` first scrolls into the grid's view (at once without IntersectionObserver)
    const visibleCallbacks = new WeakMap()
    const visibility = typeof IntersectionObserver === "function"
        ? new IntersectionObserver((records) => {
            for (const record of records) {
                if (!record.isIntersecting) continue
                visibility.unobserve(record.target)
                visibleCallbacks.get(record.target)?.()
            }
        }, { root: grid, rootMargin: "120px" })
        : null
    function whenVisible(element, callback) {
        // without an observer, load once the tile is in the grid (the caller appends it after this returns)
        if (!visibility) return void setTimeout(callback, 0)
        visibleCallbacks.set(element, callback)
        visibility.observe(element)
    }

    // The item and armament icons are all cut out of one sprite sheet. It is requested once, by a detached image
    // (with retries); the tiles then show their part of it as a CSS background, which reuses that one download.
    const sheetUrl = "/api/catalog/sheet"
    let sheetLoad = null
    function loadSheet() {
        if (!sheetLoad) {
            sheetLoad = new Promise((resolve) => {
                const image = new Image()
                loadImage(image, sheetUrl, () => true, (ok) => {
                    if (!ok) sheetLoad = null // a later render tries again
                    resolve(ok ? { width: image.naturalWidth, height: image.naturalHeight } : null)
                })
            })
        }
        return sheetLoad
    }

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

    // units: rarity and element; armaments: rarity; items: category (the last two only with names extracted)
    function renderFilters() {
        unitFilters.replaceChildren()
        const type = typeSelect.value
        const hasDetails = catalog?.hasNames === true
        const rarities = type === "CHARACTER" || (type === "EQUIPMENT" && hasDetails)
        const categories = type === "ITEM" && hasDetails
        show(unitFilters, rarities || categories)
        if (rarities) {
            for (const rarity of [5, 4, 3, 2, 1]) {
                unitFilters.append(chip(`${rarity}★`, rarityFilter.has(rarity), () => toggle(rarityFilter, rarity)))
            }
        }
        if (type === "CHARACTER") {
            elements.forEach((element, index) => {
                unitFilters.append(chip(element.name, elementFilter.has(index), () => toggle(elementFilter, index), element.color))
            })
        }
        if (categories) {
            const present = new Set(entries().map(entry => entry.category))
            for (const category of catalog.itemCategories.filter(name => present.has(name))) {
                unitFilters.append(chip(category, categoryFilter.has(category), () => toggle(categoryFilter, category)))
            }
        }
    }

    function toggle(set, value) {
        set.has(value) ? set.delete(value) : set.add(value)
        render()
    }

    function matches(entry) {
        const query = search.value.trim().toLowerCase()
        if (query && !String(entry.id).includes(query) && !(entry.name ?? "").toLowerCase().includes(query)) return false
        if (rarityFilter.size > 0 && !rarityFilter.has(entry.rarity)) return false
        if (elementFilter.size > 0 && !elementFilter.has(entry.element)) return false
        if (categoryFilter.size > 0 && !categoryFilter.has(entry.category)) return false
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
        const details = []
        if (entry.rarity) details.push("★".repeat(entry.rarity))
        if (entry.element !== undefined) details.push(elements[entry.element]?.name ?? "?")
        if (entry.category) details.push(entry.category)
        meta.textContent = [...details, `#${entry.id}`].join(" · ")
        if (typeSelect.value === "CHARACTER") {
            const img = document.createElement("img")
            img.alt = ""
            img.width = 40
            img.height = 40
            img.className = "object-contain"
            const src = `/api/catalog/thumbnail/units/${entry.id}`
            whenVisible(img, () => loadImage(img, src, () => img.isConnected, (ok) => {
                if (!ok) img.className = "object-contain rounded-lg bg-surface-container-high"
            }))
            button.append(img)
        } else if (entry.thumbnail) {
            const { x, y, w, h, r } = entry.thumbnail
            const scale = Math.min(2, 40 / Math.max(w, h))
            const frame = document.createElement("span")
            frame.className = "flex items-center justify-center w-12 h-12 shrink-0"
            frame.setAttribute("aria-hidden", "true")
            const crop = document.createElement("span")
            crop.className = "block shrink-0"
            crop.style.width = `${w * scale}px`
            crop.style.height = `${h * scale}px`
            if (r) crop.style.transform = "rotate(-90deg)"
            frame.append(crop)
            whenVisible(frame, () => loadSheet().then((sheet) => {
                if (!sheet || !frame.isConnected) return
                crop.style.backgroundImage = `url(${sheetUrl})`
                crop.style.backgroundRepeat = "no-repeat"
                crop.style.backgroundSize = `${sheet.width * scale}px ${sheet.height * scale}px`
                crop.style.backgroundPosition = `${-x * scale}px ${-y * scale}px`
            }))
            button.append(frame)
        }
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
        renderFilters()
        if (!catalog) {
            summary.textContent = "Loading the catalog…"
            return
        }

        const all = entries()
        const shown = all.filter(matches)
        visibility?.disconnect()
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
        categoryFilter.clear()
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

    // the result of sending to all players: how many got it and why the others didn't
    function allPlayersText(result) {
        if (result.players === 0) return "There are no players yet; nothing was sent."
        const skipped = []
        if (result.skippedFull > 0) skipped.push(`${result.skippedFull} with a full gift box`)
        if (result.skippedLimit > 0) skipped.push(`${result.skippedLimit} it would take past a limit`)
        if (result.skippedExpired > 0) skipped.push(`${result.skippedExpired} on whose clock it has expired already`)
        const sent = `Sent to ${result.sent} of ${result.players} player${result.players === 1 ? "" : "s"}.`
        return skipped.length > 0 ? `${sent} Skipped: ${skipped.join(", ")}.` : sent
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault()
        if (form.dataset.confirmSend && !confirm(form.dataset.confirmSend)) return
        const data = new FormData(form)
        const expiry = data.get("rewardLimitTime")
        const response = await fetch(toAll ? "/api/player/mail/all" : `/api/player/mail?id=${playerId}`, {
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
        status.textContent = !response.ok ? body.message : toAll ? allPlayersText(body) : `Mail ${body.id} sent.`
    })

    render()
})()
