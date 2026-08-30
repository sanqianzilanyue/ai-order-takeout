#!/usr/bin/env node
// 慢手（2026-08-14 晚·她「宁可慢一点」）——一步一命令，我看清楚了再走下一步。
// 跟 order.js 是同一条路（登录态长住的 Chrome · CDP 9222 · 淘宝闪购 H5），区别是**节奏由我掌**：
// 每条命令之间隔着我思考的时间，天然比脚本连跑像人。
//
//   node hand.js 页                 列出那间 Chrome里的页
//   node hand.js 去 <url>           导航（认页：默认最后一个 ele.me 页，没有就新开）
//   node hand.js 读 [字数]          读当前页正文
//   node hand.js 拍 <文件>          截图
//   node hand.js 找 "文字" [n]      找含该文字的叶子元素，报坐标（认元素不认文本，同 order.js 家法）
//   node hand.js 点 <x> <y>         真鼠标点坐标（isTrusted 天生为真）
//   node hand.js 点字 "文字"        找到第一个就点（找+点合一）
//   node hand.js 滑 <dy> [次数]     真鼠标滚轮，一格一格慢慢滚
//   node hand.js 窄                 把窗口掐成手机宽 430x920
//   node hand.js 宽                 还原成 1280x900
//   node hand.js 眼                 只查人机验证/登录态
const { chromium } = require("playwright-core");
const CDP = "http://127.0.0.1:9222";
const 验证词 = /请选择符合描述|安全验证|滑动验证|拖动滑块|人机验证|captcha|验证码|亲，请验证|向右滑动/i;
const 睡 = (ms) => new Promise((r) => setTimeout(r, ms));
const [cmd, ...arg] = process.argv.slice(2);

