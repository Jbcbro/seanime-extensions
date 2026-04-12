/// <reference path="./plugin.d.ts" />

/**
 * Continuity Sync
 *
 * Saves your playback position every 10 seconds while watching and immediately
 * on pause/end, fixing the missing continuity writes in Seanime's mediastream player.
 */
function init() {
    $ui.register((ctx) => {

        // ─── Playback state ───────────────────────────────────────────────
        let mediaId: number | null = null
        let episodeNumber: number = 0
        let currentTime: number = 0
        let duration: number = 0
        let isPlaying: boolean = false

        // ─── Tray ─────────────────────────────────────────────────────────
        const statusState = ctx.state("Idle")
        const lastSavedState = ctx.state("—")

        const tray = ctx.newTray({
            tooltipText: "Continuity Sync",
            iconUrl: "https://raw.githubusercontent.com/Jbcbro/seanime-extensions/main/extensions/continuity-sync/icon.png",
            withContent: true,
        })

        tray.render(() => tray.stack([
            tray.text("Continuity Sync", { style: { fontWeight: "bold", fontSize: "1rem" } }),
            tray.text("Status: " + statusState.get(), { style: { fontSize: "0.8rem", color: "#aaa" } }),
            tray.text("Last saved: " + lastSavedState.get(), { style: { fontSize: "0.8rem", color: "#aaa" } }),
        ], { gap: 4, style: { width: "220px", padding: "10px" } }))

        // ─── Save helper ──────────────────────────────────────────────────
        function save(reason: string) {
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
                const mins = Math.floor(currentTime / 60)
                const secs = Math.floor(currentTime % 60)
                const timeStr = mins + ":" + (secs < 10 ? "0" : "") + secs
                lastSavedState.set(timeStr + " (" + reason + ")")
                tray.update()
            } catch (e) { }
        }

        // ─── Event listeners ──────────────────────────────────────────────

        // Fired when a new episode loads — captures mediaId + episodeNumber
        ctx.videoCore.addEventListener("video-playback-state", (e) => {
            mediaId = e.state.mediaId
            episodeNumber = e.state.episodeNumber
            statusState.set("Watching ep " + episodeNumber)
            tray.update()
        })

        // Fired when video metadata loads (also carries mediaId)
        ctx.videoCore.addEventListener("video-loaded", (e) => {
            mediaId = e.state.mediaId
            episodeNumber = e.state.episodeNumber
            currentTime = 0
            isPlaying = false
            lastSavedState.set("—")
            statusState.set("Loaded ep " + episodeNumber)
            tray.update()
        })

        // Fired periodically during playback — keeps currentTime/duration fresh
        ctx.videoCore.addEventListener("video-status", (e) => {
            currentTime = e.currentTime
            duration = e.duration
            isPlaying = !e.paused
        })

        // Save immediately when paused
        ctx.videoCore.addEventListener("video-paused", (e) => {
            currentTime = e.currentTime
            duration = e.duration
            isPlaying = false
            save("paused")
        })

        // Save on resume
        ctx.videoCore.addEventListener("video-resumed", (e) => {
            currentTime = e.currentTime
            duration = e.duration
            isPlaying = true
        })

        // Save final position when episode ends or player closes
        ctx.videoCore.addEventListener("video-ended", (_e) => {
            isPlaying = false
            save("ended")
            statusState.set("Idle")
            tray.update()
        })

        ctx.videoCore.addEventListener("video-terminated", (_e) => {
            isPlaying = false
            save("closed")
            statusState.set("Idle")
            mediaId = null
            tray.update()
        })

        // ─── Periodic save every 10 seconds while playing ─────────────────
        ctx.setInterval(() => {
            if (isPlaying) save("auto")
        }, 10000)

        statusState.set("Idle")
        tray.update()
    })
}
