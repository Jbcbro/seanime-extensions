/// <reference path="./plugin.d.ts" />

/**
 * Dub Tracker
 *
 * Shows CC and estimated DUB episode badges on anime thumbnails.
 *
 * Data source: MyDubList (https://github.com/Joelis57/MyDubList) — a static
 * multi-source anime dub database. MyDubList records whether a dub EXISTS per
 * language (not per-episode counts), so dub episode numbers are estimated:
 *   aired = (nextAiringEpisode.episode - 1) if airing, else episodes
 *   CC    = aired
 *   DUB   = aired if the MAL ID appears in MyDubList's English dub index
 */
function init() {
    $ui.register(async (ctx) => {
        const MDL_URL = "https://raw.githubusercontent.com/Joelis57/MyDubList/main/dubs/counts/dubbed_english.json"
        const CACHE_KEY = "dt-mdl-english-v1"
        const CACHE_TTL_MS = 24 * 60 * 60 * 1000

        const SELECTOR = [
            "[data-media-entry-card-body='true']",
            "[data-media-entry-card-hover-popup-banner-container='true']",
            "[data-media-id]",
            "a[href*='?id=']",
            "a[href*='&id=']",
        ].join(", ")

        const debugRef = ctx.fieldRef("false")
        const statusState = ctx.state("Starting")
        const detailState = ctx.state("Idle")
        const cardsFound = ctx.state(0)
        const badgesAdded = ctx.state(0)
        const queueSize = ctx.state(0)

        // AniList id -> { sub, dub } (already estimated)
        const countsByMediaId = new Map<string, { sub: number; dub: number } | null>()
        const queuedIds = new Set<string>()
        let scanInProgress = false
        let resolveInProgress = false

        // MyDubList MAL id -> source confirmation count. Any entry means "dub exists".
        let dubIndex: Record<string, number> = {}

        function isDebug() {
            return debugRef.current === "true"
        }

        function dbg(msg: string) {
            if (isDebug()) ctx.toast.info("[DubTracker] " + msg)
        }

        const tray = ctx.newTray({
            tooltipText: "Dub Tracker",
            iconUrl: "https://raw.githubusercontent.com/Bas1874/MyDubList-Seanime/refs/heads/main/src/icons/logo.png",
            withContent: true,
        })

        tray.render(() => tray.stack([
            tray.text("Dub Tracker", { style: { fontWeight: "bold", fontSize: "1rem" } }),
            tray.text("Source: MyDubList (english)", { style: { fontSize: "0.75rem", color: "#888" } }),
            tray.select("Debug Mode", {
                options: [{ label: "Off", value: "false" }, { label: "On", value: "true" }],
                fieldRef: debugRef,
            }),
            tray.text("Status: " + statusState.get(), { style: { fontSize: "0.8rem", color: "#888" } }),
            tray.text(detailState.get(), { style: { fontSize: "0.75rem", color: "#888" } }),
            tray.text("Cards: " + cardsFound.get() + " | Badges: " + badgesAdded.get() + " | Queue: " + queueSize.get(), { style: { fontSize: "0.8rem", color: "#888" } }),
            tray.button("Refresh dub data", { onClick: "refresh-mdl", style: { width: "100%" } }),
            tray.button("Rescan", { onClick: "rescan", intent: "primary", style: { width: "100%" } }),
        ], { gap: 6, style: { width: "250px", padding: "10px" } }))

        async function loadDubIndex(forceRefresh: boolean): Promise<void> {
            try {
                if (!forceRefresh) {
                    const cached = $storage.get<{ data: Record<string, number>; ts: number }>(CACHE_KEY)
                    if (cached && cached.data && (Date.now() - cached.ts) < CACHE_TTL_MS) {
                        dubIndex = cached.data
                        detailState.set("Loaded " + Object.keys(dubIndex).length + " dubs (cached)")
                        tray.update()
                        return
                    }
                }

                statusState.set("Fetching dub index")
                tray.update()

                const res = await ctx.fetch(MDL_URL)
                if (res.status !== 200) {
                    detailState.set("MyDubList fetch failed: " + res.status)
                    tray.update()
                    return
                }
                const data = await res.json()
                dubIndex = data || {}
                $storage.set(CACHE_KEY, { data: dubIndex, ts: Date.now() })
                detailState.set("Loaded " + Object.keys(dubIndex).length + " dubs")
                tray.update()
            } catch (e) {
                dbg("dub index error: " + e)
                detailState.set("Dub index error")
                tray.update()
            }
        }

        ctx.registerEventHandler("refresh-mdl", async () => {
            await loadDubIndex(true)
            await scanNow("Refresh")
        })

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
            detailState.set("Cleared badges")
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

        async function resolveBatch(mediaIds: string[]): Promise<void> {
            const intIds = mediaIds.map((s) => parseInt(s, 10)).filter((n) => !isNaN(n))
            if (!intIds.length) return

            try {
                const res = await ctx.fetch("https://graphql.anilist.co", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        query: "query($ids:[Int]){Page(page:1,perPage:50){media(id_in:$ids,type:ANIME){id idMal episodes status nextAiringEpisode{episode}}}}",
                        variables: { ids: intIds },
                    }),
                })
                const data = await res.json()
                const list = data?.data?.Page?.media || []
                const seen = new Set<string>()

                for (const m of list) {
                    const id = String(m.id)
                    seen.add(id)

                    const total = typeof m.episodes === "number" ? m.episodes : 0
                    const next = m.nextAiringEpisode?.episode
                    const aired = typeof next === "number" && next > 0
                        ? Math.max(0, next - 1)
                        : total

                    const hasDub = m.idMal != null && Object.prototype.hasOwnProperty.call(dubIndex, String(m.idMal))

                    const sub = aired
                    const dub = hasDub ? aired : 0

                    countsByMediaId.set(id, sub > 0 || dub > 0 ? { sub, dub } : null)
                }

                for (const id of mediaIds) {
                    if (!seen.has(id) && !countsByMediaId.has(id)) {
                        countsByMediaId.set(id, null)
                    }
                }
            } catch (e) {
                dbg("anilist batch error: " + e)
                for (const id of mediaIds) {
                    if (!countsByMediaId.has(id)) countsByMediaId.set(id, null)
                }
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
                const dubBadge = counts.dub > 0
                    ? '<span style="display:inline-block;background:#1d4ed8;color:#fff;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;line-height:1.6;">DUB: ' + counts.dub + '</span>'
                    : ''
                await wrapper.setProperty("innerHTML",
                    '<span style="display:inline-block;background:#047857;color:#fff;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;line-height:1.6;">CC: ' + counts.sub + '</span>' +
                    dubBadge
                )
                await target.setStyle("position", "relative")
                await target.append(wrapper)
                await target.setAttribute("data-sdt-badge", "true")
                badgesAdded.set(badgesAdded.get() + 1)
                tray.update()
            } catch (e) {
                dbg("badge error: " + e)
            }
        }

        async function resolveQueuedIds(ids: string[]) {
            if (resolveInProgress || ids.length === 0) return
            resolveInProgress = true
            statusState.set("Resolving")
            queueSize.set(ids.length)
            tray.update()

            try {
                const BATCH = 40
                for (let i = 0; i < ids.length; i += BATCH) {
                    const slice = ids.slice(i, i + BATCH)
                    queueSize.set(ids.length - i)
                    tray.update()
                    await resolveBatch(slice)
                    for (const id of slice) queuedIds.delete(id)
                }
            } finally {
                resolveInProgress = false
                queueSize.set(0)
                statusState.set("Running")
                tray.update()
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

                    const counts = countsByMediaId.get(mediaId)
                    if (counts && (counts.sub > 0 || counts.dub > 0)) {
                        await addBadge(el, counts)
                        continue
                    }

                    if (!countsByMediaId.has(mediaId) && !queuedIds.has(mediaId)) {
                        queuedIds.add(mediaId)
                        idsToResolve.push(mediaId)
                    }
                } catch (e) {
                    dbg("process error: " + e)
                }
            }

            tray.update()
            await resolveQueuedIds(idsToResolve)

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

        await loadDubIndex(false)
        await injectStyles()

        ctx.dom.observe(SELECTOR, async (elements) => {
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
        ctx.toast.info("Dub Tracker loaded (MyDubList)")
    })
}
