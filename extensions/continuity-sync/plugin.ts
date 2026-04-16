/// <reference path="./plugin.d.ts" />

/**
 * Continuity Sync v1.3.6
 *
 * Root cause 1: on mobile Safari, getPlaybackStatus() returns stale data
 * (paused=true, currentTime=3) from the moment the video was loaded —
 * video-status WebSocket events never arrive from the browser to update it.
 *
 * Root cause 2: after an onlinestream server/quality switch, video.duration
 * becomes NaN during HLS re-initialization, breaking the built-in continuity
 * writes permanently until Seanime restarts. The wall-clock approach here is
 * immune to that — it never reads video.duration for time tracking.
 *
 * Root cause 3: if the user clicks dub/sub/provider/server before the
 * continuity seek runs, savePreviousStateThen() saves currentTime=0 because
 * HLS already reset the position. This sets initialState={currentTime:0} on
 * the new stream, which blocks both the position restore and the continuity
 * restore in handleCanPlay, so playback starts from the beginning.
 *
 * Root cause 3 fix: on every video-loaded, snapshot the wall-clock estimate
 * into lastGoodPosition before resetting the clock. The 3s poll then uses
 * that snapshot as the primary restore source (more current than the
 * continuity API). Falls back to the continuity API if no snapshot exists.
 *
 * Root cause 4: when a server returns 403, video-terminated fires while the
 * wall-clock estimate is meaningless (counting up from 0 since the failed
 * stream loaded). If the error took >5s, it overwrites lastGoodPosition with
 * wrong data and corrupts the continuity API save. The same happens when no
 * video-terminated fires and video-loaded for the working server sees
 * currentEstimate() measured from the failed stream's resetClock(0).
 *
 * Root cause 4 fix: track streamLoadedSuccessfully via video-can-play. Only
 * update lastGoodPosition and write to the continuity API in video-terminated
 * if the stream actually loaded. video-loaded also gates its snapshot on this
 * flag (which reflects the PREVIOUS stream's state at that point).
 *
 * Root cause 5: when rawState is transiently null during error display (between
 * video-terminated and the next video-loaded), the null-state poll path was
 * clearing pendingRestoreCheck. When state returned, the first poll tick saw
 * mediaId !== trackedMediaId (trackedMediaId was null'd) → "New video detected"
 * → returned early without checking pendingRestoreCheck. By the time trackedMediaId
 * matched, pendingRestoreCheck was false and the restore never ran.
 *
 * Root cause 5 fix: do not clear pendingRestoreCheck in the null-state path.
 * It survives the null period so the next stable poll tick processes it.
 * The "New video detected" early return just delays the check by one tick.
 *
 * Root cause 6: when HLS fires a fatal 403 error, Seanime's onFatalError
 * handler triggers an instantaneous auto-switch to the next server (not a
 * manual user action). The entire terminated→loaded→can-play cycle completes
 * in well under 3 seconds, so the poll-based restore never fires in time.
 * The console log confirmed the built-in continuity API returns
 * {item: null, found: false} on the replacement stream because our async
 * save hasn't persisted yet — so the built-in's restoreSeekTime() also
 * skips the restore and playback starts at 0.
 *
 * Root cause 6 fix: move the primary restore attempt into video-can-play
 * (which fires immediately when the video can buffer), before the 3s poll
 * ever runs. If pendingRestoreCheck is set, no built-in seek has arrived,
 * lastGoodPosition is valid, AND the continuity API has no valid saved
 * position for this episode — seek immediately. The poll is kept as a
 * safety net for slower edge cases where video-can-play beats the API.
 *
 * v1.1.0: detect playbackType so onlinestream saves use kind="onlinestream".
 * v1.2.0: restore fallback — no video-seeked after load = built-in skipped.
 * v1.3.0: lastGoodPosition snapshot fixes rapid provider/server switches.
 * v1.3.1: fix video-terminated clearing lastGoodPosition before video-loaded
 *         can read it — save the estimate instead of zeroing it out.
 * v1.3.3: fix 403 errors corrupting lastGoodPosition and continuity API —
 *         gate terminated save/snapshot on video-can-play confirmation.
 * v1.3.4: fix null-state poll saving near-zero position and clearing
 *         lastGoodPosition — both gated on streamLoadedSuccessfully now.
 * v1.3.5: fix null-state poll clearing pendingRestoreCheck — the restore
 *         check was lost when state briefly went null during server switches.
 * v1.3.6: fix 403 auto-switch restore — move primary restore into
 *         video-can-play so it fires immediately instead of waiting 3s.
 */
