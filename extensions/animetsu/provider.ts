/// <reference path="./online-streaming-provider.d.ts" />

// Animetsu (https://animetsu.live) online-stream provider for Seanime.
//
// Reverse-engineered API surface (June 2026):
//   GET  /v2/api/anime/search/?query={q}                -> { results: [{ id, title:{romaji,english,native}, ... }] }
//   GET  /v2/api/anime/info/{mongoId}                   -> { id, anilist_id, mal_id, title, ... }
//   GET  /v2/api/anime/eps/{mongoId}                    -> [{ ep_num, name, id, ... }]
//   GET  /v2/api/anime/oppai/{mongoId}/{ep}?server={s}&source_type={sub|dub}
//                                                      -> { sources: [{ url, quality, type, need_proxy }] }
//
// All requests require Origin/Referer headers pointing at https://animetsu.live.
// Sources flagged need_proxy must be prepended with https://swiftstream.top/proxy.
//
// Performance notes: Animetsu's /oppai endpoint can take 5+s on cold cache and
// Seanime calls findEpisodeServer once per server in episodeServers, in serial.
// To minimize wall time we (a) cache anilist→mongoId so subsequent loads of
// the same anime skip the search/info calls entirely, and (b) skip the
// /servers preflight — Seanime already passes us a server name from settings.
class Provider {
    apiBase = "https://animetsu.live/v2/api/anime"
    siteBase = "https://animetsu.live"
    proxyBase = "https://swiftstream.top/proxy"
    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    // Process-lifetime cache: AniList id -> Animetsu mongoId. Persisted as
    // long as the extension stays loaded.
    private mongoIdByAnilist: Record<string, string> = {}

    private apiHeaders(): Record<string, string> {
        return {
            "Origin": this.siteBase,
            "Referer": this.siteBase + "/",
            "Accept": "application/json",
            "User-Agent": this.ua,
        }
    }

