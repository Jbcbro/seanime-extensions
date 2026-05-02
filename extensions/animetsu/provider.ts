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

        // Trust the requested server name. Seanime passes a name from
        // episodeServers (or "default"). We hit /oppai directly for the
        // primary; if it returns no sources, fall back through the rest of
        // animetsu's known servers in-process — that's still cheaper than
        // listing all of them in episodeServers (which would force Seanime
        // to call findEpisodeServer once per name in serial, on every load).
        // "kite" preferred for default because it gives a master playlist
        // with proper ABR; "pahe" is single-quality and stalls on bandwidth
        // dips, so we only fall back to it when kite has nothing.
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

        const videoSources = sources.map((s: any) => {
            let src: string = s?.url || ""
            if (s?.need_proxy && src) {
                src = src.indexOf("http") === 0
                    ? src
                    : (this.proxyBase + (src.charAt(0) === "/" ? src : "/" + src))
            }
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
            headers: {
                "Origin": this.siteBase,
                "Referer": this.siteBase + "/",
                "User-Agent": this.ua,
            },
            videoSources,
        }
    }
}