function init() {
    $ui.register((ctx) => {

        // ─── Runtime state ────────────────────────────────────────────────
        let trackedMediaId:    number | null = null
        let trackedEpisode:    number        = 0
        let trackedDuration:   number        = 0
        let trackedKind:       string        = "mediastream"
        let clockStartWall:    number        = 0
        let clockStartCt:      number        = 0
        let isPlaying:         boolean       = false
        let lastSaveMs:        number        = 0
        let bufferFirstSeen:   number        = 0
        // Snapshot of wall-clock position taken just before each stream switch.
        // Survives resetClock(0) so rapid provider/server changes don't lose it.
        let lastGoodPosition:  number        = 0
        // True once video-can-play fires for the current stream. Guards against
        // 403/network errors that never buffer any content — in that case the
        // wall-clock estimate is meaningless and must not overwrite lastGoodPosition.
        let streamLoadedSuccessfully: boolean = false
        // Restore-race detection
        let pendingRestoreCheck: boolean     = false
        let seekedAfterLoad:     boolean     = false
        const SAVE_INTERVAL_MS   = 10000
        const BUFFER_HIDE_MS     = 5000
        const RESTORE_THRESHOLD  = 5

        // ─── Event log (ring buffer, newest first) ─────────────────────────
        // Abbreviations: T=terminated, L=loaded, C=can-play, R=restore,
        // N=null-state, S=seeked, P=paused, E=ended
        const evLog: string[] = []
        function evPush(label: string) {
            evLog.unshift(label)
            if (evLog.length > 6) evLog.pop()
        }

        // ─── Tray ─────────────────────────────────────────────────────────
        const statusLine = ctx.state("Polling...")
        const savedLine  = ctx.state("—")
        const debugLine  = ctx.state("—")
        const evLogLine  = ctx.state("—")

        const tray = ctx.newTray({ tooltipText: "Continuity Sync", withContent: true })
        tray.render(() => tray.stack([
            tray.text("Continuity Sync", { style: { fontWeight: "bold", fontSize: "1rem" } }),
            tray.text(statusLine.get(), { style: { fontSize: "0.8rem", color: "#aaa" } }),
            tray.text("Saved: " + savedLine.get(), { style: { fontSize: "0.8rem", color: "#aaa" } }),
            tray.text(debugLine.get(), { style: { fontSize: "0.75rem", color: "#666" } }),
            tray.text("ev: " + evLogLine.get(), { style: { fontSize: "0.7rem", color: "#555" } }),
        ], { gap: 4, style: { width: "260px", padding: "10px" } }))

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

        function extractKind(state: any): string {
            if (!state) return "mediastream"
            const pi = pick(state, "playbackInfo", "PlaybackInfo")
            const pt = pick(pi, "playbackType", "PlaybackType")
            return String(pt) === "onlinestream" ? "onlinestream" : "mediastream"
        }

        function resetClock(videoSeconds: number) {
            clockStartWall = Date.now()
            clockStartCt   = videoSeconds
            isPlaying      = true
        }

        function currentEstimate(): number {
            if (!isPlaying) return clockStartCt
            const elapsed = (Date.now() - clockStartWall) / 1000
            return clockStartCt + elapsed
        }

        // ─── Save ─────────────────────────────────────────────────────────
        function save(mediaId: number, episode: number, ct: number, dur: number, kind: string, reason: string) {
            if (!mediaId || dur <= 0 || ct <= 0) {
                debugLine.set("skip: mid=" + mediaId + " ct=" + Math.floor(ct) + " dur=" + Math.floor(dur))
                tray.update()
                return
            }
            try {
                ctx.continuity.updateWatchHistoryItem({
                    kind:          kind,
                    filepath:      "",
                    mediaId:       mediaId,
                    episodeNumber: episode,
                    currentTime:   ct,
                    duration:      dur,
                })
                savedLine.set(fmtTime(ct) + " / " + fmtTime(dur) + " [" + kind + "] (" + reason + ")")
                lastSaveMs = Date.now()
                debugLine.set("saved at ct=" + Math.floor(ct) + " ep=" + episode)
                tray.update()
            } catch (e) {
                debugLine.set("save err: " + e)
                tray.update()
            }
        }

        // ─── Restore fallback ──────────────────────────────────────────────
        // Called when no video-seeked arrived after video-loaded, meaning the
        // built-in continuity restore was skipped (initialState.currentTime was 0).
        //
        // Priority:
        //  1. lastGoodPosition — wall-clock snapshot from just before the switch,
        //     most current and survives multiple rapid stream changes.
        //  2. ctx.continuity.getWatchHistoryItem — last server-persisted position,
        //     used when no snapshot exists (first load of a new session).
        function attemptRestoreFallback(mediaId: number, episode: number) {
            let restorePos = 0
            let path = "none"

            // 1. Use our own snapshot if available
            if (lastGoodPosition > RESTORE_THRESHOLD) {
                restorePos = lastGoodPosition
                path = "lgp"
            }

            // 2. Fall back to continuity API
            if (restorePos <= RESTORE_THRESHOLD) {
                try {
                    const history = ctx.continuity.getWatchHistoryItem(mediaId)
                    const item    = pick(history, "item", "Item")
                    if (item) {
                        const savedCt  = parseFloat(String(pick(item, "currentTime", "CurrentTime") || 0))
                        const savedDur = parseFloat(String(pick(item, "duration",    "Duration")    || 0))
                        const savedEp  = parseInt(String(pick(item, "episodeNumber", "EpisodeNumber") || 0), 10)
                        if (savedEp === episode && savedCt > RESTORE_THRESHOLD && savedDur > 0 && savedCt / savedDur < 0.9) {
                            restorePos = savedCt
                            path = "api"
                        }
                    }
                } catch (_) {}
            }

            evPush("R" + Math.floor(restorePos) + "(" + path + ")")
            evLogLine.set(evLog.join(">"))

            if (restorePos <= RESTORE_THRESHOLD) {
                debugLine.set("restore skip lgp=" + Math.floor(lastGoodPosition))
                tray.update()
                return
            }

            ctx.videoCore.seekTo(restorePos)
            resetClock(restorePos)
            lastGoodPosition = 0
            statusLine.set("Restored ep" + episode + " @ " + fmtTime(restorePos))
            debugLine.set("restore ct=" + Math.floor(restorePos) + " via " + path)
            tray.update()
        }

        // ─── Primary poll: every 3s ────────────────────────────────────────
        ctx.setInterval(() => {
            try {
                const rawState  = ctx.videoCore.getPlaybackState()
                const rawStatus = ctx.videoCore.getPlaybackStatus()

                if (!rawState) {
                    if (trackedMediaId) {
                        // Only save if this stream actually played. A 403/failed stream
                        // has streamLoadedSuccessfully=false; saving its near-zero
                        // elapsed time would corrupt the continuity API.
                        if (streamLoadedSuccessfully) {
                            const ct = currentEstimate()
                            save(trackedMediaId, trackedEpisode, ct, trackedDuration, trackedKind, "state-lost")
                            if (ct > RESTORE_THRESHOLD) lastGoodPosition = ct
                        }
                        // else: keep lastGoodPosition as-is — the snapshot from the
                        // last good stream is still needed for the next video-loaded.
                        trackedMediaId           = null
                        isPlaying                = false
                        streamLoadedSuccessfully = false
                        evPush("N(sls=" + (streamLoadedSuccessfully ? "1" : "0") + ",lgp=" + Math.floor(lastGoodPosition) + ")")
                        evLogLine.set(evLog.join(">"))
                    }
                    // Do NOT clear pendingRestoreCheck here. rawState goes null briefly
                    // during server switches (error display between terminated and the
                    // next video-loaded). Clearing it would cancel the restore — when
                    // state comes back, the poll first runs "New video detected" (early
                    // return), so pendingRestoreCheck must still be true for the NEXT
                    // tick to actually call attemptRestoreFallback.
                    statusLine.set("Idle")
                    debugLine.set("no state prc=" + pendingRestoreCheck + " lgp=" + Math.floor(lastGoodPosition))
                    tray.update()
                    return
                }

                const mediaId = extractMediaId(rawState)
                const episode = extractEpisode(rawState)
                const kind    = extractKind(rawState)
                const dur     = parseFloat(String(pick(rawStatus, "duration", "Duration") || 0))

                if (!mediaId) {
                    statusLine.set("State exists but no mediaId")
                    try {
                        const pi = pick(rawState, "playbackInfo", "PlaybackInfo")
                        debugLine.set("pi keys=" + (pi ? JSON.stringify(Object.keys(pi)) : "null"))
                    } catch (e) { debugLine.set("dump err: " + e) }
                    tray.update()
                    return
                }

                // New video detected — start the clock
                if (mediaId !== trackedMediaId) {
                    const initialCt = parseFloat(String(pick(rawStatus, "currentTime", "CurrentTime") || 0))
                    trackedMediaId  = mediaId
                    trackedEpisode  = episode
                    trackedDuration = dur
                    trackedKind     = kind
                    resetClock(initialCt)
                    // pendingRestoreCheck is intentionally NOT reset here —
                    // if it was set by a prior video-loaded, it must survive
                    // this "new video detected" tick and be processed next tick.
                    statusLine.set("Started ep" + episode + " [" + kind + "] (id " + mediaId + ")")
                    debugLine.set("clock started at ct=" + Math.floor(initialCt) + " prc=" + pendingRestoreCheck)
                    tray.update()
                    return
                }

                // ── Restore-race check (first tick after video-loaded) ──────
                if (pendingRestoreCheck) {
                    pendingRestoreCheck = false
                    if (!seekedAfterLoad) {
                        attemptRestoreFallback(mediaId, episode)
                    } else {
                        evPush("Rskip(sal)")
                        evLogLine.set(evLog.join(">"))
                        lastGoodPosition = 0
                    }
                }

                // Continuing same video
                trackedKind = kind
                if (dur > 0) trackedDuration = dur
                const ct = currentEstimate()

                statusLine.set("Watching ep" + trackedEpisode + " @ " + fmtTime(ct) + " [" + kind + "]")
                debugLine.set("est ct=" + Math.floor(ct) + " dur=" + Math.floor(trackedDuration) + " wall+" + Math.floor((Date.now() - clockStartWall) / 1000) + "s")
                tray.update()

                const now = Date.now()
                if (now - lastSaveMs >= SAVE_INTERVAL_MS && trackedDuration > 0 && ct > 0) {
                    save(trackedMediaId, trackedEpisode, ct, trackedDuration, trackedKind, "auto")
                }

            } catch (e) {
                statusLine.set("poll err: " + e)
                tray.update()
            }
        }, 3000)

        // ─── Video events ─────────────────────────────────────────────────

        ctx.videoCore.addEventListener("video-status", (e: any) => {
            const ct  = parseFloat(String(pick(e, "currentTime", "CurrentTime") || 0))
            const dur = parseFloat(String(pick(e, "duration",    "Duration")    || 0))
            const psd = !!(pick(e, "paused", "Paused"))
            if (ct > 0) {
                resetClock(ct)
                if (psd) isPlaying = false
                if (dur > 0 && isFinite(dur)) trackedDuration = dur
            }
        })

        ctx.videoCore.addEventListener("video-can-play", (_e: any) => {
            // Stream has buffered enough to start — the wall-clock estimate is now
            // meaningful and video-terminated should save/preserve position.
            streamLoadedSuccessfully = true

            // Primary restore attempt: fires immediately when video is ready,
            // before the 3s poll has a chance to run. This handles rapid
            // auto-switches (e.g., onFatalError 403) where the poll is too slow.
            // Only restore if:
            //  - video-loaded set pendingRestoreCheck (a switch just happened)
            //  - no built-in seek has arrived yet (seekedAfterLoad=false)
            //  - we have a known good position (lastGoodPosition > threshold)
            //  - the continuity API has no valid saved position for this episode
            //    (if it does, the built-in's restoreSeekTime() will handle it)
            if (pendingRestoreCheck && !seekedAfterLoad && lastGoodPosition > RESTORE_THRESHOLD && trackedMediaId) {
                let builtInWillRestore = false
                try {
                    const history = ctx.continuity.getWatchHistoryItem(trackedMediaId)
                    const item    = pick(history, "item", "Item")
                    if (item) {
                        const savedCt = parseFloat(String(pick(item, "currentTime", "CurrentTime") || 0))
                        const savedEp = parseInt(String(pick(item, "episodeNumber", "EpisodeNumber") || 0), 10)
                        if (savedEp === trackedEpisode && savedCt > RESTORE_THRESHOLD) {
                            builtInWillRestore = true
                        }
                    }
                } catch (_) {}

                if (!builtInWillRestore) {
                    // Built-in API has no valid data — restore immediately.
                    // restoreSeekTime() runs after handleCanPlay, so if we don't
                    // seek now, playback will start at 0.
                    const pos = lastGoodPosition
                    pendingRestoreCheck = false
                    ctx.videoCore.seekTo(pos)
                    resetClock(pos)
                    lastGoodPosition = 0
                    statusLine.set("Restored ep" + trackedEpisode + " @ " + fmtTime(pos) + " (can-play)")
                    evPush("R" + Math.floor(pos) + "(lgp@cp)")
                    evLogLine.set(evLog.join(">"))
                    tray.update()
                }
                // else: built-in has valid data; let restoreSeekTime() fire the
                // seek — video-seeked will arrive and the poll handles any fallback.
            }

            evPush("C")
            evLogLine.set(evLog.join(">"))
            tray.update()
        })

        ctx.videoCore.addEventListener("video-loaded", (e: any) => {
            const state   = e.state || e.State
            const mediaId = extractMediaId(state)
            const episode = extractEpisode(state)
            const kind    = extractKind(state)
            if (mediaId) {
                // Snapshot current position before resetting. streamLoadedSuccessfully
                // here reflects the PREVIOUS stream — only trust the estimate if that
                // stream actually played (video-can-play fired). A failed stream (403
                // etc.) never fires video-can-play so its elapsed wall-clock time is
                // meaningless and must not overwrite lastGoodPosition.
                const estimated = currentEstimate()
                if (trackedEpisode === episode && estimated > RESTORE_THRESHOLD && streamLoadedSuccessfully) {
                    lastGoodPosition = estimated
                } else if (trackedEpisode !== episode) {
                    lastGoodPosition = 0
                }
                // If estimated <= RESTORE_THRESHOLD or stream didn't load, keep
                // lastGoodPosition as-is (a previous good switch may have set it).

                evPush("L(lgp=" + Math.floor(lastGoodPosition) + ",sls=" + (streamLoadedSuccessfully ? "1" : "0") + ")")
                evLogLine.set(evLog.join(">"))

                streamLoadedSuccessfully = false  // reset for the incoming stream
                trackedMediaId      = mediaId
                trackedEpisode      = episode
                trackedKind         = kind
                pendingRestoreCheck = true
                seekedAfterLoad     = false
                resetClock(0)
                statusLine.set("Loaded ep" + episode + " [" + kind + "] (id " + mediaId + ")")
                tray.update()
            }
        })

        ctx.videoCore.addEventListener("video-paused", (e: any) => {
            const ct  = parseFloat(String(pick(e, "currentTime", "CurrentTime") || 0))
            const dur = parseFloat(String(pick(e, "duration",    "Duration")    || 0))
            if (ct > 0) resetClock(ct)
            isPlaying = false
            if (dur > 0 && isFinite(dur) && trackedDuration === 0) trackedDuration = dur
            evPush("P" + Math.floor(ct || currentEstimate()))
            evLogLine.set(evLog.join(">"))
            statusLine.set("Paused ep" + trackedEpisode + " @ " + fmtTime(ct || currentEstimate()))
            tray.update()
            if (trackedMediaId) {
                save(trackedMediaId, trackedEpisode, ct || currentEstimate(), trackedDuration, trackedKind, "paused")
            }
        })

        ctx.videoCore.addEventListener("video-resumed", (_e: any) => {
            isPlaying = true
            clockStartWall = Date.now()
            statusLine.set("Watching ep" + trackedEpisode)
            tray.update()
        })

        ctx.videoCore.addEventListener("video-seeked", (e: any) => {
            const ct = parseFloat(String(pick(e, "currentTime", "CurrentTime") || 0))
            if (ct >= 0) resetClock(ct)
            if (pendingRestoreCheck) {
                seekedAfterLoad = true
                evPush("S" + Math.floor(ct) + "(prc)")
                evLogLine.set(evLog.join(">"))
                tray.update()
            }
        })

        ctx.videoCore.addEventListener("video-terminated", (_e: any) => {
            if (trackedMediaId && streamLoadedSuccessfully) {
                // Only save and snapshot if this stream actually loaded content.
                // A 403/network-error stream never fires video-can-play, so
                // streamLoadedSuccessfully stays false and we skip both to avoid
                // corrupting the continuity API and lastGoodPosition with a
                // meaningless wall-clock estimate.
                const ct = currentEstimate()
                save(trackedMediaId, trackedEpisode, ct, trackedDuration, trackedKind, "closed")
                if (ct > RESTORE_THRESHOLD) {
                    lastGoodPosition = ct
                }
                // If ct is 0 (already reset), keep whatever lastGoodPosition was.
            }
            evPush("T(sls=" + (streamLoadedSuccessfully ? "1" : "0") + ",lgp=" + Math.floor(lastGoodPosition) + ")")
            evLogLine.set(evLog.join(">"))
            trackedMediaId           = null
            pendingRestoreCheck      = false
            isPlaying                = false
            streamLoadedSuccessfully = false
            statusLine.set("Idle")
            tray.update()
        })

        ctx.videoCore.addEventListener("video-ended", (_e: any) => {
            if (trackedMediaId) {
                save(trackedMediaId, trackedEpisode, trackedDuration || currentEstimate(), trackedDuration, trackedKind, "ended")
            }
            evPush("E")
            evLogLine.set(evLog.join(">"))
            trackedMediaId           = null
            pendingRestoreCheck      = false
            lastGoodPosition         = 0
            isPlaying                = false
            streamLoadedSuccessfully = false
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
