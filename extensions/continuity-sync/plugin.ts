/// <reference path="./plugin.d.ts" />

/**
 * Continuity Sync
 *
 * Gets mediaId from the page URL (onlinestream?id=XXXX) — more reliable than
 * parsing the Go PlaybackState struct whose shape varies.
 * Counts video-status ticks (1/sec) and saves every 10s while playing.
 * Debug mode shows raw event values in toasts.
 */
function init() {
    $ui.register((ctx) => {

        // ─── State ────────────────────────────────────────────────────────
        let mediaId: number | null = null
        let episodeNumber: number = 0
        let currentTime: number = 0
        let duration: number = 0
        let ticksSinceLastSave: number = 0
        const SAVE_EVERY_N_TICKS = 10

        // ─── Tray ─────────────────────────────────────────────────────────
        const statusState = ctx.state("Idle")
        const lastSavedState = ctx.state("—")
        const debugState = ctx.state("mid:" + mediaId + " ct:" + currentTime + " dur:" + duration)
        const debugRef = ctx.fieldRef("false")

        const tray = ctx.newTray({
            tooltipText: "Continuity Sync",
            withContent: true,
        })

        tray.render(() => tray.stack([
            tray.text("Continuity Sync", { style: { fontWeight: "bold", fontSize: "1rem" } }),
            tray.select("Debug", {
                options: [{ label: "Off", value: "false" }, { label: "On", value: "true" }],
                fieldRef: debugRef,
            }),
            tray.text("Status: " + statusState.get(), { style: { fontSize: "0.8rem", color: "#aaa" } }),
            tray.text("Last saved: " + lastSavedState.get(), { style: { fontSize: "0.8rem", color: "#aaa" } }),
            tray.text(debugState.get(), { style: { fontSize: "0.75rem", color: "#666" } }),
        ], { gap: 4, style: { width: "240px", padding: "10px" } }))

        function dbg(msg: string) {
            if (debugRef.current === "true") ctx.toast.info("[CS] " + msg)
        }

        // ─── Helpers ──────────────────────────────────────────────────────
        function fmtTime(secs: number): string {
            const m = Math.floor(secs / 60)
            const s = Math.floor(secs % 60)
            return m + ":" + (s < 10 ? "0" : "") + s
        }

        function updateDebug() {
            debugState.set("mid:" + mediaId + " ep:" + episodeNumber + " ct:" + Math.floor(currentTime) + " dur:" + Math.floor(duration))
            tray.update()
        }

        function save(ct: number, dur: number, reason: string) {
            if (!mediaId || dur <= 0 || ct <= 0) {
                dbg("save() skipped: mid=" + mediaId + " ct=" + ct + " dur=" + dur)
                return
            }
            try {
                ctx.continuity.updateWatchHistoryItem(mediaId, {
                    kind: "mediastream",
                    filepath: "",
                    mediaId: mediaId,
                    episodeNumber: episodeNumber,
                    currentTime: ct,
                    duration: dur,
                })
                lastSavedState.set(fmtTime(ct) + " / " + fmtTime(dur) + " (" + reason + ")")
                dbg("saved @ " + fmtTime(ct) + " reason=" + reason)
                tray.update()
            } catch (e) {
                dbg("save() error: " + e)
            }
        }

        // ─── Primary: get mediaId from URL ────────────────────────────────
        // Seanime's online stream URL: /onlinestream?id=12345&episode=1
        ctx.screen.onNavigate((e) => {
            const path = (e.pathname || "").toLowerCase()
            const params = e.searchParams || {}
            dbg("navigate path=" + path + " params=" + JSON.stringify(params))

            if (path.indexOf("onlinestream") !== -1 || path.indexOf("watch") !== -1) {
                const rawId = params.id || params.mediaId || params.mediaid || ""
                const rawEp = params.episode || params.ep || params.episodenumber || ""
                if (rawId) {
                    mediaId = parseInt(String(rawId), 10)
                    if (rawEp) episodeNumber = parseInt(String(rawEp), 10)
                    statusState.set("Ready ep " + episodeNumber + " (id " + mediaId + ")")
                    dbg("URL mediaId=" + mediaId + " ep=" + episodeNumber)
                } else {
                    dbg("onlinestream page but no id param: " + JSON.stringify(params))
                }
            } else if (mediaId !== null && path.indexOf("onlinestream") === -1) {
                // Left the player
                save(currentTime, duration, "navigate-away")
                mediaId = null
                episodeNumber = 0
                currentTime = 0
                duration = 0
                statusState.set("Idle")
            }
            updateDebug()
        })

        ctx.screen.loadCurrent()

        // ─── Fallback: extract mediaId from event state ───────────────────
        function tryExtractFromState(state: any): boolean {
            if (!state) return false
            // Try every plausible path
            const candidates = [
                state.mediaId,
                state.media && state.media.id,
                state.playbackInfo && state.playbackInfo.media && state.playbackInfo.media.id,
                state.anime && state.anime.id,
            ]
            for (let i = 0; i < candidates.length; i++) {
                const v = candidates[i]
                if (v && (typeof v === "number" || typeof v === "string") && parseInt(String(v), 10) > 0) {
                    const parsed = parseInt(String(v), 10)
                    if (!mediaId) {
                        mediaId = parsed
                        dbg("state fallback mediaId=" + mediaId + " via candidate[" + i + "]")
                    }
                    break
                }
            }
            if (!episodeNumber) {
                const epCandidates = [
                    state.episodeNumber,
                    state.episode && state.episode.number,
                    state.playbackInfo && state.playbackInfo.episode && state.playbackInfo.episode.progressNumber,
                    state.playbackInfo && state.playbackInfo.episode && state.playbackInfo.episode.episodeNumber,
                ]
                for (let i = 0; i < epCandidates.length; i++) {
                    const v = epCandidates[i]
                    if (v && parseInt(String(v), 10) > 0) {
                        episodeNumber = parseInt(String(v), 10)
                        break
                    }
                }
            }
            return !!mediaId
        }

        // ─── Video events ─────────────────────────────────────────────────
        ctx.videoCore.addEventListener("video-loaded", (e) => {
            dbg("video-loaded state=" + JSON.stringify(e.state))
            tryExtractFromState(e.state)
            ticksSinceLastSave = 0
            statusState.set("Watching ep " + episodeNumber + " (id " + mediaId + ")")
            updateDebug()
        })

        ctx.videoCore.addEventListener("video-playback-state", (e) => {
            dbg("video-playback-state state=" + JSON.stringify(e.state))
            tryExtractFromState(e.state)
            updateDebug()
        })

        // ─── video-status: fires every 1s ─────────────────────────────────
        ctx.videoCore.addEventListener("video-status", (e) => {
            currentTime = e.currentTime || 0
            duration = e.duration || 0

            if (!mediaId) {
                dbg("video-status: no mediaId yet, ct=" + currentTime + " dur=" + duration)
                return
            }
            if (e.paused || currentTime <= 0 || duration <= 0) return

            ticksSinceLastSave++

            if (ticksSinceLastSave >= SAVE_EVERY_N_TICKS) {
                ticksSinceLastSave = 0
                save(currentTime, duration, "auto")
            }

            if (ticksSinceLastSave % 5 === 0) {
                statusState.set("Ep " + episodeNumber + " @ " + fmtTime(currentTime))
                updateDebug()
            }
        })

        // ─── Save on pause / end / close ──────────────────────────────────
        ctx.videoCore.addEventListener("video-paused", (e) => {
            currentTime = e.currentTime || currentTime
            duration = e.duration || duration
            ticksSinceLastSave = 0
            statusState.set("Paused ep " + episodeNumber)
            updateDebug()
            save(currentTime, duration, "paused")
        })

        ctx.videoCore.addEventListener("video-resumed", (_e) => {
            ticksSinceLastSave = 0
            statusState.set("Watching ep " + episodeNumber)
            tray.update()
        })

        ctx.videoCore.addEventListener("video-terminated", (_e) => {
            save(currentTime, duration, "closed")
            statusState.set("Idle")
            mediaId = null; ticksSinceLastSave = 0
            updateDebug()
        })

        ctx.videoCore.addEventListener("video-ended", (_e) => {
            save(currentTime, duration, "ended")
            statusState.set("Idle")
            mediaId = null; ticksSinceLastSave = 0
            updateDebug()
        })

        updateDebug()
        tray.update()
    })
}
