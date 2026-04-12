/// <reference path="./plugin.d.ts" />

/**
 * Continuity Sync
 *
 * - mediaId from URL (onlinestream?id=XXXX) — reliable
 * - episodeNumber from video event state (URL ep param is unreliable)
 * - saves every 10s using Date.now() timestamp, not tick counting
 *   (tick counting breaks when buffering causes repeated pause/resume)
 * - saves immediately on pause/end/close
 */
function init() {
    $ui.register((ctx) => {

        // ─── State ────────────────────────────────────────────────────────
        let mediaId: number | null = null
        let episodeNumber: number = 0
        let currentTime: number = 0
        let duration: number = 0
        let lastSaveMs: number = 0
        const SAVE_INTERVAL_MS = 10000

        // ─── Tray ─────────────────────────────────────────────────────────
        const statusState = ctx.state("Idle")
        const lastSavedState = ctx.state("—")
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
        ], { gap: 4, style: { width: "240px", padding: "10px" } }))

        function dbg(msg: string) {
            if (debugRef.current === "true") ctx.toast.info("[CS] " + msg)
        }

        function fmtTime(secs: number): string {
            const m = Math.floor(secs / 60)
            const s = Math.floor(secs % 60)
            return m + ":" + (s < 10 ? "0" : "") + s
        }

        function save(ct: number, dur: number, reason: string) {
            if (!mediaId || dur <= 0 || ct <= 0) {
                dbg("skip save: mid=" + mediaId + " ct=" + ct + " dur=" + dur)
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
                dbg("saved ep" + episodeNumber + " @ " + fmtTime(ct) + " [" + reason + "]")
                tray.update()
            } catch (e) {
                dbg("save error: " + e)
            }
        }

        // ─── Extract episode from event state (more reliable than URL) ────
        function extractEpFromState(state: any): number {
            if (!state) return 0
            const candidates = [
                state.episodeNumber,
                state.episode && state.episode.number,
                state.episode && state.episode.episodeNumber,
                state.playbackInfo && state.playbackInfo.episode && state.playbackInfo.episode.progressNumber,
                state.playbackInfo && state.playbackInfo.episode && state.playbackInfo.episode.episodeNumber,
                state.playbackInfo && state.playbackInfo.episode && state.playbackInfo.episode.number,
            ]
            for (let i = 0; i < candidates.length; i++) {
                const v = candidates[i]
                if (v !== undefined && v !== null && parseInt(String(v), 10) > 0) {
                    const n = parseInt(String(v), 10)
                    dbg("ep from state candidate[" + i + "]=" + n)
                    return n
                }
            }
            return 0
        }

        function extractIdFromState(state: any): number | null {
            if (!state) return null
            const candidates = [
                state.mediaId,
                state.media && state.media.id,
                state.playbackInfo && state.playbackInfo.media && state.playbackInfo.media.id,
                state.anime && state.anime.id,
            ]
            for (let i = 0; i < candidates.length; i++) {
                const v = candidates[i]
                if (v !== undefined && v !== null && parseInt(String(v), 10) > 0) {
                    return parseInt(String(v), 10)
                }
            }
            return null
        }

        // ─── Primary: get mediaId from URL ────────────────────────────────
        ctx.screen.onNavigate((e) => {
            const path = (e.pathname || "").toLowerCase()
            const params = e.searchParams || {}
            dbg("navigate: " + path + " params=" + JSON.stringify(params))

            if (path.indexOf("onlinestream") !== -1 || path.indexOf("watch") !== -1) {
                const rawId = params.id || params.mediaId || params.mediaid || ""
                if (rawId) {
                    const newId = parseInt(String(rawId), 10)
                    if (newId !== mediaId) {
                        mediaId = newId
                        episodeNumber = 0 // will be overridden by video-loaded state
                        lastSaveMs = 0
                        dbg("URL mediaId=" + mediaId)
                    }
                    // Note: we intentionally do NOT set episodeNumber from URL —
                    // the URL episode param is often an HLS source index, not AniList progress.
                } else {
                    dbg("onlinestream but no id param: " + JSON.stringify(params))
                }
            } else if (mediaId !== null) {
                save(currentTime, duration, "navigate-away")
                mediaId = null
                episodeNumber = 0
                currentTime = 0
                duration = 0
                statusState.set("Idle")
                tray.update()
            }
        })

        ctx.screen.loadCurrent()

        // ─── video-loaded: set episode from state ─────────────────────────
        ctx.videoCore.addEventListener("video-loaded", (e) => {
            dbg("video-loaded state=" + JSON.stringify(e.state))
            // Always extract episode from state — overrides any previous value
            const stateEp = extractEpFromState(e.state)
            if (stateEp > 0) episodeNumber = stateEp

            // Also try to get mediaId from state as fallback if URL didn't provide it
            if (!mediaId) {
                const stateId = extractIdFromState(e.state)
                if (stateId) { mediaId = stateId; dbg("state fallback mediaId=" + mediaId) }
            }

            lastSaveMs = 0
            statusState.set("Watching ep " + episodeNumber + " (id " + mediaId + ")")
            tray.update()
        })

        ctx.videoCore.addEventListener("video-playback-state", (e) => {
            dbg("video-playback-state state=" + JSON.stringify(e.state))
            const stateEp = extractEpFromState(e.state)
            if (stateEp > 0) episodeNumber = stateEp
            if (!mediaId) {
                const stateId = extractIdFromState(e.state)
                if (stateId) mediaId = stateId
            }
            tray.update()
        })

        // ─── video-status: fires every 1s; save via timestamp not ticks ───
        ctx.videoCore.addEventListener("video-status", (e) => {
            currentTime = e.currentTime || 0
            duration = e.duration || 0

            if (e.paused || !mediaId || currentTime <= 0 || duration <= 0) return

            const now = Date.now()
            if (now - lastSaveMs >= SAVE_INTERVAL_MS) {
                lastSaveMs = now
                save(currentTime, duration, "auto")
                statusState.set("Ep " + episodeNumber + " @ " + fmtTime(currentTime))
                tray.update()
            }
        })

        // ─── Save on pause / end / close ──────────────────────────────────
        ctx.videoCore.addEventListener("video-paused", (e) => {
            currentTime = e.currentTime || currentTime
            duration = e.duration || duration
            statusState.set("Paused ep " + episodeNumber)
            tray.update()
            save(currentTime, duration, "paused")
        })

        ctx.videoCore.addEventListener("video-resumed", (_e) => {
            statusState.set("Watching ep " + episodeNumber)
            tray.update()
            // Do NOT reset lastSaveMs — let the 10s clock continue uninterrupted
        })

        ctx.videoCore.addEventListener("video-terminated", (_e) => {
            save(currentTime, duration, "closed")
            statusState.set("Idle")
            mediaId = null
            tray.update()
        })

        ctx.videoCore.addEventListener("video-ended", (_e) => {
            save(currentTime, duration, "ended")
            statusState.set("Idle")
            mediaId = null
            tray.update()
        })

        tray.update()
    })
}
