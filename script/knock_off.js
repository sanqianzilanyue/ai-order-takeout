#!/usr/bin/env node
// knock_off.js —— 干完活把那间长住的 Chrome 里的网页关掉，一页不留（下一趟的手用 offscreen_page.js 把新窗直接开在屏外）。
//
// 她怕登着账号的页面一直挂在后台、被当成机器人，让我每次干完活把网页关掉。从前这只手收工只把自己那一页擦成空白，
// 付款那条链开出来的几页、订单详情页都还挂着。现在：干完活，这只手碰过的站一页不留，白纸也不留。
//
// 用法（都是一次性的，跑完就退，不常驻、不轮询任何网站——只看本机浏览器里开着哪些页）：
//   node knock_off.js                      关掉那间 Chrome(9222) 里所有的页
//   node knock_off.js --域 "ele\.me|alipay\.com"   只关这些站的页（别的手正用着的页不碰）
//   node knock_off.js --藏                  关完若还剩别的手的页，把窗子挪回屏外（环境变量 SHOP_CHROME_HIDE 填一条 shell 命令；没填就不挪）
//   node knock_off.js --接锁                order.js 退出时把「买手锁」交到我手上：我关完页再放锁，下一只手不会撞上我正在关的页
//   node knock_off.js --等 20               留给她点的验证页／登录页：先不关。过了 20 分钟、这些页又原地十分钟没人动、
//                                           没有别的手在干活、她也不在电脑前（键鼠两分钟没动）——才关掉、把窗子藏回去；最多等到一小时。
//                                           她点完验证、有手接着干（网址在变）＝不插手，谁接的活谁收工。
//   node knock_off.js --口 9223             换一间 Chrome
const fs = require("fs"), path = require("path"), os = require("os");
const { chromium } = require("playwright-core");
const argv = process.argv.slice(2);
const 有 = (k) => argv.includes(k);
const 取 = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const 口 = 取("--口", "9222");
const 域 = new RegExp(取("--域", "."), "i");
const 等分 = Number(取("--等", "0")) || 0;
const LOCK = "/tmp/takeout-hand.lock";
const LOG = path.join(__dirname, "收工.log");
const 睡 = (ms) => new Promise((r) => setTimeout(r, ms));
const 记 = (s) => { try { fs.appendFileSync(LOG, `${new Date().toLocaleString("sv")} ${s}\n`); } catch {} };

const 锁主 = () => { try { return Number(fs.readFileSync(LOCK + "/pid", "utf8").trim()) || 0; } catch { return 0; } };
const 活着 = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const 别的手在干活 = () => { const p = 锁主(); return p > 0 && p !== process.pid && 活着(p); };
const 键鼠闲置秒 = () => {
  try {
    const t = require("child_process").execSync("/usr/sbin/ioreg -c IOHIDSystem", { encoding: "utf8", timeout: 5000 });
    const m = t.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    return m ? Number(m[1]) / 1e9 : Infinity;
  } catch { return Infinity; }
};

const 连 = () => chromium.connectOverCDP(`http://127.0.0.1:${口}`, { timeout: 8000 });
const 要关的 = (ctx) => ctx.pages().filter((p) => { const u = p.url(); return u && u !== "about:blank" && !/^(chrome|devtools):/.test(u) && 域.test(u); });

// 关页：这只手碰过的站一页不留，白纸也不留。
//   屋里全关完窗子就没了；下一趟的手用 offscreen_page.js 把新窗直接开在屏外，不到她眼前晃。别的手正用着的页（不在 --域 里的）不碰。
const 关 = async () => {
  const browser = await 连();
  let 关了 = 0;
  try {
    const ctx = browser.contexts()[0];
    if (!ctx) return { 关了, 剩: 0 };
    const 靶 = [...要关的(ctx), ...ctx.pages().filter((p) => p.url() === "about:blank")];
    for (const p of 靶) { try { await p.close(); 关了++; } catch {} }
    return { 关了, 剩: ctx.pages().length };
  } finally { try { await browser.close(); } catch {} }   // connectOverCDP 的 close 只断连，不关那间 Chrome
};
const 藏窗 = () => { try { if (process.env.SHOP_CHROME_HIDE) require("child_process").execSync(process.env.SHOP_CHROME_HIDE, { timeout: 15000, stdio: "ignore" }); } catch {} };

(async () => {
  if (等分 > 0) {
    // 留给她点的页：到点、原地没人动、没有别的手、她不在电脑前，才收
    // （三个 SG_ 开头的环境变量只给桌上试手用：把一拍/原地多久算久/封顶缩短，平时不设）
    const 拍 = Number(process.env.SG_TICK_MS) || 30e3, 原地限 = Number(process.env.SG_IDLE_MS) || 10 * 60e3, 顶 = Number(process.env.SG_CAP_MS) || 60 * 60e3;
    const t0 = Date.now(), 到点 = t0 + 等分 * 60e3, 封顶 = t0 + 顶;
    let 上回 = "", 上回变 = Date.now();
    for (;;) {
      await 睡(拍);
      let 现 = null;
      try { const b = await 连(); try { 现 = 要关的(b.contexts()[0]).map((p) => p.url()).join(" | "); } finally { try { await b.close(); } catch {} } } catch { 现 = null; }
      if (现 === null) { if (Date.now() > 封顶) return; continue; }      // 那间 Chrome连不上：等下一拍
      if (!现) { 记(`等收：这些站的页已经没有了（有手收过工了），不用我关`); return; }
      if (现 !== 上回) { 上回 = 现; 上回变 = Date.now(); }
      const now = Date.now();
      const 原地久了 = now - 上回变 >= 原地限;
      if (now >= 封顶 + 原地限 || (now >= 到点 && 原地久了 && !别的手在干活() && (键鼠闲置秒() >= 120 || now >= 封顶))) break;
    }
    const r = await 关();
    藏窗();
    记(`等收：等了 ${Math.round((Date.now() - t0) / 60e3)} 分钟没人来点，关了 ${r.关了} 页，屋里剩 ${r.剩} 页`);
    return;
  }
  const 接锁 = 有("--接锁");
  try {
    if (!接锁 && 别的手在干活()) { 记("收工：另一只手正在屋里干活，这回不关，留给它收"); return; }
    if (接锁) await 睡(600);     // 等交锁的那只手退干净
    const r = await 关();
    if (有("--藏")) 藏窗();
    记(`收工：关了 ${r.关了} 页，屋里剩 ${r.剩} 页`);
    console.log(`收工：关了 ${r.关了} 页，屋里剩 ${r.剩} 页`);
  } catch (e) {
    记("收工没成：" + String(e && e.message || e).slice(0, 120));
    console.log("收工没成：" + String(e && e.message || e).slice(0, 120));
  } finally {
    if (接锁 && 锁主() === process.pid) { try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch {} }
  }
})();
