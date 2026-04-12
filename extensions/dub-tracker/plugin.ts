/// <reference path="./plugin.d.ts" />

/**
 * Dub Tracker
 *
 * Places CC / DUB episode-count badges on anime thumbnail cards.
 * Uses a self-hosted aniwatch-api instance for reliable sub/dub counts.
 * Enable Debug Mode in the tray to diagnose issues.
 */
function init() {
    $ui.register(async (ctx) => {

        // ─── Storage helpers ──────────────────────────────────────────────
        const CACHE_PREFIX = "dub-counts-v2-"
        const DEFAULT_API_BASE = "https://aniwatch-api.jc-server.com"

        function getCached(id: string): { sub: number; dub: number } | null {
            try { return $storage.get<{ sub: number; dub: number }>(CACHE_PREFIX + id) || null } catch { return null }
        }
        function setCached(id: string, data: { sub: number; dub: number }) {
            try { $storage.set(CACHE_PREFIX + id, data) } catch { }
        }

        // ─── Settings ─────────────────────────────────────────────────────
        const debugRef = ctx.fieldRef($storage.get("sdt-debug") === true ? "true" : "false")
        const apiBaseRef = ctx.fieldRef(String($storage.get("sdt-api-base") || DEFAULT_API_BASE))

        function isDebug() { return debugRef.current === "true" }
        function getApiBase() {
            return String(apiBaseRef.current || DEFAULT_API_BASE).trim().replace(/\/+$/, "")
        }
        function dbg(msg: string) {
            if (isDebug()) ctx.toast.info("[DubTracker] " + msg)
        }

        // ─── Tray ─────────────────────────────────────────────────────────
        const statusState = ctx.state("Starting…")
        const cardsFound = ctx.state(0)
        const badgesAdded = ctx.state(0)
        const queueSize = ctx.state(0)

        const tray = ctx.newTray({
            tooltipText: "Dub Tracker",
            iconUrl: "https://raw.githubusercontent.com/Bas1874/MyDubList-Seanime/refs/heads/main/src/icons/logo.png",
            withContent: true,
        })

        tray.render(() => tray.stack([
            tray.text("Dub Tracker", { style: { fontWeight: "bold", fontSize: "1rem" } }),
            tray.text("Status: " + statusState.get(), { style: { fontSize: "0.8rem", color: "#aaa" } }),
            tray.text("Cards: " + cardsFound.get() + " | Badges: " + badgesAdded.get() + " | Queue: " + queueSize.get(), { style: { fontSize: "0.8rem", color: "#aaa" } }),
            tray.text("API Base URL", { style: { fontSize: "0.8rem", color: "#aaa" } }),
            tray.input({ fieldRef: apiBaseRef, placeholder: DEFAULT_API_BASE }),
            tray.select("Debug Mode", {
                options: [{ label: "Off", value: "false" }, { label: "On", value: "true" }],
                fieldRef: debugRef,
            }),
            tray.button("Save Settings", { onClick: "save-debug", style: { width: "100%" } }),
            tray.button("Clear Cache & Rescan", { onClick: "clear-cache", intent: "warning", style: { width: "100%" } }),
        ], { gap: 6, style: { width: "240px", padding: "10px" } }))

        ctx.registerEventHandler("save-debug", () => {
            $storage.set("sdt-debug", debugRef.current === "true")
            $storage.set("sdt-api-base", getApiBase())
            ctx.toast.info("Settings saved")
        })

        ctx.registerEventHandler("clear-cache", async () => {
            const processed = await ctx.dom.query("[data-sdt-checked='true']")
            const clearedIds = new Set<string>()
            for (const el of processed) {
                const mediaId = await extractMediaId(el)
                if (mediaId && !clearedIds.has(mediaId)) {
                    clearedIds.add(mediaId)
                    try { $storage.remove(CACHE_PREFIX + mediaId) } catch { }
                }
                await el.removeAttribute("data-sdt-checked")
                await el.removeAttribute("data-sdt-retries")
            }
            const badges = await ctx.dom.query(".sdt-wrapper")
            for (const b of badges) await b.remove()
            const badged = await ctx.dom.query("[data-sdt-badge='true']")
            for (const el of badged) await el.removeAttribute("data-sdt-badge")
            fetchQueue.length = 0
            queueElements.clear()
            cardsFound.set(0)
            badgesAdded.set(0)
            queueSize.set(0)
            statusState.set("Cache cleared")
            tray.update()
            ctx.toast.info("Dub Tracker: cache cleared")
        })

        // ─── CSS injection ────────────────────────────────────────────────
        const injectStyles = async () => {
            try {
                if (await ctx.dom.queryOne("#sdt-styles")) return
                const style = await ctx.dom.createElement("style")
                await style.setAttribute("id", "sdt-styles")
                await style.setText(`
                    .group\\/media-entry-card:hover .sdt-hide-on-hover {
                        opacity: 0 !important;
                        pointer-events: none !important;
                    }
                `)
                const body = await ctx.dom.queryOne("body")
                if (body) await body.append(style)
            } catch { }
        }
        injectStyles()

        // ─── Extract media ID ─────────────────────────────────────────────
        async function extractMediaId(el: any): Promise<string | null> {
            const direct = await el.getAttribute("data-media-id")
            if (direct) return direct

            let cursor = el
            for (let i = 0; i < 5; i++) {
                try {
                    const p = await cursor.getParent()
                    if (!p) break
                    const pid = await p.getAttribute("data-media-id")
                    if (pid) return pid
                    const href = await p.getAttribute("href")
                    if (href) {
                        const m = href.match(/[?&]id=(\d+)/)
                        if (m) return m[1]
                    }
                    cursor = p
                } catch { break }
            }

            if (el.innerHTML) {
                try {
                    const $ = LoadDoc(el.innerHTML)
                    const imgSrc = $("img").attr("src") || ""
                    const imgMatch = imgSrc.match(/\/bx(\d+)/) ||
                        imgSrc.match(/\/banner\/(\d+)/) ||
                        imgSrc.match(/\/cover\/.*\/(\d+)/) ||
                        imgSrc.match(/\/media\/(\d+)/)
                    if (imgMatch) return imgMatch[1]

                    const linkHref = $("a[href*='id=']").attr("href") || ""
                    const linkMatch = linkHref.match(/[?&]id=(\d+)/)
                    if (linkMatch) return linkMatch[1]
                } catch { }
            }

            return null
        }

        // ─── Throttled fetch queue ────────────────────────────────────────
        // One fetch per 2s interval tick — avoids hammering the API.
        const fetchQueue: string[] = []
        const queueElements = new Map<string, any[]>()
        let fetchInProgress = false

        async function drainOne() {
            if (fetchInProgress || fetchQueue.length === 0) return
            const mediaId = fetchQueue.shift()!
            queueSize.set(fetchQueue.length)
            const elements = queueElements.get(mediaId) || []
            queueElements.delete(mediaId)
            if (elements.length === 0) return

            const cached = getCached(mediaId)
            if (cached) {
                if (cached.sub > 0 || cached.dub > 0) {
                    for (const el of elements) await addBadge(el, cached)
                }
                return
            }

            fetchInProgress = true
            statusState.set("Fetching… (" + fetchQueue.length + " left)")
            tray.update()

            try {
                const counts = await fetchEpisodeCounts(mediaId)
                if (counts && (counts.sub > 0 || counts.dub > 0)) {
                    for (const el of elements) await addBadge(el, counts)
                }
            } catch (e) {
                dbg("drainOne error: " + e)
            } finally {
                fetchInProgress = false
                if (fetchQueue.length === 0) {
                    statusState.set("Running")
                    tray.update()
                }
            }
        }

        function enqueueCard(mediaId: string, el: any) {
            const existing = queueElements.get(mediaId)
            if (existing) {
                existing.push(el)
                return
            }
            fetchQueue.push(mediaId)
            queueElements.set(mediaId, [el])
            queueSize.set(fetchQueue.length)
        }

        // ─── Fetch episode counts via aniwatch-api ────────────────────────
        const inflight = new Set<string>()

        async function fetchEpisodeCounts(mediaId: string): Promise<{ sub: number; dub: number } | null> {
            const cached = getCached(mediaId)
            if (cached) { dbg("Cache hit: " + mediaId); return cached }
            if (inflight.has(mediaId)) return null
            inflight.add(mediaId)

            try {
                // 1. Resolve title via AniList
                const aniRes = await ctx.fetch("https://graphql.anilist.co", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        query: "query($id:Int){Media(id:$id){title{english romaji}}}",
                        variables: { id: parseInt(mediaId) },
                    }),
                })
                const aniData = await aniRes.json()
                const title: string =
                    aniData?.data?.Media?.title?.english ||
                    aniData?.data?.Media?.title?.romaji || ""

                if (!title) { dbg("No title for " + mediaId); return null }
                dbg("Title: " + title)

                // 2. Search aniwatch-api — returns {sub, dub} directly, no scraping
                const apiBase = getApiBase()
                const searchRes = await ctx.fetch(
                    apiBase + "/api/v2/hianime/search?q=" + encodeURIComponent(title),
                )
                if (searchRes.status !== 200) {
                    dbg("Search failed (" + searchRes.status + ") via " + apiBase)
                    return null
                }
                const searchData = await searchRes.json()
                const animes: any[] = searchData?.data?.animes || []

                if (animes.length === 0) { dbg("No results for: " + title); return null }

                // Pick the best match: exact name match first, otherwise first result
                const titleLower = title.toLowerCase()
                const match = animes.find((a: any) =>
                    a.name && a.name.toLowerCase() === titleLower
                ) || animes[0]

                const eps = match?.episodes
                if (!eps) { dbg("No episode data for: " + title); return null }

                const result = {
                    sub: typeof eps.sub === "number" ? eps.sub : 0,
                    dub: typeof eps.dub === "number" ? eps.dub : 0,
                }
                dbg(title + " → sub:" + result.sub + " dub:" + result.dub)
                setCached(mediaId, result)
                return result
            } catch (e) {
                dbg("fetchEpisodeCounts error: " + e)
                return null
            } finally {
                inflight.delete(mediaId)
            }
        }

        // ─── Badge injection ──────────────────────────────────────────────
        async function addBadge(el: any, counts: { sub: number; dub: number }) {
            try {
                const wrapper = await ctx.dom.createElement("div")
                await wrapper.setProperty("className", "sdt-wrapper sdt-hide-on-hover")
                await wrapper.setProperty("style",
                    "position:absolute;top:6px;right:4px;z-index:10;" +
                    "display:flex;flex-direction:column;gap:2px;" +
                    "pointer-events:none;transition:opacity 0.2s;"
                )
                await wrapper.setProperty("innerHTML",
                    '<span style="display:inline-block;background:#047857;color:#fff;' +
                    'border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;line-height:1.6;">CC: ' + counts.sub + '</span>' +
                    '<span style="display:inline-block;background:#1d4ed8;color:#fff;' +
                    'border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;line-height:1.6;">DUB: ' + counts.dub + '</span>'
                )

                let target = el
                try {
                    const p = await el.getParent()
                    if (p) {
                        const href = await p.getAttribute("href")
                        if (href) target = p
                    }
                } catch { }

                if (await target.getAttribute("data-sdt-badge")) return
                await target.setStyle("position", "relative")
                await target.append(wrapper)
                await target.setAttribute("data-sdt-badge", "true")

                badgesAdded.set(badgesAdded.get() + 1)
                tray.update()
                dbg("Badge added: CC " + counts.sub + " / DUB " + counts.dub)
            } catch (e) {
                dbg("addBadge error: " + e)
            }
        }

        // ─── Core processor ───────────────────────────────────────────────
        async function processCard(el: any) {
            try {
                if (await el.getAttribute("data-sdt-checked") === "true") return

                const mediaId = await extractMediaId(el)

                if (!mediaId) {
                    const retries = parseInt(await el.getAttribute("data-sdt-retries") || "0")
                    if (retries >= 10) await el.setAttribute("data-sdt-checked", "true")
                    else await el.setAttribute("data-sdt-retries", String(retries + 1))
                    return
                }

                await el.setAttribute("data-sdt-checked", "true")
                cardsFound.set(cardsFound.get() + 1)
                tray.update()
                dbg("Card found, mediaId=" + mediaId)

                const cached = getCached(mediaId)
                if (cached) {
                    if (cached.sub > 0 || cached.dub > 0) await addBadge(el, cached)
                    return
                }

                enqueueCard(mediaId, el)
            } catch (e) {
                dbg("processCard error: " + e)
            }
        }

        // ─── DOM observation + interval ───────────────────────────────────
        const SELECTOR = "[data-media-entry-card-body='true'], [data-media-entry-card-hover-popup-banner-container='true']"

        ctx.dom.observe(SELECTOR, async (elements) => {
            dbg("Observer fired: " + elements.length + " elements")
            for (const el of elements) await processCard(el)
        }, { identifyChildren: true, withInnerHTML: true })

        // Every 2s: scan for missed cards AND drain one fetch from the queue
        ctx.setInterval(async () => {
            const unchecked = await ctx.dom.query(
                SELECTOR + ":not([data-sdt-checked='true'])",
                { identifyChildren: true, withInnerHTML: true }
            )
            if (unchecked.length > 0) dbg("Interval found " + unchecked.length + " unchecked")
            for (const el of unchecked) await processCard(el)
            await drainOne()
        }, 2000)

        statusState.set("Running")
        tray.update()
        dbg("Dub Tracker loaded")
    })
}
