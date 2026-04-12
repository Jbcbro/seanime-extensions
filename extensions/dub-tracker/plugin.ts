/// <reference path="./plugin.d.ts" />

/**
 * Dub Tracker
 *
 * Resolves visible AniList IDs into CC / DUB counts, caches them in memory,
 * then renders badges from that local map.
 */
function init() {
    $ui.register(async (ctx) => {
        const API_OPTIONS = [
            { label: "Aniwatch API", value: "https://aniwatch-api.jc-server.com" },
            { label: "Anime DB", value: "https://anime-db.videasy.net" },
        ]

        const SELECTOR = [
            "[data-media-entry-card-body='true']",
            "[data-media-entry-card-hover-popup-banner-container='true']",
            "[data-media-id]",
            "a[href*='?id=']",
            "a[href*='&id=']",
        ].join(", ")
        const CACHE_PREFIX = "dub-counts-v4-"

        const debugRef = ctx.fieldRef("false")
        const apiRef = ctx.fieldRef("https://aniwatch-api.jc-server.com")
        const statusState = ctx.state("Ready")
        const detailState = ctx.state("Idle")
        const cardsFound = ctx.state(0)
        const badgesAdded = ctx.state(0)
        const queueSize = ctx.state(0)

        const countsByMediaId = new Map<string, { sub: number; dub: number } | null>()
        const unresolvedIds = new Set<string>()
        let fetchInProgress = false
        let scanInProgress = false

        function isDebug() {
            return debugRef.current === "true"
        }

        function dbg(msg: string) {
            if (isDebug()) ctx.toast.info("[DubTracker] " + msg)
        }

        function getCachedCounts(mediaId: string): { sub: number; dub: number } | null {
            try {
                return $storage.get<{ sub: number; dub: number }>(CACHE_PREFIX + mediaId) || null
            } catch {
                return null
            }
        }

        function setCachedCounts(mediaId: string, counts: { sub: number; dub: number } | null) {
            try {
                $storage.set(CACHE_PREFIX + mediaId, counts)
            } catch { }
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
            cardsFound.set(0)
            badgesAdded.set(0)
            queueSize.set(0)
            countsByMediaId.clear()
            unresolvedIds.clear()
            statusState.set("Rescanning")
            detailState.set("Cleared DOM badges")
            tray.update()
            await scanNow("Rescan")
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

        function normalizeTitle(value: string): string {
            return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
        }

        async function resolveCountsForMediaId(mediaId: string): Promise<{ sub: number; dub: number } | null> {
            if (countsByMediaId.has(mediaId)) return countsByMediaId.get(mediaId) || null

            const cached = getCachedCounts(mediaId)
            if (cached) {
                countsByMediaId.set(mediaId, cached)
                return cached
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
                    countsByMediaId.set(mediaId, null)
                    setCachedCounts(mediaId, null)
                    return null
                }

                const searchRes = await ctx.fetch(apiRef.current + "/api/v2/hianime/search?q=" + encodeURIComponent(title))
                if (searchRes.status !== 200) {
                    detailState.set("API search failed: " + searchRes.status)
                    tray.update()
                    countsByMediaId.set(mediaId, null)
                    setCachedCounts(mediaId, null)
                    return null
                }

                const searchData = await searchRes.json()
                const animes = searchData?.data?.animes || []
                if (!animes.length) {
                    countsByMediaId.set(mediaId, null)
                    setCachedCounts(mediaId, null)
                    return null
                }

                const normalizedTitles = titles.map(normalizeTitle)
                const match = animes.find((a: any) => normalizedTitles.includes(normalizeTitle(a?.name || ""))) ||
                    animes.find((a: any) => normalizedTitles.some((t: string) => normalizeTitle(a?.name || "").includes(t) || t.includes(normalizeTitle(a?.name || "")))) ||
                    animes[0]

                const eps = match?.episodes
                if (!eps) {
                    countsByMediaId.set(mediaId, null)
                    setCachedCounts(mediaId, null)
                    return null
                }

                const result = {
                    sub: typeof eps.sub === "number" ? eps.sub : 0,
                    dub: typeof eps.dub === "number" ? eps.dub : 0,
                }
                countsByMediaId.set(mediaId, result)
                setCachedCounts(mediaId, result)
                detailState.set((match?.name || title) + " → CC " + result.sub + " / DUB " + result.dub)
                tray.update()
                return result
            } catch (e) {
                dbg("resolve error: " + e)
                countsByMediaId.set(mediaId, null)
                setCachedCounts(mediaId, null)
                detailState.set("Resolve error")
                tray.update()
                return null
            }
        }

        async function resolveVisibleCounts(ids: string[]) {
            if (fetchInProgress || ids.length === 0) return
            fetchInProgress = true
            statusState.set("Resolving")
            queueSize.set(ids.length)
            tray.update()

            try {
                for (let i = 0; i < ids.length; i++) {
                    const mediaId = ids[i]
                    queueSize.set(ids.length - i)
                    tray.update()
                    await resolveCountsForMediaId(mediaId)
                }
            } finally {
                fetchInProgress = false
                queueSize.set(0)
                statusState.set("Running")
                tray.update()
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
                    "position:absolute;top:6px;left:4px;z-index:10;display:flex;flex-direction:column;gap:2px;pointer-events:none;"
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
            }
        }

        async function processElements(elements: any[]) {
            const idsToResolve: string[] = []

            for (const el of elements) {
                try {
                    if (await el.getAttribute("data-sdt-checked") === "true") continue

                    const mediaId = await extractMediaId(el)
                    if (!mediaId) {
                        const retries = parseInt(await el.getAttribute("data-sdt-retries") || "0", 10)
                        if (retries >= 10) await el.setAttribute("data-sdt-checked", "true")
                        else await el.setAttribute("data-sdt-retries", String(retries + 1))
                        continue
                    }

                    await el.setAttribute("data-sdt-checked", "true")
                    cardsFound.set(cardsFound.get() + 1)

                    const cached = getCachedCounts(mediaId)
                    if (cached) {
                        countsByMediaId.set(mediaId, cached)
                        if (cached.sub > 0 || cached.dub > 0) {
                            await addBadge(el, cached)
                        }
                        continue
                    }

                    if (!countsByMediaId.has(mediaId) && !unresolvedIds.has(mediaId)) {
                        unresolvedIds.add(mediaId)
                        idsToResolve.push(mediaId)
                    }
                } catch (e) {
                    dbg("process error: " + e)
                }
            }

            tray.update()

            await resolveVisibleCounts(idsToResolve)

            for (const mediaId of idsToResolve) unresolvedIds.delete(mediaId)

            for (const el of elements) {
                try {
                    const mediaId = await extractMediaId(el)
                    if (!mediaId) continue
                    const counts = countsByMediaId.get(mediaId)
                    if (counts && (counts.sub > 0 || counts.dub > 0)) {
                        await addBadge(el, counts)
                    }
                } catch (e) {
                    dbg("render error: " + e)
                }
            }
        }

        async function scanNow(reason: string) {
            if (scanInProgress) return
            scanInProgress = true

            try {
                const unchecked = await ctx.dom.query(
                    SELECTOR + ":not([data-sdt-checked='true'])",
                    { identifyChildren: true, withInnerHTML: true }
                )
                detailState.set(reason + ": " + unchecked.length + " unchecked")
                tray.update()
                await processElements(unchecked)
            } finally {
                scanInProgress = false
            }
        }

        await injectStyles()

        ctx.dom.observe(SELECTOR, async (elements) => {
            detailState.set("Observer: " + elements.length + " elements")
            tray.update()
            await processElements(elements)
        }, { identifyChildren: true, withInnerHTML: true })

        ctx.screen.onNavigate(async () => {
            await scanNow("Navigate")
        })

        ctx.screen.loadCurrent()

        ctx.setInterval(async () => {
            await scanNow("Interval")
        }, 2000)

        statusState.set("Running")
        detailState.set("Watching cards")
        tray.update()
        ctx.toast.info("Dub Tracker loaded")
    })
}
