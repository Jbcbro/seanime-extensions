/// <reference path="./plugin.d.ts" />

/**
 * Continuity Sync v1.0.8
 *
 * Root cause: on mobile Safari, getPlaybackStatus() returns stale data
 * (paused=true, currentTime=3) from the moment the video was loaded —
 * video-status WebSocket events never arrive from the browser to update it.
 *
 * Fix: ignore paused/currentTime from getPlaybackStatus().
 * Instead, use a local wall-clock to estimate currentTime.
 * When real events (video-paused, video-status) do arrive, use them
 * to correct the estimate.
 */
function init() {
    $ui.register((ctx) => {

        // ─── Runtime state ────────────────────────────────────────────────
        let trackedMediaId:   number | null = null
        let trackedEpisode:   number        = 0
        let trackedDuration:  number        = 0
        let estimatedCt:      number        = 0   // seconds
        let clockStartWall:   number        = 0   // Date.now() when clock reset
        let clockStartCt:     number        = 0   // video seconds at clock reset
        let isPlaying:        boolean       = false
        let lastSaveMs:       number        = 0
        let bufferFirstSeen: number        = 0   // Date.now() when spinner first detected
        const SAVE_INTERVAL_MS = 10000
        const BUFFER_HIDE_MS   = 5000            // hide spinner after 5s if stuck

        // ─── Tray ─────────────────────────────────────────────────────────
        const statusLine = ctx.state("Polling...")
        const savedLine  = ctx.state("—")
        const debugLine  = ctx.state("—")

        const tray = ctx.newTray({ tooltipText: "Continuity Sync", withContent: true })
        tray.render(() => tray.stack([
            tray.text("Continuity Sync", { style: { fontWeight: "bold", fontSize: "1rem" } }),
            tray.text(statusLine.get(), { style: { fontSize: "0.8rem", color: "#aaa" } }),
            tray.text("Saved: " + savedLine.get(), { style: { fontSize: "0.8rem", color: "#aaa" } }),
            tray.text(debugLine.get(), { style: { fontSize: "0.75rem", color: "#666" } }),
        ], { gap: 4, style: { width: "240px", padding: "10px" } }))

        // ─── Helpers ──────────────────────────────────────────────────────
        function fmtTime(s: number): string {
            const m  = Math.floor(s / 60)
            const ss = Math.floor(s % 60)
            return m + ":" + (ss < 10 ? "0" : "") + ss
        }

        function pick(obj: any, ...keys: string[]): any {
            if (!obj) return undefined
            for (let i = 0; i < keys.length; i++) {
                const v = obj[keys[i]]
                if (v !== undefined && v !== null) return v
            }
            return undefined
        }

        function extractMediaId(state: any): number | null {
            if (!state) return null
            const pi    = pick(state, "playbackInfo", "PlaybackInfo")
            const media = pick(pi,    "media",        "Media")
            const id    = pick(media, "id",           "Id", "ID")
            if (id === undefined || id === null) return null
            const n = parseInt(String(id), 10)
            return n > 0 ? n : null
        }

        function extractEpisode(state: any): number {
            if (!state) return 0
            const pi = pick(state, "playbackInfo", "PlaybackInfo")
            const ep = pick(pi,    "episode",      "Episode")
            if (!ep) return 0
            const v = pick(ep,
                "progressNumber", "ProgressNumber",
                "episodeNumber",  "EpisodeNumber",
                "number",         "Number",
            )
            return v ? parseInt(String(v), 10) : 0
        }

        /** Start / reset the local clock at a known video position */
        function resetClock(videoSeconds: number) {
            clockStartWall = Date.now()
            clockStartCt   = videoSeconds
            isPlaying      = true
        }

        /** Current estimated video time based on wall clock */
        function currentEstimate(): number {
            if (!isPlaying) return clockStartCt
            const elapsed = (Date.now() - clockStartWall) / 1000
            return clockStartCt + elapsed
        }

        // ─── Save (FIXED: single-object arg) ─────────────────────────────
        function save(mediaId: number, episode: number, ct: number, dur: number, reason: string) {
            if (!mediaId || dur <= 0 || ct <= 0) {
                debugLine.set("skip: mid=" + mediaId + " ct=" + Math.floor(ct) + " dur=" + Math.floor(dur))
                tray.update()
                return
            }
            try {
                ctx.continuity.updateWatchHistoryItem({
                    kind:          "mediastream",
                    filepath:      "",
                    mediaId:       mediaId,
                    episodeNumber: episode,
                    currentTime:   ct,
                    duration:      dur,
                })
                savedLine.set(fmtTime(ct) + " / " + fmtTime(dur) + " (" + reason + ")")
                lastSaveMs = Date.now()
                debugLine.set("saved at ct=" + Math.floor(ct) + " ep=" + episode)
                tray.update()
            } catch (e) {
                debugLine.set("save err: " + e)
                tray.update()
            }
        }

        // ─── Primary: poll getPlaybackState() every 3s ────────────────────
        // We DON'T use getPlaybackStatus() for paused/ct — it's always stale
        // on mobile because video-status events don't arrive from the browser.
        // We use it only for duration (set once at load, doesn't go stale).
        ctx.setInterval(() => {
            try {
                const rawState  = ctx.videoCore.getPlaybackState()
                const rawStatus = ctx.videoCore.getPlaybackStatus()

                if (!rawState) {
                    if (trackedMediaId) {
                        // Lost state — do a final save then reset
                        save(trackedMediaId, trackedEpisode, currentEstimate(), trackedDuration, "state-lost")
                        trackedMediaId = null
                        isPlaying = false
                    }
                    statusLine.set("Idle")
                    debugLine.set("no state")
                    tray.update()
                    return
                }

                const mediaId = extractMediaId(rawState)
                const episode = extractEpisode(rawState)
                const dur     = parseFloat(String(pick(rawStatus, "duration", "Duration") || 0))

                if (!mediaId) {
                    statusLine.set("State exists but no mediaId")
                    // Dump top-level keys for debugging
                    try {
                        const pi = pick(rawState, "playbackInfo", "PlaybackInfo")
                        debugLine.set("pi keys=" + (pi ? JSON.stringify(Object.keys(pi)) : "null"))
                    } catch (e) { debugLine.set("dump err: " + e) }
                    tray.update()
                    return
                }

                // New video detected — start the clock
                if (mediaId !== trackedMediaId) {
                    // Use whatever ct getPlaybackStatus has as the starting point
                    // (this is the restore-from-continuity position, e.g. 3s)
                    const initialCt = parseFloat(String(pick(rawStatus, "currentTime", "CurrentTime") || 0))
                    trackedMediaId  = mediaId
                    trackedEpisode  = episode
                    trackedDuration = dur
                    resetClock(initialCt)
                    statusLine.set("Started ep" + episode + " (id " + mediaId + ")")
                    debugLine.set("clock started at ct=" + Math.floor(initialCt))
                    tray.update()
                    return
                }

                // Continuing same video
                if (dur > 0) trackedDuration = dur
                const ct = currentEstimate()

                statusLine.set("Watching ep" + trackedEpisode + " @ " + fmtTime(ct))
                debugLine.set("est ct=" + Math.floor(ct) + " dur=" + Math.floor(trackedDuration) + " wall+" + Math.floor((Date.now() - clockStartWall) / 1000) + "s")
                tray.update()

                const now = Date.now()
                if (now - lastSaveMs >= SAVE_INTERVAL_MS && trackedDuration > 0 && ct > 0) {
                    save(trackedMediaId, trackedEpisode, ct, trackedDuration, "auto")
                }

            } catch (e) {
                statusLine.set("poll err: " + e)
                tray.update()
            }
        }, 3000)

        // ─── Video events: correct the clock when they DO arrive ──────────

        ctx.videoCore.addEventListener("video-status", (e: any) => {
            // When a real status event arrives, sync our clock to actual position
            const ct  = parseFloat(String(pick(e, "currentTime", "CurrentTime") || 0))
            const dur = parseFloat(String(pick(e, "duration",    "Duration")    || 0))
            const psd = !!(pick(e, "paused", "Paused"))
            if (ct > 0) {
                resetClock(ct)
                if (psd) isPlaying = false
                if (dur > 0) trackedDuration = dur
            }
        })

        ctx.videoCore.addEventListener("video-loaded", (e: any) => {
            const state = e.state || e.State
            const mediaId = extractMediaId(state)
            const episode = extractEpisode(state)
            if (mediaId) {
                trackedMediaId = mediaId
                trackedEpisode = episode
                resetClock(0)
                statusLine.set("Loaded ep" + episode + " (id " + mediaId + ")")
                tray.update()
            }
        })

        ctx.videoCore.addEventListener("video-paused", (e: any) => {
            const ct  = parseFloat(String(pick(e, "currentTime", "CurrentTime") || 0))
            const dur = parseFloat(String(pick(e, "duration",    "Duration")    || 0))
            if (ct > 0) resetClock(ct)
            isPlaying = false
            if (dur > 0 && trackedDuration === 0) trackedDuration = dur
            statusLine.set("Paused ep" + trackedEpisode + " @ " + fmtTime(ct || currentEstimate()))
            tray.update()
            if (trackedMediaId) {
                save(trackedMediaId, trackedEpisode, ct || currentEstimate(), trackedDuration, "paused")
            }
        })

        ctx.videoCore.addEventListener("video-resumed", (_e: any) => {
            isPlaying = true
            clockStartWall = Date.now()
            // Don't change clockStartCt — resume from where we paused
            statusLine.set("Watching ep" + trackedEpisode)
            tray.update()
        })

        ctx.videoCore.addEventListener("video-seeked", (e: any) => {
            const ct = parseFloat(String(pick(e, "currentTime", "CurrentTime") || 0))
            if (ct >= 0) resetClock(ct)
        })

        ctx.videoCore.addEventListener("video-terminated", (_e: any) => {
            if (trackedMediaId) {
                save(trackedMediaId, trackedEpisode, currentEstimate(), trackedDuration, "closed")
            }
            trackedMediaId = null
            isPlaying = false
            statusLine.set("Idle")
            tray.update()
        })

        ctx.videoCore.addEventListener("video-ended", (_e: any) => {
            if (trackedMediaId) {
                save(trackedMediaId, trackedEpisode, trackedDuration || currentEstimate(), trackedDuration, "ended")
            }
            trackedMediaId = null
            isPlaying = false
            statusLine.set("Idle")
            tray.update()
        })

        // ─── Auto-hide stuck buffering spinner on mobile Safari ──────────
        ctx.setInterval(async () => {
            try {
                const el = await ctx.dom.queryOne("[data-vc-element='buffering-indicator']")
                if (el) {
                    if (bufferFirstSeen === 0) {
                        bufferFirstSeen = Date.now()
                    } else if (Date.now() - bufferFirstSeen >= BUFFER_HIDE_MS) {
                        await el.setStyle("display", "none")
                        bufferFirstSeen = 0
                    }
                } else {
                    bufferFirstSeen = 0
                }
            } catch (_) {}
        }, 3000)

        tray.update()
    })
}