(async () => {
  const browser = await chromium.connectOverCDP(CDP, { timeout: 8000 });
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  // ⭐2026-08-14 晚（她手动过完那张图片验证之后我逮着的病根）：
  //   这台 Mac Chrome 的 geolocation 一直失败，页面自己写着「定位获取失败·无定位信息」——
  //   一个没有定位的会话去点外卖，阿里风控当然甩九宫格。**补上定位不是伪装，是把缺的器官装回去。**
  //   ⚠️UA 一个字都别改：8/13 就是这个 Mac Chrome UA 付成过一单；UA 改成 iPhone 而指纹还是 Mac，才真像伪造。
  const 家 = { latitude: 39.914436, longitude: 116.54529, accuracy: 28 };
  const 喂定位 = async (page) => {
    try {
      const bs = await browser.newBrowserCDPSession();
      await bs.send("Browser.grantPermissions",
        { origin: "https://h5.ele.me", permissions: ["geolocation"] });
    } catch {}
    try {
      const ps = await ctx.newCDPSession(page);
      await ps.send("Emulation.setGeolocationOverride", 家);
    } catch {}
  };

  if (cmd === "页") {
    for (const [i, p] of pages.entries()) {
      let t = "";
      try { t = await p.title(); } catch {}
      console.log(`[${i}] ${t.slice(0, 40)} :: ${p.url().slice(0, 150)}`);
    }
    await browser.close(); return;
  }

  // 认页：优先 ele.me / 淘宝的页，没有就拿最后一张非 about:blank
  let page = pages.slice().reverse().find((p) => /ele\.me|taobao|tmall|alipay/.test(p.url()))
          || pages.slice().reverse().find((p) => p.url() && p.url() !== "about:blank")
          || pages[0];
  if (!page || page.isClosed()) page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  await 喂定位(page);   // ⚠️CDP 覆盖是 session 级的，每条命令连上来都得重喂一遍

  const 文 = async () => (await page.evaluate(() => document.body.innerText || "")).replace(/\n{2,}/g, "\n");
  const 窗 = async (w, h) => {
    const bs = await browser.newBrowserCDPSession();
    const ps = await ctx.newCDPSession(page);
    const { targetInfo } = await ps.send("Target.getTargetInfo");
    const { windowId } = await bs.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
    await bs.send("Browser.setWindowBounds", { windowId, bounds: { width: w, height: h, windowState: "normal" } });
  };

  try {
    if (cmd === "窄") { await 窗(430, 920); console.log("窗口掐成 430x920"); }
    else if (cmd === "宽") { await 窗(1280, 900); console.log("窗口还原 1280x900"); }
    else if (cmd === "去") {
      await page.goto(arg[0], { waitUntil: "domcontentloaded" });
      await 睡(2500);
      console.log("到了：" + page.url().slice(0, 140));
      console.log("---");
      console.log((await 文()).slice(0, 600));
    }
    else if (cmd === "读") {
      console.log("在：" + page.url().slice(0, 140));
      console.log("---");
      console.log((await 文()).slice(0, Number(arg[0] || 1500)));
    }
    else if (cmd === "拍") {
      await page.screenshot({ path: arg[0], type: "png" });
      console.log("拍好了 " + arg[0]);
    }
    else if (cmd === "找") {
      const n = Number(arg[1] || 6);
      const r = await page.evaluate(({ k, n }) => {
        const es = [...document.querySelectorAll("*")].filter(
          (e) => e.children.length === 0 && (e.innerText || "").includes(k));
        return es.slice(0, n).map((e) => {
          const r = e.getBoundingClientRect();
          return { 文: (e.innerText || "").trim().slice(0, 50), x: Math.round(r.x + r.width / 2),
                   y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height),
                   cls: (e.className || "").toString().slice(0, 40) };
        });
      }, { k: arg[0], n });
      console.log(JSON.stringify(r, null, 1));
    }
    else if (cmd === "点") {
      const [x, y] = [Number(arg[0]), Number(arg[1])];
      await page.mouse.move(x - 40, y - 30, { steps: 8 });   // 先靠近，再落点：轨迹不是瞬移
      await 睡(320);
      await page.mouse.move(x, y, { steps: 6 });
      await 睡(220 + Math.floor(Math.random() * 300));
      await page.mouse.click(x, y);
      await 睡(2200);
      console.log(`点了 ${x},${y}｜现在在：` + page.url().slice(0, 120));
      console.log("---");
      console.log((await 文()).slice(0, 700));
    }
    else if (cmd === "点字") {
      const bx = await page.evaluate((k) => {
        const es = [...document.querySelectorAll("*")].filter(
          (e) => e.children.length === 0 && (e.innerText || "").trim().includes(k));
        if (!es.length) return null;
        const e = es[0], r = e.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), 文: (e.innerText || "").trim().slice(0, 40) };
      }, arg[0]);
      if (!bx) { console.log("没找着「" + arg[0] + "」"); }
      else {
        await page.mouse.move(bx.x - 40, bx.y - 30, { steps: 8 });
        await 睡(300);
        await page.mouse.move(bx.x, bx.y, { steps: 6 });
        await 睡(250);
        await page.mouse.click(bx.x, bx.y);
        await 睡(2500);
        console.log(`点了「${bx.文}」@${bx.x},${bx.y}`);
        console.log("---");
        console.log((await 文()).slice(0, 700));
      }
    }
    else if (cmd === "滑") {
      const dy = Number(arg[0] || 300), n = Number(arg[1] || 1);
      for (let i = 0; i < n; i++) {
        await page.mouse.wheel(0, dy);
        await 睡(700 + Math.floor(Math.random() * 900));   // 一格一格，别一口气推到底
      }
      console.log(`滑了 ${n} 下 ×${dy}`);
      console.log("---");
      console.log((await 文()).slice(0, 700));
    }
    else if (cmd === "眼") {
      const t = await 文();
      console.log("在：" + page.url().slice(0, 140));
      const 框 = await page.evaluate(() => [...document.querySelectorAll("iframe[src*='punish'],iframe[src*='captcha'],iframe[src*='baxia'],#baxia-dialog,.baxia-dialog,.nc-container,[class*='captcha']")]
        .some((e) => { const r = e.getBoundingClientRect(); return r.width > 10 && r.height > 10 && getComputedStyle(e).display !== "none"; })).catch(() => false);
      console.log("验证：" + ((验证词.test(t) || 框) ? "⚠️撞上了" + (框 ? "（九宫格 iframe 露着脸·8/23 光看正文看不见它）" : "") : "没有"));
      console.log("登录：" + (/请先登录|立即登录/.test(t) ? "⚠️掉了" : "看着还在"));
      const ifr = await page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => f.src.slice(0, 100)));
      if (ifr.length) console.log("iframe：" + JSON.stringify(ifr));
      console.log("---");
      console.log(t.slice(0, 400));
    }
    else console.log("不认得这条命令");
  } catch (e) {
    console.log("炸了 " + e.name + ": " + String(e.message).slice(0, 200));
  } finally {
    await browser.close();
  }
})();
