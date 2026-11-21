// offscreen_page.js —— 给那间长住的 Chrome 开一张页，但不到人眼前晃。
//
// 收工时那间 Chrome 里一页不留（见 knock_off.js），窗子也就跟着没了。下一趟的手再要用页：屋里有窗，照旧在那扇窗里开标签；
// 屋里一扇窗都没有，就用浏览器的口令把新窗**直接开在屏外**（2000,2000·后台·不抢焦点），别让一扇窗凭空蹦到她正看着的屏幕上。
// 开不成（老版本不认这几个参数）才退回普通开法。
const 屏外开页 = async (browser, ctx) => {
  if (ctx.pages().length) return ctx.newPage();
  try {
    const bs = await browser.newBrowserCDPSession();
    const 等页 = ctx.waitForEvent("page", { timeout: 8000 });
    await bs.send("Target.createTarget", { url: "about:blank", newWindow: true, background: true, left: 2000, top: 2000, width: 1280, height: 900 });
    const page = await 等页;
    try { await bs.detach(); } catch {}
    return page;
  } catch (e) {
    return ctx.newPage();
  }
};
module.exports = { 屏外开页 };
