/// <reference path="./plugin.d.ts" />

/**
 * Custom Logo
 *
 * Replaces the Seanime sidebar logo with "JC" text.
 */
function init() {
    $ui.register(async (ctx) => {
        async function replaceLogo() {
            try {
                const img = await ctx.dom.queryOne("img[src='/seanime-logo.png']")
                if (!img) return
                const parent = await img.getParent()
                if (!parent) return
                if (await parent.getAttribute("data-jc-logo")) return

                const span = await ctx.dom.createElement("span")
                await span.setInnerHTML("JC")
                await span.setProperty("style",
                    "font-size:1.5rem;font-weight:800;letter-spacing:0.05em;color:#fff;"
                )
                await img.remove()
                await parent.append(span)
                await parent.setAttribute("data-jc-logo", "true")
            } catch (_) {}
        }

        await replaceLogo()

        ctx.dom.observe("img[src='/seanime-logo.png']", async () => {
            await replaceLogo()
        })

        ctx.screen.onNavigate(async () => {
            await replaceLogo()
        })

        ctx.screen.loadCurrent()
    })
}
