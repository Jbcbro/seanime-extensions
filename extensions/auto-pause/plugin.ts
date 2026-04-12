/// <reference path="./plugin.d.ts" />

/**
 * Auto Pause
 *
 * Automatically pauses the video when it first becomes ready to play,
 * instead of auto-playing. The user must manually press play.
 */
function init() {
    $ui.register((ctx) => {
        // Track whether we've paused for the current video load.
        // Reset on each new video so we only pause once per load, not on resume.
        let pausedForCurrentLoad = false

        ctx.videoCore.addEventListener("video-loaded", () => {
            pausedForCurrentLoad = false
        })

        ctx.videoCore.addEventListener("video-can-play", () => {
            if (!pausedForCurrentLoad) {
                pausedForCurrentLoad = true
                ctx.videoCore.pause()
            }
        })
    })
}
