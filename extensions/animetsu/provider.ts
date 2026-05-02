/// <reference path="./online-streaming-provider.d.ts" />

// Animetsu (https://animetsu.live) online-stream provider for Seanime.
//
// Reverse-engineered API surface (June 2026):
//   GET  /v2/api/anime/search/?query={q}                -> { results: [{ id, title:{romaji,english,native}, ... }] }
//   GET  /v2/api/anime/info/{mongoId}                   -> { id, anilist_id, mal_id, title, ... }
//   GET  /v2/api/anime/eps/{mongoId}                    -> [{ ep_num, name, id, ... }]
//   GET  /v2/api/anime/servers/{mongoId}/{ep}           -> [{ id, default, tip }]
//   GET  /v2/api/anime/oppai/{mongoId}/{ep}?server={s}&source_type={sub|dub}
//                                                      -> { sources: [{ url, quality, type, need_proxy }] }
//
// All requests require Origin/Referer headers pointing at https://animetsu.live.
// Sources flagged need_proxy must be prepended with https://swiftstream.top/proxy.
class Provider {
    apiBase = "https://animetsu.live/v2/api/anime"
    siteBase = "https://animetsu.live"
    proxyBase = "https://swiftstream.top/proxy"
    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    private apiHeaders(): Record<string, string> {
        return {
            "Origin": this.siteBase,
            "Referer": this.siteBase + "/",
            "Accept": "application/json",
            "User-Agent": this.ua,
        }
    }

    getSettings(): Settings {
        return {
            episodeServers: ["pahe", "kite", "meg", "kiss"],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const tag = opts.dub ? "dub" : "sub"

        const norm = (s: string | undefined | null) =>
            (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "")

        const queries: string[] = []
        const pushQ = (q: string | undefined | null) => {
            if (!q) return
            if (queries.indexOf(q) === -1) queries.push(q)
        }
        pushQ(opts.media.englishTitle ?? undefined)
        pushQ(opts.media.romajiTitle)
        pushQ(opts.query)
        for (const syn of (opts.media.synonyms || []).slice(0, 2)) pushQ(syn)

        const targetEn = norm(opts.media.englishTitle)
        const targetRo = norm(opts.media.romajiTitle)

        const results: { mongoId: string; title: string; score: number }[] = []
        const seen = new Set<string>()

        for (const q of queries) {
            const url = `${this.apiBase}/search/?query=${encodeURIComponent(q)}`
            let data: any
            try {
                data = await fetch(url, { headers: this.apiHeaders() }).then(r => r.json())
            } catch {
                continue
            }
            const items = (data && data.results) || []
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
                })
            }
        }

        if (results.length === 0) return []
        results.sort((a, b) => b.score - a.score)

        // Probe top candidates' /info to find the one whose anilist_id matches.
        // This is more accurate than fuzzy title matching alone.
        const top = results.slice(0, 6)
        for (const c of top) {
            try {
                const info = await fetch(`${this.apiBase}/info/${c.mongoId}`, {
                    headers: this.apiHeaders(),
                }).then(r => r.json())
                if (info?.anilist_id === opts.media.id) {
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

        // No anilist match — return top fuzzy candidates.
        return top.slice(0, 5).map(c => ({
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

        return eps
            .filter((e: any) => typeof e?.ep_num === "number")
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

        const wantedServer = (!server || server === "default") ? "" : server

        // Resolve which server to hit. If the caller asked for "default", use
        // animetsu's own default flag. If they named a specific one, use it
        // verbatim — fall back to the default if the named one isn't offered
        // for this episode.
        let serverId = wantedServer
        try {
            const list: any[] = await fetch(
                `${this.apiBase}/servers/${mongoId}/${epNum}`,
                { headers: this.apiHeaders() },
            ).then(r => r.json())
            if (Array.isArray(list)) {
                if (!serverId) {
                    const def = list.find(s => s?.default) || list[0]
                    serverId = def?.id || "pahe"
                } else if (!list.some(s => s?.id === serverId)) {
                    const def = list.find(s => s?.default) || list[0]
                    if (def?.id) serverId = def.id
                }
            }
        } catch {
            // continue with whatever we had
        }
        if (!serverId) serverId = "pahe"

        const oppaiUrl = `${this.apiBase}/oppai/${mongoId}/${epNum}?server=${encodeURIComponent(serverId)}&source_type=${sourceType}`
        const data = await fetch(oppaiUrl, { headers: this.apiHeaders() }).then(r => r.json())
        const sources = (data && Array.isArray(data.sources)) ? data.sources : []
        if (sources.length === 0) {
            throw new Error(`animetsu: no ${sourceType} sources from server "${serverId}"`)
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
