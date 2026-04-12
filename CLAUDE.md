# Seanime Extensions

This repo contains plugins for [Seanime](https://seanime.rahim.app) — an anime/manga media server.

Extensions docs: https://seanime.gitbook.io/seanime-extensions

---

## Extension Types

- **Content Providers** — add new sources for torrents, manga, online streaming
- **Plugins** — deeper customization: UI changes, server hooks, file system access, playback control

This repo focuses on **plugins**.

---

## Plugin Structure

Each plugin lives in its own directory:
```
extensions/
  my-plugin/
    plugin.ts       ← plugin code
    manifest.json   ← metadata + permissions
```

### Manifest format

```json
{
    "id": "unique-plugin-id",
    "name": "Display Name",
    "version": "1.0.0",
    "manifestURI": "https://raw.githubusercontent.com/Jbcbro/seanime-extensions/main/extensions/my-plugin/manifest.json",
    "language": "typescript",
    "type": "plugin",
    "description": "What it does",
    "author": "Jbcbro",
    "payload": "<plugin source code as a JSON-escaped string>",
    "plugin": {
        "version": "1",
        "permissions": {
            "playback": {}
        }
    }
}
```

- `manifestURI` — self-referencing URL to this manifest file (required)
- `payload` — the entire plugin source code embedded as a JSON string (NOT a separate file URL)
- `isDevelopment: true` + `payloadURI` to local path can be used during local dev only
- Plugin IDs must be globally unique

**Important:** The plugin code must be embedded directly in `payload` as a JSON-escaped string.
The `plugin.ts` source file is kept separately in the repo for readability, but the manifest
is what Seanime actually reads — keep both in sync.

---

## Plugin Architecture

Plugins run in **two isolated environments** that share state via `$store`:

### Server-side (Hooks)
```typescript
$app.onScanCompleted((e) => {
    $store.set("key", value)
    e.next() // REQUIRED — always call this or other plugins break
})
```

Available hooks: `onGetAnime`, `onAnimeEntryLibraryDataRequested`, `onGetAnimeCollection`, `onGetRawAnimeCollection`, `onScanCompleted`

Full hook list: https://seanime.rahim.app/docs/hooks

### Client-side (UI Context)
```typescript
function init() {
    $ui.register((ctx) => {
        // Business logic and UI live here
        ctx.dom.onReady(() => { ... })
        ctx.screen.onNavigate((e) => { ... })
        ctx.videoCore.addEventListener("video-can-play", () => { ... })
    })
}
```

`$ui.register` is called once on plugin load, right after `init()`.

---

## Key APIs

### VideoCore (requires `"playback"` permission)
```typescript
ctx.videoCore.addEventListener("video-loaded", callback)
ctx.videoCore.addEventListener("video-loaded-metadata", callback)
ctx.videoCore.addEventListener("video-can-play", callback)
ctx.videoCore.pause()
ctx.videoCore.resume()
ctx.videoCore.seek(seconds)        // relative
ctx.videoCore.seekTo(seconds)      // absolute
ctx.videoCore.terminate()
ctx.videoCore.getPlaybackStatus()  // { paused: bool }
ctx.videoCore.getPlaybackState()   // full state object
ctx.videoCore.getCurrentMedia()
```

### External Playback (requires `"playback"` permission)
```typescript
ctx.playback.registerEventListener(callback)  // fires every 1-3s
ctx.playback.pause()
ctx.playback.resume()
ctx.playback.seekTo(seconds)
ctx.playback.cancel()
ctx.playback.getNextEpisode()
ctx.playback.playNextEpisode()
```

### Screen / Navigation
```typescript
ctx.screen.onNavigate((e) => {
    // e.pathname, e.searchParams.id
})
ctx.screen.loadCurrent()  // triggers onNavigate with current page
ctx.screen.reload()
```

### State
```typescript
const count = ctx.state(0)
count.get()
count.set(42)
ctx.effect(() => { ... }, [count])  // runs when deps change
ctx.computed(() => count.get() * 2)
```

### Storage (persistent across sessions)
```typescript
$storage.get<T>("key")
$storage.set("key", value)
$storage.remove("key")
```

### Store (cross-runtime communication)
```typescript
$store.set("key", value)
$store.get("key")
$store.watch("key", callback)
```

### UI Components (Tray)
```typescript
const tray = ctx.newTray({ tooltipText, iconUrl, withContent })
tray.render(() => tray.stack([
    tray.text("hello"),
    tray.button({ label: "Click", onClick: "eventId" }),
    tray.input({ fieldRef }),
]))
tray.updateBadge({ number: 1, intent: "info" })
tray.onOpen(callback)
ctx.registerEventHandler("eventId", callback)
```

### Toast
```typescript
ctx.toast.success("message")
ctx.toast.error("message")
```

### Field Refs
```typescript
const ref = ctx.fieldRef()
ref.setValue("value")
ref.current  // current value
```

### AniList
```typescript
$anilist.refreshAnimeCollection()
```

### Continuity (watch history)
```typescript
ctx.continuity.getWatchHistoryItem(mediaId)
ctx.continuity.updateWatchHistoryItem({ currentTime, duration, mediaId, episodeNumber, kind })
ctx.continuity.getWatchHistory()
ctx.continuity.deleteWatchHistoryItem(mediaId)
```

---

## Permissions Reference

| Key | Purpose |
|-----|---------|
| `playback` | VideoCore + external player control |
| `networkAccess` | HTTP requests (requires `allowedDomains`) |
| `dom-script-manipulation` | Inject JS / manipulate script tags |
| `dom-link-manipulation` | Manipulate link tags |

---

## Important Constraints

- **No Node.js or Browser APIs** — uses Seanime's embedded ES5 JS engine
- **Always call `e.next()`** in every hook handler or downstream plugins break
- **Cannot register hooks inside `$ui.register`**
- Use `ctx.fetch` (not `fetch`) for HTTP requests inside UI context
- Use `$store` to share state between hook and UI contexts

---

## Development Workflow

1. Create `extensions/<name>/plugin.ts` and `manifest.json`
2. Set `"isDevelopment": true` and `"payloadURI"` to local path in manifest
3. Drop manifest into Seanime's extensions directory to load
4. Iterate; use dev mode for hot-reload
5. When done: set `payloadURI` to raw GitHub URL, remove `isDevelopment`
6. Commit and push — user installs by pointing Seanime at the raw manifest URL

---

## Repo Layout

```
extensions/
  auto-pause/
    plugin.ts
    manifest.json
  <next-plugin>/
    plugin.ts
    manifest.json
CLAUDE.md
```
