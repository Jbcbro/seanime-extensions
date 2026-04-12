/// <reference path="./plugin.d.ts" />

/**
 * Always Dub
 *
 * When the online streaming player loads, automatically switches to dubbed audio
 * if the player is currently in sub mode. It retries on each new video load.
 */
function init() {
    $ui.register((ctx) => {
        let isOnlinestreamPage = false
        let hasSwitchedForCurrentLoad = false

        function normalizeText(value: any) {
            return String(value || "")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, " ")
                .trim()
        }

        function isDubToggleText(value: any) {
            const text = normalizeText(value)
            if (!text) return false
            if (text.indexOf("switch to dub") !== -1) return true
            if (text === "dub") return true
            if (text.indexOf("english dub") !== -1) return true
            if (text.indexOf("audio dub") !== -1) return true
            if (text.indexOf("dubbed") !== -1) return true
            return text.indexOf("dub") !== -1 && (
                text.indexOf("audio") !== -1 ||
                text.indexOf("language") !== -1 ||
                text.indexOf("track") !== -1
            )
        }

        async function elementLooksLikeDubToggle(el: any): Promise<boolean> {
            try {
                if (isDubToggleText(el.textContent)) return true
            } catch { }

            try {
                if (isDubToggleText(await el.getAttribute("aria-label"))) return true
            } catch { }

            try {
                if (isDubToggleText(await el.getAttribute("title"))) return true
            } catch { }

            return false
        }

        function clickDubToggle() {
            ctx.dom.createElement("script").then((script) => {
                script.setInnerHTML(
                    "(function(){" +
                    "function n(v){return String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}" +
                    "function m(v){" +
                    "var t=n(v);" +
                    "if(!t)return false;" +
                    "if(t.indexOf('switch to dub')!==-1)return true;" +
                    "if(t==='dub')return true;" +
                    "if(t.indexOf('english dub')!==-1)return true;" +
                    "if(t.indexOf('audio dub')!==-1)return true;" +
                    "if(t.indexOf('dubbed')!==-1)return true;" +
                    "return t.indexOf('dub')!==-1&&(t.indexOf('audio')!==-1||t.indexOf('language')!==-1||t.indexOf('track')!==-1);" +
                    "}" +
                    "var nodes=document.querySelectorAll('button,[role=\"button\"]');" +
                    "for(var i=0;i<nodes.length;i++){" +
                    "var node=nodes[i];" +
                    "var label=(node.textContent||'')+' '+(node.getAttribute('aria-label')||'')+' '+(node.getAttribute('title')||'');" +
                    "if(m(label)){node.click();break;}" +
                    "}" +
                    "if(document.currentScript)document.currentScript.remove();" +
                    "})()"
                )

                ctx.dom.queryOne("body").then((body) => {
                    if (body) body.appendChild(script)
                })
            })
        }

        async function trySwitchToDub() {
            if (!isOnlinestreamPage || hasSwitchedForCurrentLoad) return

            const buttons = await ctx.dom.query("button, [role='button']")
            for (let i = 0; i < buttons.length; i++) {
                if (await elementLooksLikeDubToggle(buttons[i])) {
                    hasSwitchedForCurrentLoad = true
                    clickDubToggle()
                    break
                }
            }
        }

        ctx.screen.onNavigate((e) => {
            isOnlinestreamPage = e.pathname === "/onlinestream"
            hasSwitchedForCurrentLoad = false
            if (isOnlinestreamPage) trySwitchToDub()
        })

        ctx.screen.loadCurrent()

        ctx.videoCore.addEventListener("video-loaded", () => {
            if (!isOnlinestreamPage) return
            hasSwitchedForCurrentLoad = false
            trySwitchToDub()
        })

        ctx.videoCore.addEventListener("video-can-play", () => {
            if (!isOnlinestreamPage) return
            trySwitchToDub()
        })

        ctx.dom.observe("button, [role='button']", () => {
            trySwitchToDub()
        })
    })
}
