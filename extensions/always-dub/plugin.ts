/// <reference path="./plugin.d.ts" />

/**
 * Always Dub
 *
 * When the online streaming player loads, automatically clicks "Switch to dub"
 * if the player is in sub mode. Does nothing if dub is already selected.
 */
function init() {
    $ui.register((ctx) => {
        let isOnlinestreamPage = false
        let hasSwitched = false

        ctx.screen.onNavigate((e) => {
            const wasOnPage = isOnlinestreamPage
            isOnlinestreamPage = e.pathname === "/onlinestream"
            // Reset on each fresh navigation to the onlinestream page
            if (!wasOnPage && isOnlinestreamPage) {
                hasSwitched = false
            }
        })

        // Pick up current page in case the plugin loads mid-session
        ctx.screen.loadCurrent()

        // Watch for the dub toggle button to appear in the DOM.
        // The button reads "Switch to dub" when sub is active, "Switch to subs" when dub is active.
        ctx.dom.observe("button", (buttons) => {
            if (!isOnlinestreamPage || hasSwitched) return

            for (let i = 0; i < buttons.length; i++) {
                const text = buttons[i].textContent
                if (text && text.trim() === "Switch to dub") {
                    hasSwitched = true
                    // DOMElement has no click() — inject a script to trigger it natively
                    ctx.dom.createElement("script").then((script) => {
                        script.setInnerHTML(
                            "(function(){" +
                            "var b=document.querySelectorAll('button');" +
                            "for(var i=0;i<b.length;i++){" +
                            "if(b[i].textContent&&b[i].textContent.trim()==='Switch to dub'){" +
                            "b[i].click();break;" +
                            "}}" +
                            "if(document.currentScript)document.currentScript.remove();" +
                            "})()"
                        )
                        ctx.dom.queryOne("body").then((body) => {
                            if (body) body.appendChild(script)
                        })
                    })
                    break
                }
            }
        })
    })
}
