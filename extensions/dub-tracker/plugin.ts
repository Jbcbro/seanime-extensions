/// <reference path="./plugin.d.ts" />

/**
 * Dub Tracker
 *
 * Displays the number of episodes available in CC (sub) and DUB on the anime
 * entry page by checking Gogoanime for both the sub and dub versions.
 */
function init() {
    $ui.register((ctx) => {
        let currentMediaId = 0
        let subEpisodes: number | null = null
        let dubEpisodes: number | null = null
        let isLoading = false

        // Render inline in the anime details panel
        const view = ctx.newWebview({
            slot: "after-media-entry-details",
            fullWidth: true,
            autoHeight: true,
        })

        view.setContent(() => {
            if (!currentMediaId || (!isLoading && subEpisodes === null && dubEpisodes === null)) {
                return "<span></span>"
            }
            if (isLoading) {
                return (
                    "<!DOCTYPE html><html><head><style>" +
                    "body{margin:0;background:transparent;font-family:sans-serif;}" +
                    "</style></head><body>" +
                    "<p style='color:#888;font-size:13px;margin:6px 0;'>Loading episode counts...</p>" +
                    "</body></html>"
                )
            }
            return (
                "<!DOCTYPE html><html><head><style>" +
                "body{margin:0;background:transparent;font-family:sans-serif;}" +
                ".wrap{display:flex;gap:8px;margin:6px 0;}" +
                ".badge{padding:3px 12px;border-radius:5px;font-size:13px;font-weight:600;color:#fff;}" +
                ".cc{background:#1c6a42;}" +
                ".dub{background:#1a4a6b;}" +
                "</style></head><body>" +
                "<div class='wrap'>" +
                "<span class='badge cc'>CC: " + (subEpisodes !== null ? subEpisodes : "?") + "</span>" +
                "<span class='badge dub'>DUB: " + (dubEpisodes !== null ? dubEpisodes : "?") + "</span>" +
                "</div>" +
                "</body></html>"
            )
        })

        // Get the last ep_end value from Gogoanime category page HTML
        function parseEpCount(html: string): number {
            const re = /ep_end="(\d+)"/g
            let match
            let last = 0
            while ((match = re.exec(html)) !== null) {
                const n = parseInt(match[1])
                if (n > last) last = n
            }
            return last
        }

        function fetchCount(slug: string): Promise<number> {
            return ctx.fetch("https://gogoanime3.co/category/" + slug, {
                headers: { "Referer": "https://gogoanime3.co/" },
            })
                .then(function (r: any) { return r.text() })
                .then(function (html: string) { return parseEpCount(html) })
                .catch(function () { return 0 })
        }

        function loadCounts(mediaId: number) {
            currentMediaId = mediaId
            subEpisodes = null
            dubEpisodes = null
            isLoading = true
            view.update()

            ctx.anime.getAnimeEntry(mediaId)
                .then(function (entry: any) {
                    if (!entry || !entry.media) {
                        isLoading = false
                        view.update()
                        return
                    }

                    const title: string =
                        entry.media.title?.english ||
                        entry.media.title?.romaji ||
                        entry.media.title?.userPreferred || ""

                    if (!title) {
                        isLoading = false
                        view.update()
                        return
                    }

                    // Search Gogoanime for the anime slug
                    ctx.fetch(
                        "https://ajax.gogo-load.com/site/loadAjaxSearch?keyword=" +
                        encodeURIComponent(title) +
                        "&id=-1&link_web=https://gogoanime3.co/",
                        { headers: { "Referer": "https://gogoanime3.co/" } }
                    )
                        .then(function (r: any) { return r.text() })
                        .then(function (text: string) {
                            let data: any
                            try { data = JSON.parse(text) } catch (e) { data = {} }

                            const content: string = data.content || ""
                            // Extract first result slug from href="/category/{slug}"
                            const slugMatch = content.match(/href="\/category\/([^"]+)"/)
                            if (!slugMatch) {
                                isLoading = false
                                view.update()
                                return
                            }

                            // Sub slug is the matched result; dub slug appends "-dub"
                            const subSlug: string = slugMatch[1].replace(/-dub$/, "")
                            const dubSlug: string = subSlug + "-dub"

                            fetchCount(subSlug).then(function (sub: number) {
                                subEpisodes = sub
                                fetchCount(dubSlug).then(function (dub: number) {
                                    dubEpisodes = dub
                                    isLoading = false
                                    view.update()
                                })
                            })
                        })
                        .catch(function () {
                            isLoading = false
                            view.update()
                        })
                })
                .catch(function () {
                    isLoading = false
                    view.update()
                })
        }

        function reset() {
            currentMediaId = 0
            subEpisodes = null
            dubEpisodes = null
            isLoading = false
            view.update()
        }

        ctx.screen.onNavigate(function (e: any) {
            if (e.pathname === "/entry" && e.searchParams.id) {
                const id = parseInt(e.searchParams.id)
                if (id !== currentMediaId) {
                    loadCounts(id)
                }
            } else {
                reset()
            }
        })

        ctx.screen.loadCurrent()
    })
}
