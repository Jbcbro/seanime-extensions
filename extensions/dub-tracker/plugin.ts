/// <reference path="./plugin.d.ts" />

/**
 * Dub Tracker
 *
 * Places a CC / DUB episode-count badge on every anime thumbnail card.
 * Episode counts are fetched from Gogoanime and cached in $storage so
 * subsequent loads are instant.
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

        // ─── CSS injection ────────────────────────────────────────────────
        const injectStyles = async () => {
            try {
                if (await ctx.dom.queryOne("#seanime-dub-tracker-styles")) return
                const style = await ctx.dom.createElement("style")
                await style.setAttribute("id", "seanime-dub-tracker-styles")
                await style.setText(`
                    .group\\/media-entry-card:hover .sdt-badge {
                        opacity: 0 !important;
                        pointer-events: none !important;
                    }
                `)
                const body = await ctx.dom.queryOne("body")
                if (body) await body.append(style)
            } catch { }
        }
        injectStyles()

        // ─── Tray ─────────────────────────────────────────────────────────
        const statusState = ctx.state("Idle")
        const tray = ctx.newTray({
            tooltipText: "Dub Tracker",
            iconUrl: "https://raw.githubusercontent.com/Bas1874/MyDubList-Seanime/refs/heads/main/src/icons/logo.png",
            withContent: true,
        })

        tray.render(() => tray.stack([
            tray.text("Dub Tracker", { style: { fontWeight: "bold", fontSize: "1rem" } }),
            tray.text(statusState.get(), { style: { fontSize: "0.8rem", color: "#888" } }),
            tray.button("Clear Cache & Rescan", { onClick: "clear-cache", intent: "warning", style: { width: "100%" } }),
        ], { gap: 6, style: { width: "220px", padding: "10px" } }))

        ctx.registerEventHandler("clear-cache", async () => {
            // Remove all cached episode counts
            const processed = await ctx.dom.query("[data-sdt-checked='true']")
            for (const el of processed) {
                await el.removeAttribute("data-sdt-checked")
            }
            const badges = await ctx.dom.query(".sdt-wrapper")
            for (const b of badges) await b.remove()
            statusState.set("Cache cleared — rescanning…")
            tray.update()
        })

        // ─── Episode count fetcher ─────────────────────────────────────────
        // In-flight dedup: avoid firing two fetches for the same media ID simultaneously
        const inflight = new Set<string>()

        async function getEpisodeCounts(mediaId: string): Promise<{ sub: number; dub: number } | null> {
            const cached = getCached(mediaId)
            if (cached) return cached
            if (inflight.has(mediaId)) return null
            inflight.add(mediaId)

            try {
                // 1. Resolve title via AniList GraphQL
                const aniRes = await ctx.fetch("https://graphql.anilist.co", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        query: `query($id:Int){Media(id:$id){title{english romaji}}}`,
                        variables: { id: parseInt(mediaId) },
                    }),
                })
                const aniData = await aniRes.json()
                const title: string =
                    aniData?.data?.Media?.title?.english ||
                    aniData?.data?.Media?.title?.romaji || ""
                if (!title) return null

                // 2. Search Gogoanime for the slug
                const searchRes = await ctx.fetch(
                    "https://ajax.gogo-load.com/site/loadAjaxSearch?keyword=" +
                    encodeURIComponent(title) +
                    "&id=-1&link_web=https://gogoanime3.co/",
                    { headers: { Referer: "https://gogoanime3.co/" } }
                )
                const searchJson = await searchRes.json()
                const html: string = searchJson?.content || ""
                const slugMatch = html.match(/href="\/category\/([^"]+)"/)
                if (!slugMatch) return null

                const subSlug = slugMatch[1].replace(/-dub$/, "")
                const dubSlug = subSlug + "-dub"

                // 3. Fetch ep_end value from each category page
                async function epCount(slug: string): Promise<number> {
                    try {
                        const r = await ctx.fetch("https://gogoanime3.co/category/" + slug, {
                            headers: { Referer: "https://gogoanime3.co/" },
                        })
                        const pageHtml = await r.text()
                        const re = /ep_end="(\d+)"/g
                        let m, last = 0
                        while ((m = re.exec(pageHtml)) !== null) {
                            const n = parseInt(m[1])
                            if (n > last) last = n
                        }
                        return last
                    } catch { return 0 }
                }

                const [sub, dub] = await Promise.all([epCount(subSlug), epCount(dubSlug)])
                const result = { sub, dub }
                setCached(mediaId, result)
                return result
            } catch {
                return null
            } finally {
                inflight.delete(mediaId)
            }
        }

        // ─── Extract media ID from a card element ─────────────────────────
        async function extractMediaId(el: any): Promise<string | null> {
            // Try direct attribute first
            const direct = await el.getAttribute("data-media-id")
            if (direct) return direct

            // Walk up parents looking for data-media-id or href with id=
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

            // Parse innerHTML as last resort
            if (el.innerHTML) {
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
            }

            return null
        }

        // ─── Badge builder ────────────────────────────────────────────────
        async function addBadge(el: any, counts: { sub: number; dub: number }) {
            if (await el.getAttribute("data-sdt-badge")) return

            const wrapper = await ctx.dom.createElement("div")
            await wrapper.setProperty("className",
                "sdt-wrapper sdt-badge absolute z-10 top-2 right-1 flex flex-col gap-0.5 pointer-events-none transition-opacity duration-300"
            )
            await wrapper.setProperty("innerHTML",
                '<span class="inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-bold text-white bg-emerald-700 leading-none">CC: ' + counts.sub + '</span>' +
                '<span class="inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-bold text-white bg-blue-700 leading-none">DUB: ' + counts.dub + '</span>'
            )

            let target = el
            try {
                const p = await el.getParent()
                if (p && await p.getAttribute("href")) target = p
            } catch { }

            await target.setStyle("position", "relative")
            if (!await target.getAttribute("data-sdt-badge")) {
                await target.append(wrapper)
                await target.setAttribute("data-sdt-badge", "true")
            }
        }

        // ─── Core processor ───────────────────────────────────────────────
        const processing = new Set<string>()

        async function processCard(el: any) {
            if (await el.getAttribute("data-sdt-checked") === "true") return

            const mediaId = await extractMediaId(el)

            if (!mediaId) {
                // Retry up to 10 times before giving up
                const retries = parseInt(await el.getAttribute("data-sdt-retries") || "0")
                if (retries >= 10) await el.setAttribute("data-sdt-checked", "true")
                else await el.setAttribute("data-sdt-retries", String(retries + 1))
                return
            }

            // Mark checked immediately to prevent re-entry
            await el.setAttribute("data-sdt-checked", "true")

            // Show cached data instantly if available
            const cached = getCached(mediaId)
            if (cached) {
                if (cached.dub > 0 || cached.sub > 0) await addBadge(el, cached)
                return
            }

            // Fetch asynchronously — don't block the observer
            if (processing.has(mediaId)) return
            processing.add(mediaId)

            getEpisodeCounts(mediaId).then(async (counts) => {
                processing.delete(mediaId)
                if (!counts) return
                if (counts.dub > 0 || counts.sub > 0) await addBadge(el, counts)
            }).catch(() => processing.delete(mediaId))
        }

        // ─── DOM observation ──────────────────────────────────────────────
        const SELECTOR = "[data-media-entry-card-body='true'], [data-media-entry-card-hover-popup-banner-container='true']"

        ctx.dom.observe(SELECTOR, async (elements) => {
            for (const el of elements) await processCard(el)
        }, { identifyChildren: true, withInnerHTML: true })

        ctx.setInterval(async () => {
            const unchecked = await ctx.dom.query(
                SELECTOR + ":not([data-sdt-checked='true'])",
                { identifyChildren: true, withInnerHTML: true }
            )
            for (const el of unchecked) await processCard(el)
        }, 2000)

        statusState.set("Running")
        tray.update()
    })
}