    getSettings(): Settings {
        // Only declare "kite" to the user. It returns a real HLS master
        // playlist with three ABR variants (1080/720/360), so HLS.js
        // switches down on bandwidth dips instead of stalling. The other
        // animetsu servers (pahe, meg, kiss) return single-quality
        // playlists with no master/variants — the player can't ABR and
        // playback stalls on any bandwidth blip. They're still wired up
        // as in-process fallbacks inside findEpisodeServer for the rare
        // case kite has no sources for a given episode.
        return {
            episodeServers: ["kite"],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const tag = opts.dub ? "dub" : "sub"
        const cacheKey = String(opts.media.id)

        // Fast path: we already resolved this AniList id.
        const cached = this.mongoIdByAnilist[cacheKey]
        if (cached) {
            return [{
                id: `${cached}/${tag}`,
                title: opts.media.englishTitle || opts.media.romajiTitle || "Unknown",
                url: `${this.siteBase}/watch/${cached}`,
                subOrDub: tag,
            }]
        }

        const norm = (s: string | undefined | null) =>
            (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "")

        const targetEn = norm(opts.media.englishTitle)
        const targetRo = norm(opts.media.romajiTitle)

        // Try the most-likely query first; only fall back if it returns nothing.
        const tryQueries: string[] = []
        const pushQ = (q: string | undefined | null) => {
            if (!q) return
            if (tryQueries.indexOf(q) === -1) tryQueries.push(q)
        }
        pushQ(opts.media.englishTitle ?? undefined)
        pushQ(opts.media.romajiTitle)
        pushQ(opts.query)

        const fetchSearch = async (q: string) => {
            const url = `${this.apiBase}/search/?query=${encodeURIComponent(q)}`
            try {
                const data = await fetch(url, { headers: this.apiHeaders() }).then(r => r.json())
                return (data && data.results) || []
            } catch {
                return []
            }
        }

        type Cand = { mongoId: string; title: string; score: number; tEn: string; tRo: string }
        const results: Cand[] = []
        const seen = new Set<string>()

        const ingest = (items: any[]) => {
            for (const r of items) {
                if (!r?.id || seen.has(r.id)) continue
                seen.add(r.id)
                const tEn = norm(r?.title?.english)
                const tRo = norm(r?.title?.romaji)
                let score = 0
                if (targetEn && (tEn === targetEn || tRo === targetEn)) score = 100
                else if (targetRo && (tEn === targetRo || tRo === targetRo)) score = 95
                else if (
                    (targetEn && tEn && (tEn.indexOf(targetEn) !== -1 || targetEn.indexOf(tEn) !== -1)) ||
                    (targetRo && tRo && (tRo.indexOf(targetRo) !== -1 || targetRo.indexOf(tRo) !== -1))
                ) score = 60
                results.push({
                    mongoId: r.id,
                    title: r?.title?.english || r?.title?.romaji || r?.title?.native || "Unknown",
                    score,
                    tEn,
                    tRo,
                })
            }
        }

        for (const q of tryQueries) {
            const items = await fetchSearch(q)
            ingest(items)
            if (results.length > 0) break // good enough; don't pay for extra queries
        }
        if (results.length === 0) return []
        results.sort((a, b) => b.score - a.score)

        // Single high-confidence title match? Skip the /info probe entirely.
        const top = results[0]
        if (
            results.length === 1 ||
            top.score >= 95 && (results.length < 2 || results[1].score < top.score)
        ) {
            this.mongoIdByAnilist[cacheKey] = top.mongoId
            return [{
                id: `${top.mongoId}/${tag}`,
                title: top.title,
                url: `${this.siteBase}/watch/${top.mongoId}`,
                subOrDub: tag,
            }]
        }

        // Ambiguous: probe the top few /info responses to find the entry whose
        // anilist_id actually matches.
        for (const c of results.slice(0, 4)) {
            try {
                const info = await fetch(`${this.apiBase}/info/${c.mongoId}`, {
                    headers: this.apiHeaders(),
                }).then(r => r.json())
                if (info?.anilist_id === opts.media.id) {
                    this.mongoIdByAnilist[cacheKey] = c.mongoId
                    return [{
                        id: `${c.mongoId}/${tag}`,
                        title: info?.title?.english || info?.title?.romaji || c.title,
                        url: `${this.siteBase}/watch/${c.mongoId}`,
                        subOrDub: tag,
                    }]
                }
            } catch {
                // continue
            }
        }

        // No exact anilist match — return top fuzzy candidates and let Seanime
        // try them in order.
        return results.slice(0, 5).map(c => ({
            id: `${c.mongoId}/${tag}`,
            title: c.title,
            url: `${this.siteBase}/watch/${c.mongoId}`,
            subOrDub: tag,
        }))
    }

    async findEpisodes(animeId: string): Promise<EpisodeDetails[]> {
        const slash = animeId.indexOf("/")
        const mongoId = slash >= 0 ? animeId.substring(0, slash) : animeId
        const tag = slash >= 0 ? animeId.substring(slash + 1) : "sub"

        const url = `${this.apiBase}/eps/${mongoId}`
        const data = await fetch(url, { headers: this.apiHeaders() }).then(r => r.json())
        const eps = Array.isArray(data) ? data : []

        // Animetsu sometimes lists fractional ep_nums (e.g. 1035.5) for
        // recaps/specials. Seanime's EpisodeDetails.number is an int, so we
        // only keep whole-number episodes; the fractional ones don't map to
        // AniList's episode numbering anyway.
        return eps
            .filter((e: any) => typeof e?.ep_num === "number" && Number.isInteger(e.ep_num))
            .map((e: any) => ({
                id: `${mongoId}|${e.ep_num}|${tag}`,
                number: e.ep_num,
                url: `${this.siteBase}/watch/${mongoId}?ep=${e.ep_num}`,
                title: e?.name || `Episode ${e.ep_num}`,
            }))
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const parts = episode.id.split("|")
        if (parts.length < 3) {
            throw new Error("animetsu: malformed episode id")
        }
        const mongoId = parts[0]
        const epNum = parts[1]
        const tag = parts[2]
        const sourceType = tag === "dub" ? "dub" : "sub"

        const primary = (!server || server === "default") ? "kite" : server
        const fallbackChain = primary === "kite"
            ? ["kite", "pahe", "meg", "kiss"]
            : [primary, "kite", "pahe", "meg", "kiss"]

        let serverId = ""
        let sources: any[] = []
        for (const candidate of fallbackChain) {
            const oppaiUrl = `${this.apiBase}/oppai/${mongoId}/${epNum}?server=${encodeURIComponent(candidate)}&source_type=${sourceType}`
            try {
                const data = await fetch(oppaiUrl, { headers: this.apiHeaders() }).then(r => r.json())
                const got = (data && Array.isArray(data.sources)) ? data.sources : []
                if (got.length > 0) {
                    serverId = candidate
                    sources = got
                    break
                }
            } catch {
                // try next
            }
        }
        if (sources.length === 0) {
            throw new Error(`animetsu: no ${sourceType} sources on any server`)
        }

        const baseHeaders = {
            "Origin": this.siteBase,
            "Referer": this.siteBase + "/",
            "User-Agent": this.ua,
        }

        // Build the absolute URL for one of animetsu's source entries (which
        // come back as proxy-relative paths when need_proxy=true).
        const resolveUrl = (s: any): string => {
            const src: string = s?.url || ""
            if (!src) return ""
            if (src.indexOf("http") === 0) return src
            if (s?.need_proxy) {
                return this.proxyBase + (src.charAt(0) === "/" ? src : "/" + src)
            }
            return src
        }

        // Special-case the master-playlist servers: kite/kiss return a single
        // entry whose URL is an HLS master with 1080/720/360 variants.
        // Seanime's player has ABR disabled and unconditionally locks to the
        // highest variant — so a master playlist effectively forces every
        // user onto 1080p, which stalls whenever their bandwidth falls below
        // the 1080p bitrate.
        //
        // To give the user real quality choice, fetch the master, parse the
        // variants, and return each as a separate VideoSource with an
        // explicit `quality` label. Order [720p, 1080p, 360p] so the
        // player's "first source" default lands on the most sustainable
        // quality for typical home connections.
        const isMasterServer = serverId === "kite" || serverId === "kiss"
        const looksLikeMaster = (sources.length === 1) &&
            (sources[0]?.quality === "master" || sources[0]?.quality === "auto" || !sources[0]?.quality)

        if (isMasterServer && looksLikeMaster) {
            const masterUrl = resolveUrl(sources[0])
            try {
                const masterText = await fetch(masterUrl, { headers: baseHeaders }).then(r => r.text())
                const variants = parseMasterVariants(masterText, masterUrl)
                if (variants.length > 0) {
                    // Drop 1080p entirely. Chromium's MediaSource quota
                    // is ~150 MB per video stream — fixed by the browser
                    // and not overridable. At 1080p (~1.6 Mbps) that's
                    // only ~10 minutes of forward buffer before the
                    // browser evicts back-buffer to make room, which
                    // shows up as a brief mid-playback pause. 720p
                    // (~0.9 Mbps) fits ~17 min of forward buffer in the
                    // same quota — enough that a typical 24-min episode
                    // hits the boundary at most once and often not at
                    // all. 360p stays as the bandwidth-limited fallback.
                    const filtered = variants.filter(v => v.height !== 1080)
                    const eligible = filtered.length > 0 ? filtered : variants
                    const rank = (h: number) => {
                        if (h === 720) return 0
                        if (h === 480) return 1
                        if (h === 360) return 2
                        if (h === 240) return 3
                        return 10
                    }
                    eligible.sort((a, b) => rank(a.height) - rank(b.height))

                    return {
                        server: serverId,
                        headers: baseHeaders,
                        videoSources: eligible.map(v => ({
                            url: v.url,
                            type: "m3u8",
                            quality: `${v.height}p`,
                            subtitles: [],
                        })),
                    }
                }
                // Couldn't parse — fall through to returning the master
                // as-is.
            } catch {
                // network failure — fall through
            }
        }

        const videoSources = sources.map((s: any) => {
            const src = resolveUrl(s)
            const isHls = (s?.type || "").toLowerCase().indexOf("mpegurl") !== -1 || src.indexOf(".m3u8") !== -1
            return {
                url: src,
                type: isHls ? "m3u8" : "mp4",
                quality: s?.quality || "auto",
                subtitles: [],
            }
        }).filter((v: any) => !!v.url)

        return {
            server: serverId,
            headers: baseHeaders,
            videoSources,
        }
    }
}

// parseMasterVariants pulls (resolution, absolute URL) pairs out of an HLS
// master playlist. Resolves relative variant URIs against the master URL.
function parseMasterVariants(text: string, masterUrl: string): { height: number; url: string }[] {
    if (!text || text.indexOf("#EXTM3U") === -1) return []

    const lines = text.split(/\r?\n/)
    const out: { height: number; url: string }[] = []
    let pendingHeight = 0

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
            const m = line.match(/RESOLUTION=\d+x(\d+)/i)
            pendingHeight = m ? parseInt(m[1], 10) : 0
            continue
        }
        if (line && line.charAt(0) !== "#") {
            const url = resolveAgainst(masterUrl, line.trim())
            if (url) out.push({ height: pendingHeight, url })
            pendingHeight = 0
        }
    }
    return out
}

// resolveAgainst resolves a (possibly relative) URI against a base URL,
// without depending on URL APIs that may not be available in Goja.
function resolveAgainst(base: string, ref: string): string {
    if (!ref) return base
    if (ref.indexOf("http://") === 0 || ref.indexOf("https://") === 0) return ref
    if (ref.charAt(0) === "/") {
        const m = base.match(/^(https?:\/\/[^/]+)/i)
        return m ? m[1] + ref : base + ref
    }
    // Relative — drop the last path segment of base and append ref.
    const q = base.indexOf("?")
    const cleanBase = q >= 0 ? base.substring(0, q) : base
    const lastSlash = cleanBase.lastIndexOf("/")
    if (lastSlash < 0) return cleanBase + "/" + ref
    return cleanBase.substring(0, lastSlash + 1) + ref
}
