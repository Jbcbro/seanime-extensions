/// <reference path="./plugin.d.ts" />

/**
 * Continuity Sync
 *
 * Polls getPlaybackStatus() every 10s to save position, fixing the missing
 * continuity writes in Seanime's mediastream player.
 * Also saves immediately on pause.
 */
function init() {
    $ui.register((ctx) => {

        // ─── State ────────────────────────────────────────────────────────
        let mediaId: number | null = null
        let episodeNumber: number = 0

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

        // The actual Go PlaybackState has playbackInfo.media.id (not state.mediaId).
        // Try both structures defensively.
        function extractMediaId(state: any): number | null {
            if (!state) return null
            if (typeof state.mediaId === "number" && state.mediaId > 0) return state.mediaId
            const id = state?.playbackInfo?.media?.id
            if (typeof id === "number" && id > 0) return id
            return null
        }

        function extractEpisodeNumber(state: any): number {
            if (!state) return 0
            if (typeof state.episodeNumber === "number") return state.episodeNumber
            const ep = state?.playbackInfo?.episode
            return ep?.progressNumber || ep?.episodeNumber || 0
        }

        function fmtTime(secs: number): string {
            const m = Math.floor(secs / 60)
            const s = Math.floor(secs % 60)
            return m + ":" + (s < 10 ? "0" : "") + s
        }

        function save(currentTime: number, duration: number, reason: string) {
            if (!mediaId || duration <= 0 || currentTime <= 0) return
            try {
                ctx.continuity.updateWatchHistoryItem(mediaId, {
                    kind: "mediastream",
                    filepath: "",
                    mediaId: mediaId,
                    episodeNumber: episodeNumber,
                    currentTime: currentTime,
                    duration: duration,
                })
                lastSavedState.set(fmtTime(currentTime) + " (" + reason + ")")
                tray.update()
            } catch (e) { }
        }

        // ─── Refresh mediaId from current state ───────────────────────────
        function refreshMediaId() {
            try {
                const state = ctx.videoCore.getPlaybackState()
                if (!state) return
                const id = extractMediaId(state)
                if (id) {
                    mediaId = id
                    episodeNumber = extractEpisodeNumber(state)
                }
            } catch (e) { }
        }

        // Bootstrap: pick up already-playing video
        refreshMediaId()
        if (mediaId) {
            statusState.set("Watching ep " + episodeNumber)
            tray.update()
        }

        // ─── Events (display + immediate save on pause) ───────────────────
        ctx.videoCore.addEventListener("video-loaded", (e) => {
            const id = extractMediaId(e.state)
            if (id) {
                mediaId = id
                episodeNumber = extractEpisodeNumber(e.state)
            }
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

        ctx.videoCore.addEventListener("video-paused", (e) => {
            statusState.set("Paused ep " + episodeNumber)
            tray.update()
            save(e.currentTime, e.duration, "paused")
        })

        ctx.videoCore.addEventListener("video-resumed", (_e) => {
            statusState.set("Watching ep " + episodeNumber)
            tray.update()
        })

        ctx.videoCore.addEventListener("video-terminated", (_e) => {
            statusState.set("Idle")
            mediaId = null
            tray.update()
        })

        // ─── Main loop: poll every 10s and save if playing ────────────────
        ctx.setInterval(() => {
            try {
                const status = ctx.videoCore.getPlaybackStatus()

                if (!status || status.paused || !status.currentTime || !status.duration) {
                    // No active playback
                    if (!mediaId) {
                        statusState.set("Idle")
                        tray.update()
                    }
                    return
                }

                // If we don't have a mediaId yet, try to fetch it
                if (!mediaId) refreshMediaId()

                statusState.set("Watching ep " + episodeNumber)
                tray.update()

                save(status.currentTime, status.duration, "auto")
            } catch (e) { }
        }, 10000)

        tray.update()
    })
}
