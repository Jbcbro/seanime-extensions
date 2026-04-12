/// <reference path="./plugin.d.ts" />

/**
 * Auto Pause
 *
 * Automatically pauses the video when it first becomes ready to play,
 * instead of auto-playing. The user must manually press play.
 */
function init() {
    $ui.register((ctx) => {
        // Allow up to two automatic pauses right after a load starts:
        // one for the initial autoplay, and one more if switching to dub
        // re-triggers playback a moment later.
        let pauseAttemptsForCurrentLoad = 0
        let loadStartedAt = 0

        function resetPauseWindow() {
            pauseAttemptsForCurrentLoad = 0
            loadStartedAt = Date.now()
        }

        ctx.videoCore.addEventListener("video-loaded", () => {
            resetPauseWindow()
        })

        ctx.videoCore.addEventListener("video-can-play", () => {
            if (loadStartedAt === 0) resetPauseWindow()
            if (Date.now() - loadStartedAt > 15000) return
            if (pauseAttemptsForCurrentLoad >= 2) return

            try {
                const status = ctx.videoCore.getPlaybackStatus()
                if (status && status.paused) return
            } catch { }

            pauseAttemptsForCurrentLoad += 1
            ctx.videoCore.pause()
        })
    })
}
