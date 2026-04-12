/// <reference path="./plugin.d.ts" />

/**
 * Dub Tracker
 *
 * Places CC / DUB episode-count badges on anime thumbnail cards.
 */
function init() {
    $ui.register(async (ctx) => {
        const API_OPTIONS = [
            { label: "Aniwatch API", value: "https://aniwatch-api.jc-server.com" },
            { label: "Anime DB", value: "https://anime-db.videasy.net" },
        ]

        const SELECTOR = "[data-media-entry-card-body='true'], [data-media-entry-card-hover-popup-banner-container='true']"
        const CACHE_PREFIX = "dub-counts-v3-"

        const debugRef = ctx.fieldRef("false")
        const apiRef = ctx.fieldRef("https://aniwatch-api.jc-server.com")
        const statusState = ctx.state("Ready")
        const detailState = ctx.state("Idle")
        const cardsFound = ctx.state(0)
        const badgesAdded = ctx.state(0)
        const queueSize = ctx.state(0)

        const fetchQueue: string[] = []
        const queueElements = new Map<string, any[]>()
        const inflight = new Set<string>()
        let fetchInProgress = false

        function isDebug() {
            return debugRef.current === "true"
        }

        function dbg(msg: string) {
            if (isDebug()) ctx.toast.info("[DubTracker] " + msg)
        }

        function getCached(id: string): { sub: number; dub: number } | null {
            try { return $storage.get<{ sub: number; dub: number }>(CACHE_PREFIX + id) || null } catch { return null }
        }

        function setCached(id: string, data: { sub: number; dub: number }) {
            try { $storage.set(CACHE_PREFIX + id, data) } catch { }
        }

        const tray = ctx.newTray({
            tooltipText: "Dub Tracker",
            iconUrl: "https://raw.githubusercontent.com/Bas1874/MyDubList-Seanime/refs/heads/main/src/icons/logo.png",
            withContent: true,
        })

        tray.render(() => tray.stack([
            tray.text("Dub Tracker", { style: { fontWeight: "bold", fontSize: "1rem" } }),
            tray.select("API Host", { options: API_OPTIONS, fieldRef: apiRef }),
            tray.select("Debug Mode", {
                options: [{ label: "Off", value: "false" }, { label: "On", value: "true" }],
                fieldRef: debugRef,
            }),
            tray.text("Status: " + statusState.get(), { style: { fontSize: "0.8rem", color: "#888" } }),
            tray.text(detailState.get(), { style: { fontSize: "0.75rem", color: "#888" } }),
            tray.text("Cards: " + cardsFound.get() + " | Badges: " + badgesAdded.get() + " | Queue: " + queueSize.get(), { style: { fontSize: "0.8rem", color: "#888" } }),
            tray.button("Rescan", { onClick: "rescan", intent: "primary", style: { width: "100%" } }),
        ], { gap: 6, style: { width: "250px", padding: "10px" } }))

        ctx.registerEventHandler("rescan", async () => {
            const processed = await ctx.dom.query("[data-sdt-checked='true']")
            for (const el of processed) {
                await el.removeAttribute("data-sdt-checked")
                await el.removeAttribute("data-sdt-retries")
            }
            const badges = await ctx.dom.query(".sdt-wrapper")
            for (const badge of badges) await badge.remove()
            const badged = await ctx.dom.query("[data-sdt-badge='true']")
            for (const el of badged) await el.removeAttribute("data-sdt-badge")
            fetchQueue.length = 0
            queueElements.clear()
            cardsFound.set(0)
            badgesAdded.set(0)
            queueSize.set(0)
            statusState.set("Rescanning")
            detailState.set("Cleared badges and queue")
            tray.update()
        })

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
            } catch (e) {
                dbg("style error: " + e)
            }
        }

        async function extractMediaId(el: any): Promise<string | null> {
            try {
                const direct = await el.getAttribute("data-media-id")
                if (direct) return direct
            } catch { }

            let cursor = el
            for (let i = 0; i < 5; i++) {
                try {
                    const parent = await cursor.getParent()
                    if (!parent) break
                    const pid = await parent.getAttribute("data-media-id")
                    if (pid) return pid
                    const href = await parent.getAttribute("href")
                    if (href) {
                        const match = href.match(/[?&]id=(\d+)/)
                        if (match) return match[1]
                    }
                    cursor = parent
                } catch {
                    break
                }
            }

            try {
                if (el.innerHTML) {
                    const $ = LoadDoc(el.innerHTML)
                    const linkHref = $("a[href*='id=']").attr("href") || ""
                    const linkMatch = linkHref.match(/[?&]id=(\d+)/)
                    if (linkMatch) return linkMatch[1]

                    const imgSrc = $("img").attr("src") || ""
                    const imgMatch = imgSrc.match(/\/bx(\d+)/) ||
                        imgSrc.match(/\/banner\/(\d+)/) ||
                        imgSrc.match(/\/cover\/.*\/(\d+)/) ||
                        imgSrc.match(/\/media\/(\d+)/)
                    if (imgMatch) return imgMatch[1]
                }
            } catch { }

            return null
        }

        async function fetchEpisodeCounts(mediaId: string): Promise<{ sub: number; dub: number } | null> {
            const cached = getCached(mediaId)
            if (cached) return cached
            if (inflight.has(mediaId)) return null
            inflight.add(mediaId)

            function normalizeTitle(value: string): string {
                return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
            }

            try {
                const aniRes = await ctx.fetch("https://graphql.anilist.co", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        query: "query($id:Int){Media(id:$id){title{english romaji native}}}",
                        variables: { id: parseInt(mediaId, 10) },
                    }),
                })
                const aniData = await aniRes.json()
                const titles = [
                    aniData?.data?.Media?.title?.english,
                    aniData?.data?.Media?.title?.romaji,
                    aniData?.data?.Media?.title?.native,
                ].filter(Boolean)
                const title = titles[0] || ""
                if (!title) {
                    detailState.set("No AniList title for " + mediaId)
                    tray.update()
                    return null
                }

                const searchRes = await ctx.fetch(apiRef.current + "/api/v2/hianime/search?q=" + encodeURIComponent(title))
                if (searchRes.status !== 200) {
                    dbg("search failed: " + searchRes.status)
                    detailState.set("API search failed: " + searchRes.status)
                    tray.update()
                    return null
                }

                const searchData = await searchRes.json()
                const animes = searchData?.data?.animes || []
                if (!animes.length) {
                    detailState.set("No search results for " + title)
                    tray.update()
                    return null
                }

                const normalizedTitles = titles.map(normalizeTitle)
                const match = animes.find((a: any) => normalizedTitles.includes(normalizeTitle(a?.name || ""))) ||
                    animes.find((a: any) => normalizedTitles.some((t: string) => normalizeTitle(a?.name || "").includes(t) || t.includes(normalizeTitle(a?.name || "")))) ||
                    animes[0]
                const eps = match?.episodes
                if (!eps) {
                    detailState.set("No episode data for " + (match?.name || title))
                    tray.update()
                    return null
                }

                const result = {
                    sub: typeof eps.sub === "number" ? eps.sub : 0,
                    dub: typeof eps.dub === "number" ? eps.dub : 0,
                }
                setCached(mediaId, result)
                detailState.set((match?.name || title) + " → CC " + result.sub + " / DUB " + result.dub)
                tray.update()
                return result
            } catch (e) {
                dbg("fetch error: " + e)
                statusState.set("Fetch error")
                detailState.set(String(e))
                tray.update()
                return null
            } finally {
                inflight.delete(mediaId)
            }
        }

        async function addBadge(el: any, counts: { sub: number; dub: number }) {
            try {
                let target = el
                let cursor = el
                for (let i = 0; i < 4; i++) {
                    try {
                        const parent = await cursor.getParent()
                        if (!parent) break
                        const href = await parent.getAttribute("href")
                        const mediaId = await parent.getAttribute("data-media-id")
                        if (href || mediaId) {
                            target = parent
                            break
                        }
                        cursor = parent
                    } catch {
                        break
                    }
                }

                if (await target.getAttribute("data-sdt-badge")) return

                const wrapper = await ctx.dom.createElement("div")
                await wrapper.setProperty("className", "sdt-wrapper sdt-hide-on-hover")
                await wrapper.setProperty("style",
                    "position:absolute;top:6px;right:4px;z-index:10;display:flex;flex-direction:column;gap:2px;pointer-events:none;"
                )
                await wrapper.setProperty("innerHTML",
                    '<span style="display:inline-block;background:#047857;color:#fff;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;line-height:1.6;">CC: ' + counts.sub + '</span>' +
                    '<span style="display:inline-block;background:#1d4ed8;color:#fff;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;line-height:1.6;">DUB: ' + counts.dub + '</span>'
                )
                await target.setStyle("position", "relative")
                await target.append(wrapper)
                await target.setAttribute("data-sdt-badge", "true")
                badgesAdded.set(badgesAdded.get() + 1)
                detailState.set("Injected badge")
                tray.update()
            } catch (e) {
                dbg("badge error: " + e)
                detailState.set("Badge error: " + String(e))
                tray.update()
            }
        }

        async function drainOne() {
            if (fetchInProgress || fetchQueue.length === 0) return
            const mediaId = fetchQueue.shift()
            if (!mediaId) return
            const elements = queueElements.get(mediaId) || []
            queueElements.delete(mediaId)
            queueSize.set(fetchQueue.length)
            if (!elements.length) return

            fetchInProgress = true
            statusState.set("Fetching")
            tray.update()
            try {
                const counts = await fetchEpisodeCounts(mediaId)
                if (counts && (counts.sub > 0 || counts.dub > 0)) {
                    for (const el of elements) await addBadge(el, counts)
                }
            } finally {
                fetchInProgress = false
                statusState.set("Running")
                tray.update()
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

        async function processCard(el: any) {
            try {
                if (await el.getAttribute("data-sdt-checked") === "true") return

                const mediaId = await extractMediaId(el)
                if (!mediaId) {
                    const retries = parseInt(await el.getAttribute("data-sdt-retries") || "0", 10)
                    if (retries >= 10) await el.setAttribute("data-sdt-checked", "true")
                    else await el.setAttribute("data-sdt-retries", String(retries + 1))
                    if (retries === 0) {
                        detailState.set("Could not extract media ID")
                        tray.update()
                    }
                    return
                }

                await el.setAttribute("data-sdt-checked", "true")
                cardsFound.set(cardsFound.get() + 1)
                tray.update()

                const cached = getCached(mediaId)
                if (cached) {
                    if (cached.sub > 0 || cached.dub > 0) await addBadge(el, cached)
                    return
                }

                enqueueCard(mediaId, el)
            } catch (e) {
                dbg("process error: " + e)
            }
        }

        await injectStyles()

        ctx.dom.observe(SELECTOR, async (elements) => {
            for (const el of elements) await processCard(el)
        }, { identifyChildren: true, withInnerHTML: true })

        ctx.setInterval(async () => {
            const unchecked = await ctx.dom.query(
                SELECTOR + ":not([data-sdt-checked='true'])",
                { identifyChildren: true, withInnerHTML: true }
            )
            for (const el of unchecked) await processCard(el)
            await drainOne()
        }, 2000)

        statusState.set("Running")
        detailState.set("Watching cards")
        tray.update()
        ctx.toast.info("Dub Tracker loaded")
    })
}
