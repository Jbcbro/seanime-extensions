/// <reference path="./plugin.d.ts" />

/**
 * Continuity Sync
 *
 * The browser sends video-status every 1 second. We listen to that stream,
 * count ticks, and save continuity every 10 seconds while playing.
 * Also saves immediately on pause/end/close.
 */
function init() {
    $ui.register((ctx) => {

        // ─── State ────────────────────────────────────────────────────────
        let mediaId: number | null = null
        let episodeNumber: number = 0
        let currentTime: number = 0
        let duration: number = 0
        let ticksSinceLastSave: number = 0
        const SAVE_EVERY_N_TICKS = 10 // video-status fires every 1s → save every 10s

        // ─── Tray ─────────────────────────────────────────────────────────
        const statusState = ctx.state("Idle")
        const lastSavedState = ctx.state("—")

        const tray = ctx.newTray({
            tooltipText: "Continuity Sync",
            withContent: true,
        })

        tray.render(() => tray.stack([
            tray.text("Continuity Sync", { style: { fontWeight: "bold", fontSize: "1rem" } }),
            tray.text("Status: " + statusState.get(), { style: { fontSize: "0.8rem", color: "#aaa" } }),
            tray.text("Last saved: " + lastSavedState.get(), { style: { fontSize: "0.8rem", color: "#aaa" } }),
        ], { gap: 4, style: { width: "220px", padding: "10px" } }))

        // ─── Helpers ──────────────────────────────────────────────────────
        function extractMediaId(state: any): number | null {
            if (!state) return null
            // Flat (as per d.ts types)
            if (typeof state.mediaId === "number" && state.mediaId > 0) return state.mediaId
            // Nested Go struct: playbackInfo.media.id
            const id = state && state.playbackInfo && state.playbackInfo.media && state.playbackInfo.media.id
            if (typeof id === "number" && id > 0) return id
            return null
        }

        function extractEpisodeNumber(state: any): number {
            if (!state) return 0
            if (typeof state.episodeNumber === "number" && state.episodeNumber > 0) return state.episodeNumber
            const ep = state && state.playbackInfo && state.playbackInfo.episode
            if (!ep) return 0
            return ep.progressNumber || ep.episodeNumber || 0
        }

        function fmtTime(secs: number): string {
            const m = Math.floor(secs / 60)
            const s = Math.floor(secs % 60)
            return m + ":" + (s < 10 ? "0" : "") + s
        }

        function save(ct: number, dur: number, reason: string) {
            if (!mediaId || dur <= 0 || ct <= 0) return
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
                tray.update()
            } catch (e) { }
        }

        // ─── Bootstrap: pick up already-active playback ───────────────────
        try {
            const state = ctx.videoCore.getPlaybackState()
            if (state) {
                const id = extractMediaId(state)
                if (id) {
                    mediaId = id
                    episodeNumber = extractEpisodeNumber(state)
                    statusState.set("Watching ep " + episodeNumber)
                    tray.update()
                }
            }
        } catch (e) { }

        // ─── video-loaded / video-playback-state: capture mediaId ─────────
        ctx.videoCore.addEventListener("video-loaded", (e) => {
            const id = extractMediaId(e.state)
            if (id) {
                mediaId = id
                episodeNumber = extractEpisodeNumber(e.state)
            }
            ticksSinceLastSave = 0
            statusState.set("Watching ep " + episodeNumber)
            tray.update()
        })

        ctx.videoCore.addEventListener("video-playback-state", (e) => {
            const id = extractMediaId(e.state)
            if (id) {
                mediaId = id
                episodeNumber = extractEpisodeNumber(e.state)
            }
            statusState.set("Watching ep " + episodeNumber)
            tray.update()
        })

        // ─── video-status: fires every 1s — count ticks, save every 10 ───
        ctx.videoCore.addEventListener("video-status", (e) => {
            currentTime = e.currentTime
            duration = e.duration

            if (e.paused || !mediaId || currentTime <= 0 || duration <= 0) return

            ticksSinceLastSave++
            if (ticksSinceLastSave >= SAVE_EVERY_N_TICKS) {
                ticksSinceLastSave = 0
                save(currentTime, duration, "auto")
            }

            // Update tray display every 5s
            if (ticksSinceLastSave % 5 === 0) {
                statusState.set("Ep " + episodeNumber + " @ " + fmtTime(currentTime))
                tray.update()
            }
        })

        // ─── Save immediately on pause/end/close ──────────────────────────
        ctx.videoCore.addEventListener("video-paused", (e) => {
            currentTime = e.currentTime
            duration = e.duration
            ticksSinceLastSave = 0
            statusState.set("Paused ep " + episodeNumber)
            tray.update()
            save(e.currentTime, e.duration, "paused")
        })

        ctx.videoCore.addEventListener("video-resumed", (_e) => {
            ticksSinceLastSave = 0
            statusState.set("Watching ep " + episodeNumber)
            tray.update()
        })

        ctx.videoCore.addEventListener("video-terminated", (_e) => {
            save(currentTime, duration, "closed")
            statusState.set("Idle")
            mediaId = null
            ticksSinceLastSave = 0
            tray.update()
        })

        ctx.videoCore.addEventListener("video-ended", (_e) => {
            save(currentTime, duration, "ended")
            statusState.set("Idle")
            mediaId = null
            ticksSinceLastSave = 0
            tray.update()
        })

        tray.update()
    })
}
