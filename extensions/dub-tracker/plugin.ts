/// <reference path="./plugin.d.ts" />

/**
 * Dub Tracker
 *
 * Renders CC / DUB badges from a prebuilt AniList-ID dataset so badges can
 * appear immediately after the page DOM is ready.
 */
function init() {
    $ui.register(async (ctx) => {
        const SELECTOR = [
            "[data-media-entry-card-body='true']",
            "[data-media-entry-card-hover-popup-banner-container='true']",
            "[data-media-id]",
            "a[href*='?id=']",
            "a[href*='&id=']",
        ].join(", ")

        const DATASET_URL = "https://raw.githubusercontent.com/Jbcbro/seanime-extensions/main/extensions/dub-tracker/data/counts.json"
        const STORAGE_KEY = "dub-tracker-dataset-v1"
        const DATASET_TTL_MS = 6 * 60 * 60 * 1000

        const debugRef = ctx.fieldRef("false")
        const statusState = ctx.state("Starting")
        const detailState = ctx.state("Loading dataset")
        const cardsFound = ctx.state(0)
        const badgesAdded = ctx.state(0)
        const datasetSize = ctx.state(0)

        const countsByMediaId = new Map<string, { sub: number; dub: number }>()
        let scanInProgress = false
        let datasetFetchInProgress = false

        function isDebug() {
            return debugRef.current === "true"
        }

        function dbg(msg: string) {
            if (isDebug()) ctx.toast.info("[DubTracker] " + msg)
        }

        function getNow() {
            return Date.now()
        }

        function getStoredDataset(): { fetchedAt: number; entries: Record<string, any> } | null {
            try {
                return $storage.get<{ fetchedAt: number; entries: Record<string, any> }>(STORAGE_KEY) || null
            } catch {
                return null
            }
        }

        function setStoredDataset(payload: { fetchedAt: number; entries: Record<string, any> }) {
            try {
                $storage.set(STORAGE_KEY, payload)
            } catch { }
        }

        function applyDatasetEntries(entries: Record<string, any>) {
            countsByMediaId.clear()
            for (const mediaId of Object.keys(entries || {})) {
                const entry = entries[mediaId]
                if (!entry) continue
                countsByMediaId.set(mediaId, {
                    sub: typeof entry.sub === "number" ? entry.sub : 0,
                    dub: typeof entry.dub === "number" ? entry.dub : 0,
                })
            }
            datasetSize.set(countsByMediaId.size)
        }

        async function loadDataset(forceRefresh: boolean) {
            if (datasetFetchInProgress) return

            const stored = getStoredDataset()
            const isStoredFresh = !!stored && typeof stored.fetchedAt === "number" && (getNow() - stored.fetchedAt) < DATASET_TTL_MS

            if (!forceRefresh && stored?.entries) {
                applyDatasetEntries(stored.entries)
                detailState.set("Cached dataset: " + countsByMediaId.size + " entries")
                tray.update()
                if (isStoredFresh) return
            }

            datasetFetchInProgress = true
            statusState.set("Refreshing dataset")
            detailState.set("Fetching latest counts")
            tray.update()

            try {
                const response = await ctx.fetch(DATASET_URL)
                if (response.status !== 200) {
                    detailState.set("Dataset fetch failed: " + response.status)
                    tray.update()
                    return
                }

                const payload = await response.json()
                const entries = payload?.entries || {}
                applyDatasetEntries(entries)
                setStoredDataset({ fetchedAt: getNow(), entries })
                statusState.set("Running")
                detailState.set("Dataset ready: " + countsByMediaId.size + " entries")
                tray.update()
            } catch (e) {
                dbg("dataset fetch error: " + e)
                statusState.set("Dataset error")
                detailState.set("Could not refresh dataset")
                tray.update()
            } finally {
                datasetFetchInProgress = false
            }
        }

        const tray = ctx.newTray({
            tooltipText: "Dub Tracker",
            iconUrl: "https://raw.githubusercontent.com/Bas1874/MyDubList-Seanime/refs/heads/main/src/icons/logo.png",
            withContent: true,
        })

        tray.render(() => tray.stack([
            tray.text("Dub Tracker", { style: { fontWeight: "bold", fontSize: "1rem" } }),
            tray.select("Debug Mode", {
                options: [{ label: "Off", value: "false" }, { label: "On", value: "true" }],
                fieldRef: debugRef,
            }),
            tray.text("Status: " + statusState.get(), { style: { fontSize: "0.8rem", color: "#888" } }),
            tray.text(detailState.get(), { style: { fontSize: "0.75rem", color: "#888" } }),
            tray.text("Cards: " + cardsFound.get() + " | Badges: " + badgesAdded.get() + " | Dataset: " + datasetSize.get(), { style: { fontSize: "0.8rem", color: "#888" } }),
            tray.button("Refresh Dataset", { onClick: "refresh-dataset", intent: "primary", style: { width: "100%" } }),
            tray.button("Rescan", { onClick: "rescan", style: { width: "100%" } }),
        ], { gap: 6, style: { width: "250px", padding: "10px" } }))

        ctx.registerEventHandler("refresh-dataset", async () => {
            await loadDataset(true)
            await scanNow("Manual refresh")
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
                tray.update()
            } catch (e) {
                dbg("badge error: " + e)
            }
        }

        async function processElements(elements: any[]) {
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
                    }
                } catch (e) {
                    dbg("process error: " + e)
                }
            }

            tray.update()
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
        await loadDataset(false)

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

        ctx.setInterval(async () => {
            await loadDataset(false)
        }, 15 * 60 * 1000)

        statusState.set("Running")
        detailState.set("Watching cards")
        tray.update()
        ctx.toast.info("Dub Tracker loaded")
    })
}
