/// <reference path="./plugin.d.ts" />

/**
 * Continuity Sync v1.0.6
 *
 * Dual strategy:
 * 1. Primary: poll getPlaybackState() + getPlaybackStatus() every 3s
 *    (works even when browser doesn't send video events)
 * 2. Supplement: video event listeners for instant save on pause/end
 *
 * Fixes from prior versions:
 * - updateWatchHistoryItem() takes ONE object arg, not (mediaId, obj)
 * - getPlaybackStatus() fields may be PascalCase — try both
 * - getPlaybackState() fields may be PascalCase — try both
 * - episode from state, not URL (URL episode param is unreliable)
 */
function init() {
    $ui.register((ctx) => {

        // ─── Runtime state ────────────────────────────────────────────────
        let lastSaveMs: number = 0
        const SAVE_INTERVAL_MS = 10000

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
            const m = Math.floor(s / 60)
            const ss = Math.floor(s % 60)
            return m + ":" + (ss < 10 ? "0" : "") + ss
        }

        /** Try both camelCase and PascalCase for a field */
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
            const pi = pick(state, "playbackInfo", "PlaybackInfo")
            const media = pick(pi, "media", "Media")
            const id = pick(media, "id", "Id", "ID")
            if (id !== undefined && id !== null) {
                const n = parseInt(String(id), 10)
                if (n > 0) return n
            }
            return null
        }

        function extractEpisode(state: any): number {
            if (!state) return 0
            const pi = pick(state, "playbackInfo", "PlaybackInfo")
            const ep = pick(pi, "episode", "Episode")
            if (!ep) return 0
            const v = pick(ep,
                "progressNumber", "ProgressNumber",
                "episodeNumber",  "EpisodeNumber",
                "number",         "Number",
            )
            return v ? parseInt(String(v), 10) : 0
        }

        // ─── FIXED: single-object form ────────────────────────────────────
        function save(mediaId: number, episodeNumber: number, currentTime: number, duration: number, reason: string) {
            if (!mediaId || duration <= 0 || currentTime <= 0) {
                debugLine.set("skip: mid=" + mediaId + " ct=" + Math.floor(currentTime) + " dur=" + Math.floor(duration))
                tray.update()
                return
            }
            try {
                ctx.continuity.updateWatchHistoryItem({
                    kind: "mediastream",
                    filepath: "",
                    mediaId: mediaId,
                    episodeNumber: episodeNumber,
                    currentTime: currentTime,
                    duration: duration,
                })
                savedLine.set(fmtTime(currentTime) + " / " + fmtTime(duration) + " (" + reason + ")")
                lastSaveMs = Date.now()
                tray.update()
            } catch (e) {
                debugLine.set("save err: " + e)
                tray.update()
            }
        }

        // ─── Primary: poll every 3s ───────────────────────────────────────
        ctx.setInterval(() => {
            try {
                const rawState  = ctx.videoCore.getPlaybackState()
                const rawStatus = ctx.videoCore.getPlaybackStatus()

                // Dump state keys for one-time debugging
                let stateKeys = ""
                if (rawState) {
                    try { stateKeys = JSON.stringify(Object.keys(rawState)) } catch (e) {}
                }

                if (!rawState) {
                    statusLine.set("Idle (no state)")
                    debugLine.set("state=null status=" + (rawStatus ? JSON.stringify(rawStatus) : "null"))
                    tray.update()
                    return
                }

                const mediaId      = extractMediaId(rawState)
                const episodeNum   = extractEpisode(rawState)

                // getPlaybackStatus() fields may be PascalCase or camelCase
                const currentTime  = parseFloat(String(pick(rawStatus, "currentTime", "CurrentTime") || 0))
                const duration     = parseFloat(String(pick(rawStatus, "duration",    "Duration")    || 0))
                const paused       = !!(pick(rawStatus, "paused", "Paused"))

                statusLine.set(
                    mediaId
                        ? (paused ? "Paused " : "Watching ") + "ep" + episodeNum + " (id " + mediaId + ")"
                        : "No mediaId — stateKeys=" + stateKeys
                )
                debugLine.set("ct=" + Math.floor(currentTime) + " dur=" + Math.floor(duration) + " paused=" + paused)
                tray.update()

                if (!mediaId || paused || currentTime <= 0 || duration <= 0) return

                const now = Date.now()
                if (now - lastSaveMs >= SAVE_INTERVAL_MS) {
                    save(mediaId, episodeNum, currentTime, duration, "auto")
                }
            } catch (e) {
                statusLine.set("poll error: " + e)
                tray.update()
            }
        }, 3000)

        // ─── Supplement: event listeners ──────────────────────────────────
        // These fire if the WebSocket connection is stable; provide faster saves

        ctx.videoCore.addEventListener("video-loaded", (e: any) => {
            const state = e.state || e.State
            const mediaId    = extractMediaId(state)
            const episodeNum = extractEpisode(state)
            if (mediaId) {
                statusLine.set("Loaded ep" + episodeNum + " (id " + mediaId + ")")
                tray.update()
            }
        })

        ctx.videoCore.addEventListener("video-status", (e: any) => {
            const ct  = parseFloat(String(pick(e, "currentTime", "CurrentTime") || 0))
            const dur = parseFloat(String(pick(e, "duration",    "Duration")    || 0))
            const psd = !!(pick(e, "paused", "Paused"))

            if (psd || ct <= 0 || dur <= 0) return

            // Update display on every status tick (1/s)
            const rawState = ctx.videoCore.getPlaybackState()
            const mediaId  = rawState ? extractMediaId(rawState) : null
            const epNum    = rawState ? extractEpisode(rawState) : 0

            if (!mediaId) return

            statusLine.set("Watching ep" + epNum + " @ " + fmtTime(ct))
            debugLine.set("ct=" + Math.floor(ct) + " dur=" + Math.floor(dur))
            tray.update()

            const now = Date.now()
            if (now - lastSaveMs >= SAVE_INTERVAL_MS) {
                save(mediaId, epNum, ct, dur, "auto")
            }
        })

        ctx.videoCore.addEventListener("video-paused", (e: any) => {
            const ct  = parseFloat(String(pick(e, "currentTime", "CurrentTime") || 0))
            const dur = parseFloat(String(pick(e, "duration",    "Duration")    || 0))
            const rawState = ctx.videoCore.getPlaybackState()
            const mediaId  = rawState ? extractMediaId(rawState) : null
            const epNum    = rawState ? extractEpisode(rawState) : 0
            if (mediaId) {
                statusLine.set("Paused ep" + epNum)
                tray.update()
                save(mediaId, epNum, ct, dur, "paused")
            }
        })

        ctx.videoCore.addEventListener("video-terminated", (_e: any) => {
            // Final save handled by polling; just update status
            statusLine.set("Idle")
            tray.update()
        })

        ctx.videoCore.addEventListener("video-ended", (_e: any) => {
            statusLine.set("Idle")
            tray.update()
        })

        tray.update()
    })
}
