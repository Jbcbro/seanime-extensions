/// <reference path="./plugin.d.ts" />

/**
 * Dub Tracker
 *
 * Places CC / DUB episode-count badges on anime thumbnail cards.
 * Enable Debug Mode in the tray to diagnose issues.
 * Requests are throttled (one per 2s interval) to avoid rate limiting.
 */
function init() {
    $ui.register(async (ctx) => {

        // ─── Storage helpers ──────────────────────────────────────────────
        const CACHE_PREFIX = "dub-counts-v1-"

        function getCached(id: string): { sub: number; dub: number } | null {
            try { return $storage.get<{ sub: number; dub: number }>(CACHE_PREFIX + id) || null } catch { return null }
        }
        function setCached(id: string, data: { sub: number; dub: number }) {
            try { $storage.set(CACHE_PREFIX + id, data) } catch { }
        }

        // ─── Settings ─────────────────────────────────────────────────────
        const debugRef = ctx.fieldRef($storage.get("sdt-debug") === true ? "true" : "false")

        function isDebug() { return debugRef.current === "true" }
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
            tray.select("Debug Mode", {
                options: [{ label: "Off", value: "false" }, { label: "On", value: "true" }],
                fieldRef: debugRef,
            }),
            tray.button("Save Debug Setting", { onClick: "save-debug", style: { width: "100%" } }),
            tray.button("Clear Cache & Rescan", { onClick: "clear-cache", intent: "warning", style: { width: "100%" } }),
        ], { gap: 6, style: { width: "240px", padding: "10px" } }))

        ctx.registerEventHandler("save-debug", () => {
            $storage.set("sdt-debug", debugRef.current === "true")
            ctx.toast.info("Debug mode " + (isDebug() ? "ON" : "OFF"))
        })

        ctx.registerEventHandler("clear-cache", async () => {
            const processed = await ctx.dom.query("[data-sdt-checked='true']")
            for (const el of processed) await el.removeAttribute("data-sdt-checked")
            const badges = await ctx.dom.query(".sdt-wrapper")
            for (const b of badges) await b.remove()
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
        // The interval tick processes ONE item from the queue per 2s, naturally
        // throttling requests to avoid rate limiting.
        const fetchQueue: string[] = []
        const queueElements = new Map<string, any>()  // mediaId -> card element
        let fetchInProgress = false

        async function drainOne() {
            if (fetchInProgress || fetchQueue.length === 0) return
            const mediaId = fetchQueue.shift()!
            queueSize.set(fetchQueue.length)
            const el = queueElements.get(mediaId)
            queueElements.delete(mediaId)

            if (!el) return

            // Check cache again (may have been populated by a parallel path)
            const cached = getCached(mediaId)
            if (cached) {
                if (cached.sub > 0 || cached.dub > 0) await addBadge(el, cached)
                return
            }

            fetchInProgress = true
            statusState.set("Fetching… (" + fetchQueue.length + " left)")
            tray.update()

            try {
                const counts = await fetchEpisodeCounts(mediaId)
                if (counts && (counts.sub > 0 || counts.dub > 0)) await addBadge(el, counts)
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
            if (queueElements.has(mediaId) || fetchQueue.includes(mediaId)) return
            fetchQueue.push(mediaId)
            queueElements.set(mediaId, el)
            queueSize.set(fetchQueue.length)
        }

        // ─── Fetch episode counts ─────────────────────────────────────────
        const inflight = new Set<string>()

        async function fetchEpisodeCounts(mediaId: string): Promise<{ sub: number; dub: number } | null> {
            const cached = getCached(mediaId)
            if (cached) { dbg("Cache hit: " + mediaId); return cached }
            if (inflight.has(mediaId)) return null
            inflight.add(mediaId)
            dbg("Fetching AniList for " + mediaId)

            try {
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

                const searchRes = await ctx.fetch(
                    "https://ajax.gogo-load.com/site/loadAjaxSearch?keyword=" +
                    encodeURIComponent(title) +
                    "&id=-1&link_web=https://gogoanime3.co/",
                    { headers: { Referer: "https://gogoanime3.co/" } }
                )
                const searchJson = await searchRes.json()
                const html: string = searchJson?.content || ""
                const slugMatch = html.match(/href="\/category\/([^"]+)"/)
                if (!slugMatch) { dbg("No slug for: " + title); return null }

                const subSlug = slugMatch[1].replace(/-dub$/, "")
                const dubSlug = subSlug + "-dub"
                dbg("Slugs: " + subSlug + " / " + dubSlug)

                async function epCount(slug: string): Promise<number> {
                    try {
                        const r = await ctx.fetch("https://gogoanime3.co/category/" + slug, {
                            headers: { Referer: "https://gogoanime3.co/" },
                        })
                        const pageHtml = await r.text()
                        const re = /ep_end="(\d+)"/g
                        let m: any, last = 0
                        while ((m = re.exec(pageHtml)) !== null) {
                            const n = parseInt(m[1])
                            if (n > last) last = n
                        }
                        dbg(slug + " ep count: " + last)
                        return last
                    } catch (e) { dbg("epCount error: " + e); return 0 }
                }

                const sub = await epCount(subSlug)
                const dub = await epCount(dubSlug)
                const result = { sub, dub }
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
                dbg("Badge added for: " + counts.sub + "/" + counts.dub)
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

                // Add to throttled queue instead of fetching immediately
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

        // Every 2s: scan for missed cards AND drain one item from the fetch queue
        ctx.setInterval(async () => {
            const unchecked = await ctx.dom.query(
                SELECTOR + ":not([data-sdt-checked='true'])",
                { identifyChildren: true, withInnerHTML: true }
            )
            if (unchecked.length > 0) dbg("Interval found " + unchecked.length + " unchecked")
            for (const el of unchecked) await processCard(el)

            // Process one queued fetch per tick (rate limiting)
            await drainOne()
        }, 2000)

        statusState.set("Running")
        tray.update()
        dbg("Dub Tracker loaded")
    })
}
