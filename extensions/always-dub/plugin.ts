/// <reference path="./plugin.d.ts" />

/**
 * Always Dub
 *
 * When the online streaming player loads, automatically switches to dubbed audio
 * if the player is currently in sub mode. It retries on each new video load.
 */
function init() {
    $ui.register((ctx) => {
        let hasTriggeredForCurrentPage = false

        function clickDubToggle() {
            ctx.dom.createElement("script").then((script) => {
                script.setInnerHTML(
                    "(function(){" +
                    "if(window.__alwaysDubSwitching)return;" +
                    "window.__alwaysDubSwitching=true;" +
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
                    "var tries=0;" +
                    "var timer=setInterval(function(){" +
                    "tries++;" +
                    "var clicked=false;" +
                    "var nodes=document.querySelectorAll('button');" +
                    "for(var i=0;i<nodes.length;i++){" +
                    "var node=nodes[i];" +
                    "var label=(node.textContent||'')+' '+(node.getAttribute('aria-label')||'')+' '+(node.getAttribute('title')||'');" +
                    "if(m(label)){node.click();clicked=true;break;}" +
                    "}" +
                    "if(clicked||tries>=20){" +
                    "clearInterval(timer);" +
                    "window.__alwaysDubSwitching=false;" +
                    "}" +
                    "}, 500);" +
                    "if(document.currentScript)document.currentScript.remove();" +
                    "})()"
                )

                ctx.dom.queryOne("body").then((body) => {
                    if (body) body.append(script)
                })
            })
        }

        function trySwitchToDub() {
            if (hasTriggeredForCurrentPage) return
            hasTriggeredForCurrentPage = true
            clickDubToggle()
        }

        ctx.screen.onNavigate(() => {
            hasTriggeredForCurrentPage = false
            trySwitchToDub()
        })

        ctx.screen.loadCurrent()

        ctx.dom.observe("button", () => {
            trySwitchToDub()
        })
    })
}
