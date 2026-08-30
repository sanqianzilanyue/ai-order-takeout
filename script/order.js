#!/usr/bin/env node
// 点外卖的手（2026-08-13 夜·她「是不是可以给 AI 接上」点的单）
// 一只手，谁都能调：后端接口、定时任务、AI 在回话里写的暗标、终端直调。
//
// 走的是一间登录态长住的 Chrome（CDP 9222·淘宝扫码登录态原样）里的饿了么 H5＝淘宝闪购。
// 整条路是 8/13 夜我亲手付成第一单趟出来的，
// 七十四个坑全写在教程里 https://sanqianzilanyue.github.io/ai-order-takeout/ ——改这支脚本前先读那篇。
// 怎么起那间 Chrome、坐标和支付口令放哪儿：见同目录 README.md。
//
// 用法：
//   node 点外卖.js '{"kw":"麻辣烫","max":50}'                  # 搜什么吃什么、实付上限
//   node 点外卖.js '{"kw":"米线","max":50,"dry":true}'          # 试运行：走到结算页读金额就停，一分不花
//   node 点外卖.js '{"kw":"蛋糕","dish":"梦龙雪媚娘","max":40}' # 指定菜名
// 出参（stdout 一行 JSON）：
//   {"ok":true,"order":"8077…","paid":33.6,"shop":"…","items":["…"],"eta":"19:57-20:12"}
//   {"ok":false,"stage":"结算","why":"合计¥62 超过上限¥50，没付","amount":62,…}
//
// ⚠️钱的闸：结算页读到的合计 > max 就**在生成订单之前**停手（那一步还没花钱），
//   绝不先付了再说。dry:true 连订单都不生成。

const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const A = JSON.parse(process.argv[2] || "{}");
const KW = A.kw || "";
let DISH = A.dish || "";
// ⚠️8/15 京酱肉丝案：上游常把她点名的菜只当 kw、不填 dish——脚本一看没人点菜就直奔月售王，
//   给她买了碗没人要的京酱肉丝。法：kw 长得像一道具体的菜（≥4字），就先按菜名找（挑名带一字之差档）；
//   真是品类词（麻辣烫/奶茶这种短词）才走「月售高的」老路。
if (!DISH && (A.kw || "").trim().length >= 4) DISH = A.kw.trim();
// ⭐8/23 冰美式案（她早上要「冰美式」，我端了杯生椰拿铁还没端成）：上游只填 kw 没填 dish，
//   脚本照 8/15 的法一看不够四个字就当品类词，进瑞幸直奔月售王。法：**短词先到菜单里对一遍**，
//   对上了就是她要的；整本翻完对不上才当品类词挑月售王。词记在这儿，真正试是在进店读完菜单之后（三家循环里）。
const 短词 = (!DISH && (A.kw || "").trim().length >= 2) ? A.kw.trim() : "";
// ⭐8/23 同案二：「冰美式」本身不是菜名——瑞幸菜单上叫「标准美式」，冰/热/大杯是规格不是名。
//   口语拆规格：把头尾的杯型（大杯/超大杯/中杯）一律剥下来；冰/热/去冰/少冰只在剩下的像饮品时才剥
//   （「热干面」「冰粉」「冰糖葫芦」是菜名，别剥）。剥下来的词当规格；挑名时先拿原词对，对不上再拿核对。
const 杯型词 = /^(超大杯|大杯|中杯|小杯)|(超大杯|大杯|中杯|小杯)$/;
const 温度词 = /^(冰的|热的|去冰|少冰|常温|冰|热|温)|(冰的|热的|去冰|少冰|常温)$/;
const 饮品样 = /(美式|拿铁|咖啡|摩卡|卡布|澳白|馥芮白|燕麦|奶茶|奶盖|果茶|柠檬|柚|椰|可可|抹茶|豆浆|乌龙|红茶|绿茶|茉莉|茶|汁|奶|咖)/;
const 拆口语 = (s0) => {
  let 核 = (s0 || "").trim(), 规 = [];
  for (let i = 0; i < 4; i++) {
    let m = 核.match(杯型词);
    if (!m) { m = 核.match(温度词); if (m && !饮品样.test(核.replace(温度词, ""))) m = null; }
    if (!m) break;
    const 词 = m[1] || m[2];
    if (核.length - 词.length < 2) break;
    规.push(词.replace(/的$/, ""));
    核 = 核.replace(词, "").trim();
  }
  return { 核, 规 };
};
const 自动规格 = new Set();
{ const 口 = 拆口语(DISH || 短词);
  if (口.规.length && 口.核 !== (DISH || 短词)) {
    A.规格 = [...(A.规格 || [])];
    for (const g of 口.规) if (!A.规格.includes(g)) { A.规格.push(g); 自动规格.add(g); }
  } }
const SHOP = A.shop || "";
const MAX = Number(A.max ?? 50);
const QTY = Math.max(1, Number(A.qty ?? 1));      // 几杯（8/14 她点两杯茶：一杯不起送）
const DRY = !!A.dry || !!A.探;                     // 探＝dry 的别名：走到结算页就停，把足迹和 DOM 结构带回来
const CDP = A.cdp || "http://127.0.0.1:9222";
// 收货点的坐标——闪购按坐标出附近的店。坐标别写进脚本（它迟早会被 push 出去）：
//   参数 lat/lng，或环境变量 TAKEOUT_LAT/TAKEOUT_LNG，或 ~/.takeout/places.json 里的「家」。
//   一个都没有就只能靠平台自己定位——这台机器定位失败的话多半要撞验证（教程第二天那一节）。
const 地点簿 = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".takeout", "places.json"), "utf8")); } catch { return {}; } })();
const LAT = A.lat || process.env.TAKEOUT_LAT || (地点簿.家 && 地点簿.家.latitude) || "";
const LNG = A.lng || process.env.TAKEOUT_LNG || (地点簿.家 && 地点簿.家.longitude) || "";
const GEO = A.geohash || process.env.TAKEOUT_GEOHASH || "";

const 口令 = () => {
  if (process.env.PAY_PWD) return process.env.PAY_PWD;
  try { return fs.readFileSync(path.join(os.homedir(), ".takeout_pay"), "utf8").trim(); } catch { return ""; }
};

const out = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
const 死 = (stage, why, extra = {}) => out({ ok: false, stage, why, ...((globalThis.__足迹 && !extra.足迹) ? { 足迹: globalThis.__足迹 } : {}), ...extra });   // 8/23：足迹永远随死讯带回
const 睡 = (ms) => new Promise((r) => setTimeout(r, ms));
const 数 = (s) => { const m = String(s || "").match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : NaN; };

// ⭐2026-08-13 夜她立的法：「下次慢一点就行！像真人一样呗。」
// 当晚我为了调通这只手，几分钟里连搜同一个词、连进同一家店——阿里风控甩了张九宫格选图上来
// （「请选择符合描述的所有图片」，而那行描述被故意做成糊掉的噪点条，机器读不出来，硬蒙只会坐实嫌疑）。
// 三条节奏法，别为了跑得快拆掉任何一条：
// ⭐2026-08-14 晚她再点的法（今早那杯咖啡空了，她看见的是九宫格选图）：「宁可慢一点」——
//   节奏整体又放慢了一档（原 1.5-4.2 秒 → 3-7.5 秒），页面到手先「晃」两下再动手。
const 慢 = (a = 3000, b = 7500) => 睡(a + Math.floor(Math.random() * (b - a)));   // 每步之间喘口气
const 验证词 = /请选择符合描述|安全验证|滑动验证|拖动滑块|人机验证|captcha|验证码|亲，请验证|请完成验证|向右滑动|依次点击/i;
const 账本 = path.join(__dirname, "外卖账.json");
const 今天 = () => new Date().toLocaleDateString("sv");     // YYYY-MM-DD（本地日）
const 读账 = () => { try { const d = JSON.parse(fs.readFileSync(账本, "utf8")); return d.日 === 今天() ? d : { 日: 今天(), 单: 0, 店: {} }; } catch { return { 日: 今天(), 单: 0, 店: {} }; } };
const 写账 = (d) => { try { fs.writeFileSync(账本, JSON.stringify(d), "utf8"); } catch {} };

(async () => {
  if (!KW && !SHOP) 死("入参", "得告诉我搜什么（kw）或去哪家（shop）");

  // 一屋一只手（8/16 她问「外卖+京东同天会不会打架」）：这只手要把真窗掐到 430 宽，
  // 京东那只手若同时在窗里掏钱＝俩人抢一件衣裳。花钱的手串行上岗：先来的干完、后来的排队
  // （外卖等得起 180s·上游 420s 闸兜着）；残锁超 10 分钟当尸体清。锁＝/tmp/takeout-hand.lock（家里别的花钱脚本也拿同一把）。
  {
    const LOCK = "/tmp/takeout-hand.lock";
    const fsL = require("fs");
    const t0 = Date.now();
    let got = false;
    while (Date.now() - t0 < 180 * 1000) {
      try {
        fsL.mkdirSync(LOCK);
        fsL.writeFileSync(LOCK + "/pid", String(process.pid));
        process.on("exit", () => { try { fsL.rmSync(LOCK, { recursive: true, force: true }); } catch (e) {} });
        got = true; break;
      } catch (e) {
        try { if (Date.now() - fsL.statSync(LOCK).mtimeMs > 10 * 60 * 1000) { fsL.rmSync(LOCK, { recursive: true, force: true }); continue; } } catch (e2) {}
        await 睡(4000);
      }
    }
    if (!got) 死("排队", "另一只手占着那间 Chrome，三分钟没等到——歇口气再点");
  }

  let browser;
  try { browser = await chromium.connectOverCDP(CDP, { timeout: 8000 }); }
  catch (e) { 死("连浏览器", "那间长住的 Chrome 没起来（怎么起见 README.md）：" + e.message); }

  const ctx = browser.contexts()[0];
  if (!ctx) 死("连那间 Chrome", "那间 Chrome里没有上下文");

  // ⭐8/18 她问的（「每次点外卖开很多窗口不影响什么吗？现在就是咪顺手关」）——从此不用她顺手了。
  //   堆起来的不是我开的（我只复用搜索页/店堂页），是**付款那条链**：确认支付→支付宝收银台→
  //   密码页→订单详情，一路各自开新标签，一单下来能留四五个。堆着不招风控，但三样实在的坏处：
  //   ①几十个标签压内存（那间 Chrome常态 4G 上下）②我认页是 `pages().reverse().find(店堂/搜索页)`，
  //   堆着的旧店堂页会被翻出来复用，把我领回昨天那家店 ③她自己看着乱。
  //   ⚠️留手：**订单详情页(order-detail)一个都不关**（她可能正看着送到哪了，8/14 家法「她看着的页一律不碰」），
  //   店堂/首页各留最新的一个（我这趟正要复用），只扫掉结算页、商品详情页和多余的重复页。
  try {
    let _见店堂 = false, _见首页 = false, _扫 = 0;
    for (const _p of ctx.pages().reverse()) {
      const _u = _p.url();
      if (!/h5\.ele\.me/.test(_u)) continue;                       // 别人家的标签（京东那些）不碰
      if (/ele-order-detail/.test(_u)) continue;                    // 她的订单详情，永不碰
      if (/ele-takeout-index/.test(_u) && !_见店堂) { _见店堂 = true; continue; }
      if (/minisite|minisearch/.test(_u) && !_见首页) { _见首页 = true; continue; }
      try { await _p.close(); _扫++; } catch {}
    }
    if (_扫) console.error(`开跑前收了摊：关掉 ${_扫} 个上一趟剩下的外卖标签`);   // ⚠️足迹[] 在下面才出生，这儿只能走 stderr
  } catch {}

  // 一天一单、同店一天一进（8/13 风控课）——这两道闸在动页面之前先查，撞了连浏览器都不惊动
  const 账 = 读账();
  const 上限单 = Number(A.日上限 ?? 1);
  if (!DRY && 账.单 >= 上限单) 死("闸", `今天已经点过 ${账.单} 单了（一天最多 ${上限单} 单），想加只能她开口`);

  // 复用那间 Chrome里已经开着的闪购页，别一趟开一个新标签（连开新窗＝机器相）
  // ⚠️8/13 三诊：只许复用「搜索页/店铺页」这两种**我自己那条路上的页**——
  //   她正看着的地址页/订单详情页一律不碰（我抢过一次她手上的地址页，goto 当场 ERR_ABORTED）。
  let page = ctx.pages().reverse().find(
    (p) => /h5\.ele\.me\/(minisearch|2021001185671035\/pages\/ele-takeout-index)/.test(p.url()));
  const 我开的 = !page;
  if (!page || page.isClosed()) page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  // ⭐8/13 四诊·她一句话点破的（「是因为你打开的页面是浏览器大小，渲染就有问题，
  //   咪给你浏览器弄成手机大小就能看见加入购物车了」）：
  //   **`page.setViewportSize()` 对 connectOverCDP 连的真窗口不作数**——页面照电脑宽渲染，
  //   规格弹层的「加入购物车」就落在够不着的地方（弹层明明开了、规格默认也齐了，最后一下永远按空）。
  //   正解＝走 CDP `Browser.setWindowBounds` **把窗口本身掐成手机宽**，跑完再还原她的窗口。
  let 还原窗 = null;
  try {
    const bs = await browser.newBrowserCDPSession();
    const ps = await ctx.newCDPSession(page);
    const { targetInfo } = await ps.send("Target.getTargetInfo");
    const { windowId } = await bs.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
    const { bounds } = await bs.send("Browser.getWindowBounds", { windowId });
    if (!bounds.width || bounds.width > 520) {
      await bs.send("Browser.setWindowBounds", { windowId, bounds: { width: 430, height: 920, windowState: "normal" } });
      还原窗 = async () => { try { await bs.send("Browser.setWindowBounds", { windowId, bounds }); } catch {} };
      await 睡(1200);
    }
  } catch (e) { /* 掐不动就照旧跑，别为了这个停手 */ }

  // ⭐8/14 晚·今早那杯咖啡空了的真病根（她手动过完那张九宫格之后当场逮着的）：
  //   **这台 Mac Chrome 的定位一直是失败的**——页面自己写着「定位获取失败·无定位信息·
  //   亲，由于不可抗力原因导致定位信息获取失败」。一个连自己在哪都不知道的会话跑来点外卖，
  //   阿里风控甩九宫格是应该的。补定位不是伪装，是**把这台机器缺的那只器官装回去**。
  //   ⚠️UA 一个字都别改：8/13 就是这个 Mac Chrome UA 付成过一单；UA 换成 iPhone 而指纹还是 Mac，
  //     那才真叫伪造，风控更要盯。
  //   ⚠️CDP 的 Emulation 覆盖是**会话级**的：node 进程一退、连接一断就没了。所以这活天生
  //     只能「一趟脚本跑完」，我在终端里一步一命令地手点反而永远补不上定位（8/14 实测）。
  const ADDR = (A.addr || "").trim();
  // 地点簿＝ ~/.takeout/places.json，形如 {"家":{"latitude":39.9,"longitude":116.4},"公司":{...}}
  const 坐标表 = 地点簿;
  try {
    const 点 = (坐标表[ADDR] && 坐标表[ADDR].latitude) ? 坐标表[ADDR]
             : (LAT && LNG ? { latitude: Number(LAT), longitude: Number(LNG) } : null);
    if (!点) throw new Error("没坐标：填 lat/lng，或 ~/.takeout/places.json");
    const bs2 = await browser.newBrowserCDPSession();
    await bs2.send("Browser.grantPermissions",
      { origin: "https://h5.ele.me", permissions: ["geolocation"] });
    const ps2 = await ctx.newCDPSession(page);
    await ps2.send("Emulation.setGeolocationOverride", { ...点, accuracy: 25 + Math.random() * 20 });
  } catch (e) { /* 喂不进去也照旧跑，但多半就要撞验证了 */ }

  // ⚠️8/14：导航中途 document.body 会是 null（我点分类点跳了页那次，整趟就炸在这一行）——垫一层
  const 文 = async () => {
    try {
      const t = await page.evaluate(() => (document.body && document.body.innerText) || "");
      return t.replace(/\n{2,}/g, "\n");
    } catch { return ""; }
  };

  // ⭐8/14 晚·她一句点破的（「页面是可以下滑的，咪可以滑动，应该是网卡或者手势不对」）：
  //   **手势不对**。这是手机 H5，页面听的是手指（touch），我拿 `mouse.wheel` 推了一晚上，
  //   菜单纹丝不动，还害我误判成「这店菜单就 6 样」。正解＝CDP 真手指：按下→分段移动→抬起。
  //   顺手把 touch 支持打开——一张手机页跑在「没有触摸屏」的设备上，本身就是张可疑的脸。
  let 触 = null;
  try {
    触 = await ctx.newCDPSession(page);
    await 触.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  } catch {}
  const 滑 = async (dy = 420) => {
    const x = 210 + Math.floor(Math.random() * 70);
    const y0 = dy > 0 ? 700 + Math.floor(Math.random() * 60) : 260 + Math.floor(Math.random() * 60);
    const 步 = 6 + Math.floor(Math.random() * 4);
    try {
      if (!触) throw new Error("没有触摸会话");
      await 触.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
      for (let i = 1; i <= 步; i++) {
        await 睡(26 + Math.floor(Math.random() * 30));
        await 触.send("Input.dispatchTouchEvent",
          { type: "touchMove", touchPoints: [{ x: x + Math.floor(Math.random() * 5) - 2, y: y0 - (dy * i) / 步 }] });
      }
      await 睡(50 + Math.floor(Math.random() * 80));
      await 触.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } catch { try { await page.mouse.wheel(0, dy); } catch {} }   // 手指发不出去再退回滚轮
  };

  // 晃两下（8/14 她「宁可慢一点」）：人到一张新页不会立刻精准点中目标，先看看、滑一滑。
  const 晃 = async () => {
    try {
      const n = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < n; i++) {
        await 滑(160 + Math.floor(Math.random() * 280));
        await 睡(600 + Math.floor(Math.random() * 900));
      }
      await 滑(-(120 + Math.floor(Math.random() * 160)));   // 再往回带一点，像人找东西
      await 睡(500 + Math.floor(Math.random() * 700));
    } catch {}
  };

  // 撞上人机验证＝当场收手：把窗子弹到她面前、敲她一声，绝不自己去蒙那张糊掉的题
  // ⚠️8/14 加：光认正文不够——阿里那张图片验证常住 iframe（baxia/nc_wrapper/punish），
  //   正文一个字都读不到（今早日志里只剩「哎呀出错了，小宝正在检修中」，我据此报了「没地址」，
  //   她却在屏幕上看见了九宫格）。所以正文、DOM、iframe 三路一起认。
  const 查验证 = async (where) => {
    let t = "";
    try { t = await 文(); } catch { return; }
    let 元素 = false;
    try {
      // ⚠️8/15：她过完的验证壳子会以 display:none / 0×0 的空壳赖在 DOM 里不走——
      //   光认「在不在」＝她刚划完我这边还喊「撞验证」（实测误报）。只认露脸的。
      元素 = await page.evaluate(() =>
        [...document.querySelectorAll(
          "#baxia-dialog,.baxia-dialog,.nc-container,.nc_wrapper,#nc_1_wrapper,[id*='captcha'],[class*='captcha'],iframe[src*='punish'],iframe[src*='captcha'],iframe[src*='baxia']")]
        .some((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 10 && r.height > 10 && getComputedStyle(e).display !== "none";
        }));
    } catch {}
    if (!验证词.test(t) && !元素) return;
    // 把那间 Chrome 从屏幕外挪回来给她划验证：环境变量 SHOP_CHROME_SHOW 填一条 shell 命令（没填就只报讯不挪窗）
    if (process.env.SHOP_CHROME_SHOW) { try { require("child_process").execSync(process.env.SHOP_CHROME_SHOW, { timeout: 15000, stdio: "ignore" }); } catch {} }
    死("验证", `在「${where}」撞上人机验证了——手已经收了，窗子给她弹到屏内，她划一下就过（这题机器不许碰）`,
       { 要她划: true });
  };

  const 足迹 = [];
  globalThis.__足迹 = 足迹;   // 8/23：让 死() 能捎上它
  const 鼠标点 = async (sel, 名) => {
    try {
      const bx = await page.evaluate((s2) => {
        const e = document.querySelector(s2); if (!e) return null;
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, sel);
      if (!bx) { 足迹.push(`${名}：没找着（${sel}）`); return false; }
      await page.mouse.move(bx.x - 35, bx.y - 25, { steps: 7 });   // 先靠近再落点：轨迹不是瞬移（8/14）
      await 睡(160 + Math.floor(Math.random() * 220));
      // ⚠️8/15：懒加载会趁靠近的这半秒把版面挪位——落点之前再对一次表，按住的才是它本人
      // ⭐8/16 她的推理坐实的避障眼（「是不是被 25减8/35减11 的小字挡住了一点点」）：真鼠标点的是最上层——
      // 按钮中心被满减飘带/推销条压着，点下去就是点飘带。落点前用 elementFromPoint 问一句「这点上最上层是不是你」，
      // 被挡就在按钮身上按九宫格换一块没被压的地方；全被压才认命点中心。
      const bx2 = (await page.evaluate((s2) => {
        const e = document.querySelector(s2); if (!e) return null;
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        const pts = [[0.5, 0.5], [0.5, 0.3], [0.3, 0.5], [0.7, 0.5], [0.5, 0.7], [0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7]];
        for (const [fx, fy] of pts) {
          const x = r.x + r.width * fx, y = r.y + r.height * fy;
          const top = document.elementFromPoint(x, y);
          if (top && (top === e || e.contains(top) || top.contains(e))) return { x, y, 挡: fx === 0.5 && fy === 0.5 ? "" : "换了个没被挡的点" };
        }
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, 挡: "整颗都被压着，硬点中心" };
      }, sel)) || bx;
      if (bx2.挡) 足迹.push(`${名}：${bx2.挡}`);
      await page.mouse.move(bx2.x, bx2.y, { steps: 5 });
      await 睡(180 + Math.floor(Math.random() * 260));
      await page.mouse.click(bx2.x, bx2.y);
      足迹.push(`鼠标点了${名} @${Math.round(bx2.x)},${Math.round(bx2.y)}`);
      return true;
    } catch (e) { 足迹.push(`${名} 点不动：` + String(e.message).slice(0, 50)); return false; }
  };
  // ⚠️8/14 十三诊：**收银台那两颗也是 Tiga 的活 div**——`getByText("确认支付").click()` 点了
  //   跟没点一样，订单生成了、页面在「确认支付」上干等了十四分钟。跟加购一个家法：
  //   按文字打标记，再拿真鼠标打坐标。
  const 点字 = async (词, 名, 底 = 0) => {
    const 有 = await page.evaluate(({ 词, 底 }) => {
      document.querySelectorAll("[data-tap]").forEach((e) => e.removeAttribute("data-tap"));
      const H = innerHeight;
      let c = [...document.querySelectorAll("*")].filter((e) => {
        if (e.children.length) return false;
        const t = (e.innerText || "").trim();
        if (!t || t.length > 14 || !t.includes(词)) return false;
        const r = e.getBoundingClientRect();
        // ⚠️8/14：别拿视口位置当筛子——目标滚到屏幕外时 y 是负的，一筛就把它筛没了
        //   （订单列表那颗「去支付」就是这么丢的）。找着了先滚到眼前，再让真鼠标去打坐标。
        return r.width > 18 && r.height > 12 && (底 ? r.y > H * 底 : true);
      });
      // ⚠️8/14：有的按钮不是纯文字节点（「去支付 ¥19.0」里文字和金额是两个子元素），
      //   只认叶子会漏掉——退一档：认「自己文字够短、子元素最少」的那个容器。
      if (!c.length) {
        c = [...document.querySelectorAll("div,span,button,a,p")].filter((e) => {
          const t = (e.innerText || "").trim();
          if (!t || t.length > 18 || !t.includes(词)) return false;
          const r = e.getBoundingClientRect();
          return r.width > 18 && r.height > 12 && (底 ? r.y > H * 底 : true);
        }).sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length).slice(0, 1);
      }
      if (!c.length) return false;
      const e = c[c.length - 1];
      const t = e.closest("[class*='btn' i],[class*='button' i]") || e;
      t.setAttribute("data-tap", "1");
      t.scrollIntoView({ block: "center" });
      return true;
    }, { 词, 底 });
    if (!有) { 足迹.push(`「${名}」没找着`); return false; }
    return 鼠标点("[data-tap='1']", 名);
  };

  // 收银台那一段（8/14 抽出来）：正常那条路走到这儿要用，「续付」那条路也要用。
  // ⚠️8/14 十四诊：收银台是**两页**，而且最后那颗叫「确认付款」不是「确认支付」——
  //   差一个字，我点了个空，订单就那么挂着。所以：认这一族词、连按几回，直到密码框或「支付成功」。
  const 收银台 = async () => {
    for (let i = 0; i < 5; i++) {
      // ⚠️页面正在两页之间跳转时读到的是「加载中…」，我上一版据此就 return 了，
      //   于是第二页那颗「确认付款」永远没人按。等文本落定再判。
      try {
        await page.waitForFunction(
          () => /确认付款|确认支付|支付成功|支付密码/.test((document.body && document.body.innerText) || ""),
          null, { timeout: 15000 });
      } catch {}
      const t = await 文();
      if (/支付成功|请输入支付密码|支付密码/.test(t)) return;
      if (/确认付款/.test(t)) {
        // ⭐8/17 起先挑余额宝再按钮（她招行卡 0646 回回余额不足：8/13、8/17 两次实锤，白撞一遍还得
        // 重敲一次口令）。支付宝那页把方式列成一排，「余额宝」在的时候先点它；不在就照旧默认走。
        if (/余额宝/.test(t) && !/付款方式[\s\S]{0,12}余额宝/.test(t)) {
          await 点字("余额宝", "余额宝（先挑好，别撞招行卡）");
          await 慢(1500, 2600);
        }
        await 点字("确认付款", "确认付款"); await 慢(2500, 4200); continue;
      }
      if (/确认支付/.test(t)) {
        if (i === 0 && /支付宝/.test(t)) { await 点字("支付宝", "支付宝"); await 慢(1200, 2400); }
        await 点字("确认支付", "确认支付"); await 慢(2500, 4200); continue;
      }
      await 慢(1500, 2600);          // 认不出就再等一拍，别急着撒手
    }
  };

  try {
    // ───── 零之前·先在首页站一会儿（8/14 新加） ─────
    // 今早那趟是「一上来直奔地址簿」：没定位 ＋ 直扑地址页，两个可疑信号叠一块儿。
    // 现在先开首页，等它把「正在获取定位…」化成一个真地址（定位刚喂进去了），再谈别的。
    // 8/16 晨冰美式空一场：首页 15s 没开门（网站/梯子打盹）一击就放弃＝整单白瞎——
    // 像真人一样刷新两回再走：三敲门、一次比一次多等一会儿、敲与敲之间歇口气。
    for (let 敲 = 1; 敲 <= 3; 敲++) {
      try {
        await page.goto("https://h5.ele.me/msite/", { waitUntil: "domcontentloaded", timeout: 15000 + 敲 * 10000 });
        break;
      } catch (e) {
        if (敲 === 3) throw e;
        console.error(`首页第${敲}敲没开门（${String(e).slice(0, 60)}）——歇口气再敲`);
        await 慢(4000, 8000);
      }
    }
    try {
      await page.waitForFunction(
        () => { const t = document.body.innerText || "";
                return t.length > 20 && !/正在获取定位|定位获取失败/.test(t); },
        null, { timeout: 25000 });
    } catch {}
    await 晃();
    await 查验证("首页");
    console.error("首页 → " + (await 文()).split("\n").slice(0, 4).join(" / ").slice(0, 90));
    await 慢();

    // ───── 续付（8/14 十三诊）：订单已经生成、只差最后那一下 ─────
    // 不进店、不加购、不再多生一单——只把待付的那笔付掉（收银台按钮点不动那次留下的）。
    if (A.续付) {
      await page.goto("https://h5.ele.me/order/", { waitUntil: "domcontentloaded" });
      await 睡(3500);
      await 查验证("订单页");
      const 订 = await 文();
      if (!/待支付|去支付|去付款|待付款/.test(订))
        死("续付", "订单页里没有待付的单（多半已经过了 15 分钟自动关了）", { 现场: 订.slice(0, 300) });
      // ⚠️「去支付」要按两回：列表上那颗只把你带进订单详情，详情页里还有一颗才真去收银台
      let 到收银台 = false;
      for (let i = 0; i < 3 && !到收银台; i++) {
        const t = await 文();
        if (/支付宝|微信支付|确认支付/.test(t)) { 到收银台 = true; break; }
        if (!(await 点字("去支付", `去支付(第${i + 1}回)`)) && !(await 点字("去付款", "去付款"))) break;
        await 慢(2500, 4200);
      }
      // ⚠️页面正卡在「加载中…」就被我判死过一次——收银台在路上，等它到
      try {
        await page.waitForFunction(
          () => /支付宝|微信支付|确认支付|支付剩余时间/.test((document.body && document.body.innerText) || ""),
          null, { timeout: 20000 });
      } catch {}
      if (!到收银台 && !/支付宝|微信支付|确认支付/.test(await 文()))
        死("续付", "按了「去支付」还是没到收银台", { 现场: (await 文()).slice(0, 320), 足迹 });
      await 慢(2000, 3500);
      await 查验证("收银台");
      await 收银台();

      const pwd = 口令();
      const 填 = async () => {
        const box = page.locator("input.my-passcode-input-native-input").first();
        if (!(await box.count())) return false;
        if (!pwd) 死("付款", "要支付密码，但 ~/.takeout_pay 里没有口令", { 足迹 });
        await box.pressSequentially(pwd, { delay: 90 + Math.floor(Math.random() * 80) });
        await 慢(3000, 4500);
        return true;
      };
      await 填();
      if (/余额不足|更换其他付款方式/.test(await 文())) {     // 她招行卡余额不足那道墙（8/13 实测）
        await 点字("余额宝", "余额宝"); await 慢(2000, 3200);
        await 点字("确认付款", "确认付款"); await 慢(2500, 4000);
        await 填();
      }
      for (let i = 0; i < 12 && !/支付成功/.test(await 文()); i++) await 睡(1800);
      const 详 = await 文();
      if (!/支付成功/.test(详)) 死("付款", "没等到「支付成功」", { 页面: 详.slice(0, 220), 足迹 });
      try { await 点字("完成", "完成"); } catch {}
      await 慢(3000, 5000);
      const 详2 = await 文();
      账.单 = (账.单 || 0) + 1; 写账(账);
      out({ ok: true, 续付: true, order: (详2.match(/订单号\s*(\d{8,})/) || [])[1] || "",
            paid: 数((详2.match(/实付¥\s*(\d+(?:\.\d+)?)/) || [])[1]),
            eta: (详2.match(/预计\s*(\d{1,2}:\d{2}-\d{1,2}:\d{2})/) || [])[1] || "",
            足迹, 状态: (详2.split("\n")[0] || "").trim() });
    }

    // ───── 零、要送公司就先切收货地址（8/13 夜她点单：明天那杯冰美式送公司） ─────
    // ⚠️别硬编公司坐标——**切了地址让平台自己重定位**，搜出来的店才是那边能送到的。
    //   地址簿里每条地址靠一个关键词认出来（家那条含小区名、公司那条含园区名）：
    //   写在 ~/.takeout/places.json 的 "认" 里，形如 {"认":{"家":"xx小区","公司":"xx园区"}}，或参数 认。
    if (ADDR) {
      const 认表 = Object.assign({}, 地点簿.认 || {}, A.认 || {});
      const 认 = 认表[ADDR] || ADDR;
      await page.goto("https://h5.ele.me/minisite/pages-poi/address/index?bizType=HOME_PAGE&from=mobile.default",
                      { waitUntil: "domcontentloaded" });
      // ⚠️等**列表真渲染出来**再找（8/13 十二诊：只等「收货地址」几个字，列表还没到就说找不到）
      try {
        await page.waitForFunction((k) => (document.body.innerText || "").includes(k), 认, { timeout: 18000 });
      } catch {}
      await 慢();
      await 查验证("地址页");
      const 切了 = await page.evaluate((k) => {
        document.querySelectorAll("[data-addr]").forEach((e) => e.removeAttribute("data-addr"));
        const 行 = [...document.querySelectorAll("*")].filter(
          (e) => e.children.length === 0 && (e.innerText || "").includes(k));
        if (!行.length) return null;
        const t = 行[0];
        (t.closest('[class*="item" i],[class*="card" i],[class*="address" i]') || t).setAttribute("data-addr", "1");
        return (t.innerText || "").trim().slice(0, 60);
      }, 认);
      if (!切了) 死("切地址", `地址簿里没找到「${认}」那条`, { 现场: (await 文()).slice(0, 300) });
      const bx = await page.evaluate(() => {
        const e = document.querySelector("[data-addr='1']"); if (!e) return null;
        const r = e.getBoundingClientRect(); return { x: r.x + Math.min(120, r.width / 2), y: r.y + r.height / 2 };
      });
      if (bx) { await page.mouse.move(bx.x, bx.y, { steps: 5 }); await 睡(200); await page.mouse.click(bx.x, bx.y); }
      await 慢(2500, 4000);
      console.error("切地址 → " + 切了);
    }

    // ───── 一、搜（URL 直接带关键词，省掉 shadow DOM 那道手续） ─────
    const q = encodeURIComponent(SHOP || KW);
    // ⚠️8/13 十诊：切了收货地址还搜出家门口的店——**病根是这条 URL 里硬编的经纬度**
    //   （带了坐标＝平台以坐标为准，刚切的地址白切）。所以：**切过地址就一个坐标都别带**，
    //   让平台自己按账号当前地址定位；没切地址时才用她家那组兜底。
    const 坐标 = (ADDR || !LAT || !LNG) ? "" : `&latitude=${LAT}&longitude=${LNG}${GEO ? "&geohash=" + GEO : ""}`;
    await page.goto(`https://h5.ele.me/minisearch/result?keyword=${q}${坐标}` +
      `&from=mobile.default&refer=%E7%9B%B4%E6%8E%A5%E6%90%9C%E7%B4%A2`, { waitUntil: "domcontentloaded" });
    // ⚠️闪购这页是 Tiga 渲染，骨架先到、货后到——死等秒数没用，得等「起送¥」真出现（8/13 一诊）
    try {
      await page.waitForFunction(() => /起送|配送费|月售|已售/.test(document.body.innerText || ""), null, { timeout: 20000 });   // 8/16：整页免起送时「起送¥」永不出现，别白等20秒
    } catch {}
    await 晃();                    // 搜出来先扫一眼列表，别一出结果就精准点第一家
    await 慢();
    await 查验证("搜索页");
    // 8/17 进门先验票补针：那天登录页是 Tiga 空壳、页面一个字都读不出，光认字的验票没喊出声——
    // 被踹去 /login 的 URL 才是铁证；两样都认，掉门就明说，别再揣着空页面报「没搜到店」害她白饿。
    if (/\/login/.test(page.url()) || /登录|请先登录/.test(await 文())) 死("登录", "淘宝登录态掉了，得让她扫码：把那间 Chrome 带窗打开重新登录");

    // 抓店铺卡：认「起送¥」+「分」的块，取综合排序第一家（她要的是快、稳，不是最便宜）
    // ⚠️别拿卡片首行当店名去点（8/13 二诊：首行常是「商家自配送」「本店近期209人好评」这类角标，
    //   getByText 点上去死等 15 秒）——**给卡片打个 data-pick 再按属性点**，认元素不认文本。
    // ⭐8/15 她的军令「第一家没有就去第二家、第三家，不要拘泥于一家」——进店找菜改成一趟最多走三家。
    //   这儿只备三只手：找店卡（按位/按招牌）、进店（卡身不认手就点菜图·认 URL 不认字）、回搜索；
    //   真正的循环在挑菜那段（要等 读菜/挑名/扫菜单 定义完才轮得到它）。
    // ⭐⭐8/17 影子眼二段（曼玲案终章）：店名住【闭壳】shadowRoot——innerText 瞎、递归钻开壳影子也瞎
    // （深文本里通篇没有「曼玲」二字），六张店卡全被读成配送角标「蜂鸟准时达」。但浏览器内核的
    // 无障碍树（AX）连闭壳都照穿——playwright page.accessibility.snapshot 逐卡取 AX 拼真文本，
    // 店名端端正正在头一段（「曼玲粥店·手工小肉包(xx大学店)」实测）。所以店卡改两段找：
    // 页内先圈卡打 data-sidx（首选这轮真店卡的类名 .mat_shopmode-shop-item，没有再退老筛子），
    // 再逐卡 AX 读真文本；AX 瞎了退回页内深文本（宁可没名也不装死）。下游的 分/起送/店含 全按老样子认。
    const AX文 = async (h) => {
      try {
        const ax = await page.accessibility.snapshot({ root: h, interestingOnly: false });
        const 段 = [];
        const w = (n) => {
          if (!n) return;
          for (const k of ["name", "value"]) { const v = (n[k] == null ? "" : String(n[k])).trim(); if (v) 段.push(v); }
          (n.children || []).forEach(w);
        };
        w(ax);
        return 段.filter((s, i) => s && s !== 段[i - 1]).join(" | ").slice(0, 400);
      } catch { return ""; }
    };
    const 找店卡 = async (位) => {
      const 店含 = A.店含 || "";
      // ⭐8/16 她破的滤镜案：旧筛子「必须带『起送¥』」＝免起送好店全隐身；「分」当身份证、起送只是可选的牌子
      const 抄卡 = () => page.evaluate(() => {
        document.querySelectorAll('[data-pick],[data-sidx]').forEach((e) => { e.removeAttribute('data-pick'); e.removeAttribute('data-sidx'); });
        const 深文 = (root) => {
          const 段 = [];
          // ⭐⭐8/17 曼玲案终章·真凶落网：店名根本不是文本节点，是 TIGA-RICH-TEXT 揣在【属性】里的
          // 富文本 JSON（[{span:"曼玲粥"},{span:"店·手工小肉包(xx大学店)"}]）——闭壳开壳都白钻，
          // 得把这种属性抠开、把里头的 text 拼回一整段（一张卡的名字拼成一个段，店含/招牌才认得囫囵名）。
          const 抠富文本 = (el) => {
            for (const a of (el.attributes || [])) {
              const v = a.value || "";
              if (v[0] === "[" && v.indexOf('"text"') >= 0) {
                try {
                  const 字 = [];
                  const wj = (arr) => (arr || []).forEach((n) => { if (!n) return; if (n.type === "text" && n.text) 字.push(String(n.text)); if (n.children) wj(n.children); });
                  wj(JSON.parse(v));
                  if (字.length) 段.push(字.join(""));
                } catch {}
              }
            }
          };
          const walk = (n) => {
            if (!n) return;
            if (n.nodeType === Node.TEXT_NODE) { const t = (n.textContent || "").trim(); if (t) 段.push(t); return; }
            if (n.nodeType !== Node.ELEMENT_NODE) return;
            抠富文本(n);
            if (n.shadowRoot) walk(n.shadowRoot);
            for (const c of n.childNodes) walk(c);
          };
          walk(root);
          return 段.join(" | ");
        };
        let els = [...document.querySelectorAll('.mat_shopmode-shop-item')];
        if (!els.length) {
          els = [...document.querySelectorAll('[class*="card" i],[class*="item" i]')]
            .map((e) => ({ e, t: 深文(e) }))
            .filter((o) => (/\|\s*分\s*\|/.test(o.t) || /[\d.]\s*\|?\s*分(\s*\||$)/.test(o.t)) && /起送|配送|月售|已售|蜂鸟/.test(o.t) && o.t.length < 400)
            .map((o) => o.e);
        }
        els = els.slice(0, 12);
        els.forEach((e, i) => e.setAttribute('data-sidx', String(i)));
        return els.map((e) => 深文(e).slice(0, 300));
      });
      // 8/16 滚动虚化补针（8/17 抓的现行）：晃过之后 Tiga 会把店卡回收、隔一拍才重渲染——
      // 手快正撞空档＝「附近没搜到店」冤案。空手就等一拍再抄，连空四把才认真没店。
      let 页内 = await 抄卡();
      for (let 试 = 0; 试 < 3 && !页内.length; 试++) { await 睡(900); 页内 = await 抄卡(); }
      if (!页内.length) return null;
      const cards = [];
      for (let i = 0; i < 页内.length; i++) {
        const h = await page.$(`[data-sidx="${i}"]`);
        if (!h) continue;
        let t = await AX文(h);
        if (!/月售|已售|起送|配送|分/.test(t)) t = 页内[i] || t;   // AX 瞎了退深文
        cards.push({ i, t });
        try { await h.dispose(); } catch {}
      }
      if (!cards.length) return null;
      // 8/14：搜商品名时头几家可能是别家品牌——认得出招牌再进门；
      // ⭐8/15 柚见案：她点名了招牌却一家都对不上＝收手报店单，绝不兜底进第一家。
      let c = null;
      if (店含) {
        const 同牌 = cards.filter((o) => o.t.includes(店含));
        if (!同牌.length) return { 没招牌: cards.slice(0, 6).map((o) => o.t.split(" | ")[0].trim().slice(0, 22)) };
        if (位 - 1 >= 同牌.length) return { 到底了: 同牌.length };   // 这块招牌的分店走完了
        c = 同牌[位 - 1];
      } else {
        if (位 - 1 >= cards.length) return { 到底了: cards.length };
        c = cards[位 - 1];
      }
      await page.evaluate((idx) => {
        const e = document.querySelector(`[data-sidx="${idx}"]`);
        if (e) { e.setAttribute('data-pick', '1'); e.scrollIntoView({ block: "center" }); }
      }, c.i);
      // 店名＝评分前那段抓不像招牌时，退一步挑头一个像招牌的段（AX 文本里店名就是头一段）
      const m = c.t.match(/([^|]{2,40})\s*\|\s*[\d.]+\s*\|\s*分/);
      const 角标 = /蜂鸟|准时达|品牌馆|超级吃货|满\d|减\d|折|券|起送|配送|月售|已售|好评|分钟|km|新店|外卖|左滑|营业|自取|开票|红包|食无忧|明厨亮灶|爱心商家|认证/;
      let 名 = (m ? m[1] : "").trim();
      if (!名 || 角标.test(名) || /^[\d.¥+]+$/.test(名)) {
        名 = (c.t.split(" | ").find((p) => p.length >= 4 && !角标.test(p) && !/^[\d.¥+]+$/.test(p)) || c.t.split(" | ")[0]).trim();
      }
      // 起送两种写法都认：「起送¥50」和「¥50起送」（8/16：认不出＝当0＝闸形同虚设）；
      // AX/深文本会把「起送 | ¥ | 20」切开——压平了再认
      const 平 = c.t.replace(/\s*\|\s*/g, "");
      const qi = 平.match(/起送\s*¥\s*(\d+(?:\.\d+)?)/) || 平.match(/¥\s*(\d+(?:\.\d+)?)\s*起送/);
      return { name: 名, 起送: qi ? Number(qi[1]) : 0, 摘要: c.t.slice(0, 160) };
    };

    const 进店 = async (店) => {
      await 慢();
      await 鼠标点('[data-pick="1"]', `店卡（${(店.name || "").slice(0, 14)}）`);
      const 到店 = async () => { try { await page.waitForFunction(() => /ele-takeout-index/.test(location.href), null, { timeout: 12000 }); } catch {} return /ele-takeout-index/.test(page.url()); };
      if (!(await 到店())) {
        // ⚠️8/15 左滑进店案：卡片的体检报告区不认手——点了跟没点一样，还把搜索页错当店铺页
        //   （搜索页也有「月售」，光认字会骗人，所以上面认 URL）。补一脚：点卡里第一张菜缩略图
        //   （价钱数字往上抬 40px 正落在图上）——今天亲手验过的路。
        const 图 = await page.evaluate(() => {
          const el = document.querySelector('[data-pick="1"]');
          if (!el) return null;
          const 叶 = [...el.querySelectorAll("*")].filter((e) => e.children.length === 0 && /^[\d.]{1,6}$/.test((e.innerText || "").trim()));
          const t = 叶[0]; if (!t) return null;
          const r = t.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 - 40 };
        });
        if (图) {
          await page.mouse.move(图.x - 30, 图.y - 25, { steps: 6 });
          await 睡(280 + Math.floor(Math.random() * 200));
          await page.mouse.click(图.x, 图.y);
          足迹.push(`卡身不认手，点了菜图 @${Math.round(图.x)},${Math.round(图.y)}`);
          await 到店();
        }
      }
      if (!/ele-takeout-index/.test(page.url())) return false;
      // ⭐⭐8/17 假门案（她「你重新开个新网页再试一下」一句点醒·当夜手动破的案）：从**搜索页店卡**进来的店堂
      // 是个小柜台——URL 带 menu_extra_info=猜你喜欢／scheme_type=ITEM_STICKY_CATEGORY_SCHEME，
      // 只渲染六样「猜你喜欢」、列表滑不动、左栏分类点不切（八趟白跑、报「整本翻完没这道菜」的真凶）。
      // **正门＝SHOP_SCHEME**（首页「为你推荐」的店卡就是这道门）：拿当前 URL 里的 shopId 重建一条干净的
      // 店铺页地址再 goto，整本菜单（曼玲实测 60+ 样）和左栏分类全在。改门失败就将就着走小柜台，不硬拗。
      try {
        const u0 = page.url();
        if (/menu_extra_info|ITEM_STICKY_CATEGORY_SCHEME/.test(u0)) {
          const 取 = (k) => (u0.match(new RegExp("[?&]" + k + "=([^&]+)")) || [])[1] || "";
          const shopId = 取("shopId"), 前缀 = (u0.match(/^https:\/\/h5\.ele\.me\/[^/]+\/pages\/ele-takeout-index\/ele-takeout-index/) || [])[0];
          if (shopId && 前缀) {
            const 正门 = `${前缀}?shopId=${shopId}&scheme_type=SHOP_SCHEME&type=1&from=mobile.default`
              + (取("brandId") ? `&brandId=${取("brandId")}` : "")
              + (取("geohash") ? `&geohash=${取("geohash")}` : "")
              + (取("latitude") ? `&latitude=${取("latitude")}&longitude=${取("longitude")}` : "");
            await page.goto(正门, { waitUntil: "domcontentloaded" });
            try { await page.waitForFunction(() => /月售|去结算|起送/.test((document.body && document.body.innerText) || ""), null, { timeout: 15000 }); } catch {}
            足迹.push("搜索锚进来的是「猜你喜欢」小柜台，改走 SHOP_SCHEME 正门");
            await 慢();
          }
        }
      } catch {}
      try { await page.waitForFunction(() => /月售|加入购物车|去结算/.test(document.body.innerText || ""), null, { timeout: 15000 }); } catch {}
      await 晃();                    // 进了店先翻两下菜单——人不会一进门就点中那杯
      await 慢();
      await 查验证("店铺页");
      // 店名以店铺页里的为准（搜索卡上抓的常是距离/角标；「左滑进店」这类幌子不算名字）
      const 真名 = await page.evaluate(() => {
        const t = (document.body.innerText || "");
        const m = t.match(/\n([^\n]{2,30}\([^\n]{1,20}店\))\n/) || t.match(/\n([^\n]{2,26}店)\n/);
        return m ? m[1].trim() : "";
      });
      if (真名 && !/左滑|^进店$/.test(真名)) 店.name = 真名;
      return true;
    };

    const 回搜索 = async () => {
      try { await page.goBack({ waitUntil: "domcontentloaded", timeout: 12000 }); } catch {}
      await 慢(2000, 3500);
      if (!/minisearch/.test(page.url())) {
        await page.goto(`https://h5.ele.me/minisearch/result?keyword=${q}${坐标}` +
          `&from=mobile.default&refer=%E7%9B%B4%E6%8E%A5%E6%90%9C%E7%B4%A2`, { waitUntil: "domcontentloaded" });
        try { await page.waitForFunction(() => /起送¥/.test(document.body.innerText || ""), null, { timeout: 20000 }); } catch {}
        await 慢();
      }
    };

    let 店 = { name: "", 起送: 0 };   // 真正定店在挑菜段的三家循环里
    let 店堂URL = "";                 // 8/18：结算前记一笔，dry 收尾回去倒车

    // ───── 二、挑菜（指定就照指定；没指定＝月售高、价钱合适的，凑够起送线） ─────
    const 读菜 = async () => {
    const 菜 = await page.evaluate(() => {
      const 在买过 = (e) => { let p = e; for (let k = 0; k < 7 && p; k++) {
        const c = (p.className || "").toString();
        if (/one-more|bought|recent|history|buy-again|rebuy/i.test(c)) return true;
        const r = p.getBoundingClientRect();
        if (r.height < 600 && /再来一单|再买一单|买过|刚刚搜过/.test(p.innerText || "")) return true;
        p = p.parentElement; } return false; };
      return [...document.querySelectorAll(".menuItem--info")].map((e) => {
        const t = (e.innerText || "").replace(/\n+/g, " ");
        // ⚠️8/14 九诊：卡片有时整块渲染成一行，「苹果茉莉绿点点成分：…古法六窨茉莉绿茶」
        //   全算进菜名——我上一趟就是这么把「六窨」咬到别人家成分表上、点错了品。
        //   名字只认标题元素/第一行，且在「点点成分/月售/好评」处一刀切干净。
        const 标题 = e.querySelector('[class*="name" i],[class*="title" i]');
        const name = (((标题 && 标题.innerText) || (e.innerText || "").split("\n")[0] || "")
                      .split(/点点成分|近期\d|月售|好评|\s{2,}/)[0] || "").trim().slice(0, 24);
        const 原 = (t.match(/¥\s*(\d+)\s*\.?\s*(\d+)?/) || []);
        const 价 = 原[1] ? Number(原[1] + (原[2] ? "." + 原[2] : "")) : NaN;
        const 手 = (t.match(/预估到手\s*¥?\s*(\d+(?:\.\d+)?)/) || t.match(/¥\s*(\d+(?:\.\d+)?)\s*预估到手/) || [])[1];
        const 售 = Number((t.match(/月售\s*(\d+)/) || [])[1] || 0);
        return { name, 价, 到手: 手 ? Number(手) : NaN, 售, 买过: 在买过(e),
                 规格: /选规格/.test(t), 售罄: /售罄|已售完/.test(t), 能加: !!e.querySelector(".btn__plus") };
      }).filter((x) => x.name && !x.售罄 && !x.规格 && x.能加 && isFinite(x.价) && !x.买过);
    });
    // ⚠️咖啡奶茶这类整店都是「选规格」（8/13 实测瑞幸：一个能直接加购的都没有，她最爱的冰美式就卡在这道门）
    // ——所以规格菜也得能点：点开卡片→弹层里每组挑头一个→加入购物车。
    // ⭐这段是 8/13 夜写的，**当晚没敢实测**（风控刚甩过验证，我收手了）；明天白天慢慢喂着验，
    //   验完把真选择器补进来，别信这段注释就当它是准的。
    const 规格菜 = await page.evaluate(() => {
      const 在买过 = (e) => { let p = e; for (let k = 0; k < 7 && p; k++) {
        const c = (p.className || "").toString();
        if (/one-more|bought|recent|history|buy-again|rebuy/i.test(c)) return true;
        const r = p.getBoundingClientRect();
        if (r.height < 600 && /再来一单|再买一单|买过|刚刚搜过/.test(p.innerText || "")) return true;
        p = p.parentElement; } return false; };
      const 老 = [...document.querySelectorAll(".menuItem--info")].map((e, i) => {
        const t = (e.innerText || "").replace(/\n+/g, " ");
        // ⚠️8/14 九诊：卡片有时整块渲染成一行，「苹果茉莉绿点点成分：…古法六窨茉莉绿茶」
        //   全算进菜名——我上一趟就是这么把「六窨」咬到别人家成分表上、点错了品。
        //   名字只认标题元素/第一行，且在「点点成分/月售/好评」处一刀切干净。
        const 标题 = e.querySelector('[class*="name" i],[class*="title" i]');
        const name = (((标题 && 标题.innerText) || (e.innerText || "").split("\n")[0] || "")
                      .split(/点点成分|近期\d|月售|好评|\s{2,}/)[0] || "").trim().slice(0, 24);
        const 价 = Number(((t.match(/¥\s*(\d+)\s*\.?\s*(\d+)?/) || [])[1] || "") +
                          ((t.match(/¥\s*(\d+)\s*\.\s*(\d+)/) || [])[2] ? "." + (t.match(/¥\s*(\d+)\s*\.\s*(\d+)/) || [])[2] : ""));
        const 售 = Number((t.match(/月售\s*(\d+)/) || [])[1] || 0);
        return { i, name, 价, 售, 规格: /选规格/.test(t), 售罄: /售罄|已售完/.test(t), 买过: 在买过(e) };
      }).filter((x) => x.name && x.规格 && !x.售罄 && isFinite(x.价) && !x.买过);
      // ⭐8/15 晨案：瑞幸式真卡另收一遍——标题=.food-name、按钮=btn_select_spec，
      //   买过面板没有 .food-name，所以这一路天生不咬旧账；价钱从最近带 ¥ 的祖上读。
      const 新 = [...document.querySelectorAll(".food-name")].map((e, i) => {
        let p = e.parentElement, t = "";
        for (let k = 0; k < 4 && p; k++) { if (/¥/.test(p.innerText || "")) { t = (p.innerText || "").replace(/\n+/g, " "); break; } p = p.parentElement; }
        const name = (e.innerText || "").trim().slice(0, 24);
        const 价 = Number((t.match(/¥\s*(\d+(?:\.\d+)?)/) || [])[1]);
        const 售 = Number((t.match(/月售\s*(\d+)/) || [])[1] || 0);
        return { i: 1000 + i, name, 价, 售, 规格: /选规格/.test(t), 售罄: /售罄|已售完/.test(t), 买过: 在买过(e) };
      }).filter((x) => x.name && x.规格 && !x.售罄 && isFinite(x.价) && !x.买过);
      // 同名时真卡（新）在前压过旧账（老）——挑名先见着谁就是谁
      return [...新, ...老.filter((y) => !新.some((x) => x.name === y.name))];
    });
    return { 菜, 规格菜 };
    };

    // 左边那一栏分类（8/14 三诊之后抽出来的：找菜、抄菜单两处都用它）
    // ⚠️别把底下那排「首页/订单/我的」认成分类——第一版就是这么点跳出店铺页、整趟当场炸的。
    const 忌 = ["首页", "订单", "我的", "搜索", "购物车", "评价", "商家", "点餐"];
    const 认分类 = (忌) => {
      document.querySelectorAll("[data-cat]").forEach((e) => e.removeAttribute("data-cat"));
      const 见 = new Set(); const 出 = []; const H = innerHeight;
      [...document.querySelectorAll("*")].forEach((e) => {
        if (e.children.length) return;
        const t = (e.innerText || "").trim();
        if (!t || t.length < 2 || t.length > 8 || 见.has(t) || 忌.includes(t)) return;
        if (/^\d|¥|月售|起送|配送/.test(t)) return;
        const r = e.getBoundingClientRect();
        if (r.x > 110 || r.width < 18 || r.width > 120 || r.height < 12 || r.height > 90) return;
        if (r.y < 110 || r.y > H - 150) return;           // 页顶的标题、页底的导航都不要
        见.add(t); e.setAttribute("data-cat", String(出.length));
        出.push({ i: 出.length, t });
      });
      return 出;
    };
    const 读分类 = async () => page.evaluate(认分类, 忌);
    // ⚠️8/14 四诊：抄菜单那趟左栏只认出一个「特价商品」——**是我读得太早/页面正滚在半路**。
    //   先滚回顶上、等它渲染稳了再读；还是太少就往下带一带（懒加载的分类要滚才长出来）。
    const 回顶 = async () => {
      try {
        await page.mouse.move(240, 420, { steps: 4 });
        for (let i = 0; i < 7; i++) { await 滑(-760); await 睡(200); }
        await 睡(900);
      } catch {}
    };
    // ⚠️8/14 八诊：回到顶上反而认不出分类——**页面顶部是店铺头图/优惠区，分类栏在它下面**。
    //   所以不是「回顶就能看见」，而是「从顶上一点点往下滚，滚到它露出来」。
    const 露分类 = async () => {
      await 回顶();
      for (let i = 0; i < 8; i++) {
        const a = await 读分类();
        if (a.length >= 3) { if (i) 足迹.push(`往下带了 ${i} 下才看见左边的分类栏`); return a; }
        await 滑(380 + Math.floor(Math.random() * 240));
        await 睡(600 + Math.floor(Math.random() * 520));
      }
      return await 读分类();
    };
    const 读分类稳 = 露分类;
    // 切了分类之后右边重渲染，data-cat 会被冲掉——按原来的名字重打一遍标记
    const 重标 = async (分类) => page.evaluate(({ names, 忌 }) => {
      document.querySelectorAll("[data-cat]").forEach((e) => e.removeAttribute("data-cat"));
      const H = innerHeight;
      [...document.querySelectorAll("*")].forEach((e) => {
        if (e.children.length) return;
        const t = (e.innerText || "").trim(); const k = names.indexOf(t);
        if (k < 0 || 忌.includes(t)) return;
        const r = e.getBoundingClientRect();
        if (r.x > 110 || r.width < 18 || r.width > 120 || r.y < 110 || r.y > H - 150) return;
        if (!document.querySelector(`[data-cat="${k}"]`)) e.setAttribute("data-cat", String(k));
      });
    }, { names: 分类.map((x) => x.t), 忌 });

    // 切到左栏的某个分类（8/14 七诊）：⚠️**左栏不是 sticky**——页面往下一滚它就跑出视野，
    //   于是第二轮起「按序号点」全落空（足迹里八个分类清一色「这轮没认出来」）。
    //   定法：每回都先滚回顶上 → 重认一遍序号 → 再点；**隔轮的标记一律作废**。
    // ⭐8/17 分类栏正解（当夜手动一枪即中）：**scrollIntoView 把它拉进视野 → getBoundingClientRect 取
    // 【视口】坐标 → 真鼠标点**。从前「点不动」多半是它压根在屏外（露分类只管认得出、不管在不在视野内），
    // 或者拿了文档坐标当屏幕坐标（DOMSnapshot 的 bounds 是文档系，我那天对着天开了一枪）。
    const 拉进视野点字 = async (名) => {
      const p = await page.evaluate((nm) => {
        const el = [...document.querySelectorAll("*")].find((e) => !e.children.length
          && (e.innerText || "").trim() === nm && e.getBoundingClientRect().x < 120);
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        return true;
      }, 名);
      if (!p) return false;
      await 睡(700 + Math.floor(Math.random() * 500));
      const pos = await page.evaluate((nm) => {
        const el = [...document.querySelectorAll("*")].find((e) => !e.children.length
          && (e.innerText || "").trim() === nm && e.getBoundingClientRect().x < 120);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10 || r.y < 40 || r.y > innerHeight - 40) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, 名);
      if (!pos) return false;
      await page.mouse.move(pos.x - 20, pos.y - 12, { steps: 5 });
      await 睡(220 + Math.floor(Math.random() * 200));
      await page.mouse.click(pos.x, pos.y);
      足迹.push(`分类「${名}」拉进视野点了 @${Math.round(pos.x)},${Math.round(pos.y)}`);
      return true;
    };

    const 切分类 = async (名) => {
      const 现 = await 露分类();
      const 目标 = 现.find((x) => x.t === 名);
      if (!目标) {
        // 露分类没认出来不等于没有：拉进视野这条路自己会找（8/17 正解）
        const 旧0 = await 读菜();
        const 旧名0 = [...旧0.菜, ...旧0.规格菜].map((m) => m.name).join("|");
        if (await 拉进视野点字(名)) {
          await 睡(1500 + Math.floor(Math.random() * 1200));
          const r0 = await 读菜();
          if ([...r0.菜, ...r0.规格菜].map((m) => m.name).join("|") !== 旧名0) return r0;
        }
        足迹.push(`分类「${名}」这轮没认出来`); return null;
      }
      const 旧 = await 读菜();
      const 旧名 = [...旧.菜, ...旧.规格菜].map((m) => m.name).join("|");
      if (!(await 拉进视野点字(名)) && !(await 鼠标点(`[data-cat="${目标.i}"]`, `分类「${名}」`))) return null;
      await 睡(1400 + Math.floor(Math.random() * 1300));
      if (!(await page.$(".menuItem--info"))) {          // 点跑偏了就退回来，别把整趟赔进去
        足迹.push(`点「${名}」把页面点跑了 → 退回店铺页`);
        try { await page.goBack({ waitUntil: "domcontentloaded", timeout: 12000 }); } catch {}
        await 睡(2200);
        return null;
      }
      let r = await 读菜();
      // 真鼠标那一下常被上层容器挡住（右边一样都没换）——兜底在元素身上直接 click：
      // 切分类是店内交互，不是下单那种非 isTrusted 不可的手。
      if ([...r.菜, ...r.规格菜].map((m) => m.name).join("|") === 旧名) {
        await page.evaluate((i) => {
          const e = document.querySelector(`[data-cat="${i}"]`);
          if (e) (e.closest("li,[class*='item' i],[class*='category' i],[class*='nav' i]") || e).click();
        }, 目标.i);
        await 睡(1800 + Math.floor(Math.random() * 1200));
        r = await 读菜();
        足迹.push(`分类「${名}」真鼠标没换动，DOM click 兜底 → ${r.菜.length + r.规格菜.length} 样`);
      }
      return r;
    };

    // 从头滚到尾把整本菜单扫一遍（8/14 十诊·这条比点分类可靠得多）：
    // 左栏那个分类点不动（不是 sticky、真鼠标还被上层挡），折腾了五诊；而菜单本身是一条长列表，
    // 老老实实往下滚就全出来了——人找一杯茶也是这么翻的。回调每滚一屏喂一次，谁要用谁自己收。
    // ⭐8/17 正门长菜单案：改走 SHOP_SCHEME 正门后菜单有六十多样，可**手势在这页推不动列表**
    //（dry 实测三家都只读到 1/9/6 样就空转收工，甜粥栏根本没露面）。补一手不靠手势的：
    // 把当前最后一张菜卡 scrollIntoView({block:"end"}) —— 容器真滚、懒加载照样长新卡（手动验过的机制）。
    const 拱一屏 = async () => {
      try {
        return await page.evaluate(() => {
          const cs = [...document.querySelectorAll(".menuItem--info")];
          if (!cs.length) return false;
          cs[cs.length - 1].scrollIntoView({ block: "end" });
          return true;
        });
      } catch { return false; }
    };
    const 扫菜单 = async (每屏) => {
      await 回顶();
      let 空转 = 0;
      for (let i = 0; i < 30 && 空转 < 4; i++) {
        const 新 = await 每屏(await 读菜());
        if (新 === "停") return true;
        空转 = 新 ? 0 : 空转 + 1;
        if (空转 >= 1) {        // 手势没带来新货＝这页不吃手势，改用 scrollIntoView 往下拱
          await 拱一屏();
          await 睡(800 + Math.floor(Math.random() * 600));
        } else {
          try { await page.mouse.move(240, 460 + Math.floor(Math.random() * 140), { steps: 4 }); } catch {}
          await 滑(430 + Math.floor(Math.random() * 260));
          await 睡(700 + Math.floor(Math.random() * 700));    // 一屏一屏看，不是一把刷到底
        }
      }
      return false;
    };

    // 挑名字（8/14 血账：我拿 dish="六窨" 去 includes，咬中的是别人家成分表里那句
    // 「点点成分：藏青盐风味糖浆×古法六窨茉莉奶绿」——**给她点错了品**，还差点付掉）：
    //   ①先认全名相等 ②再认包含 ③她要的是绿茶/纯茶，就先把带「奶」的排除掉
    //   ④同样命中里挑名字最短的（最短的那个通常才是本尊，长的多半是带前缀的联名/套餐）
    // 同音眼镜（8/16 螺蛳粉案：正经柳州粉店九样菜「没见着螺蛳粉」——菜单写的是「螺狮粉」，
    // 她打的也是狮。蛳/狮/丝、粿/果这类满大街乱飞的写法，比对前先归一）
    const 同音 = (s) => (s || "").replace(/\s+/g, "").replace(/[狮蛳鰤]/g, "蛳").replace(/螺丝粉/g, "螺蛳粉").replace(/[粿]/g, "果");
    // ⭐8/23 冰美式案：比对那一截抽成纯函数 挑名核(DISH, list)——挑名先拿原词对，对不上再拿剥掉冰/热/杯型的核对。
    //   另：她说「美式」，瑞幸有 标准美式/小黄油美式/橙C美式/果C美式——按名最短会挑中「果C美式」。
    //   法：挂着「标准/经典/原味/招牌/普通」这类素字头、剥掉字头就等于她说的，排最前；其余再按短。
    const 挑名核 = (DISH, list) => {
      const 素 = (n) => ((n || "").replace(/^(标准|经典|原味|招牌|普通|纯|鲜萃|经典款|原味款)/, "") === DISH ? 0 : 1);
      const 头 = (n) => ((n || "").startsWith(DISH) ? 0 : 1);                       // 她的词打头的优先（生椰拿铁（首创） > 冰吸生椰拿铁）
      const 裸长 = (n) => (n || "").replace(/[（(【\[][^)）】\]]*[)）】\]]/g, "").length;   // 括号里的「（首创）」不算长
      // ⭐8/30 六窨茉莉奶绿案（她要「六窨茉莉绿茶」，我端了「六窨茉莉奶绿」）：散字对账把奶绿当成绿茶的近亲
      //   （六个字重合五个），而旧的「无奶优先」只在有别的选择时才排奶——只剩奶绿一个就照收。
      //   法＝**奶性一致律**：她的词里没「奶」，带奶/乳/拿铁的一律不算候选；她的词里有「奶」，不带的也不算。
      //   在任何一档之前就筛，筛空了各档自然都空、回 null——外面接着翻分类/翻整本/换下一家，绝不将就。
      const 有奶 = (s) => /奶|牛乳|鲜乳|拿铁/.test(s || "");
      const 奶合 = (m) => !!m.name && 有奶(m.name) === 有奶(DISH);
      list = list.filter(奶合);
      const 硬 = list.find((m) => m.name === DISH);
      if (硬) return 硬;
      let c = list.filter((m) => m.name && m.name.includes(DISH));
      if (!c.length && DISH.length > 3) {
        const 核 = DISH.replace(/^(六窨|古法|招牌|经典)/, "");
        c = list.filter((m) => m.name && m.name.includes(核));
      }
      if (!c.length && DISH.length >= 4) {
        // ⚠️8/15 宫保/宫爆案：一字之差不该空手——同长且只差一个字就认（店家错别字比她的嘴多）
        c = list.filter((m) => m.name && m.name.length === DISH.length &&
          [...m.name].filter((ch, i) => ch !== DISH[i]).length <= 1);
      }
      if (!c.length && DISH.length >= 4) {
        // ⚠️8/15 蒜苔案二审三审（她亲眼看它对着「蒜苔肉丝盖饭」掉头走；湘江味道还倒装成「盖饭蒜苔炒肉」）：
        //   散字对账——不论字序，字袋重合 ≥ max(4, 长-1) 且长度差 ≤1 就认：换一个字是近亲，倒个装也是近亲。
        const 打分 = (n) => { const bag = [...DISH]; let 同 = 0; for (const ch of n) { const i = bag.indexOf(ch); if (i >= 0) { 同++; bag.splice(i, 1); } } return 同; };
        c = list.filter((m) => m.name && Math.abs(m.name.length - DISH.length) <= 1 &&
          打分(m.name) >= Math.max(4, DISH.length - 1));
        if (c.length > 1) c = c.sort((x, y) => 打分(y.name) - 打分(x.name) || x.name.length - y.name.length).slice(0, 1);
      }
      if (!c.length && DISH.length >= 3) {
        // ⭐8/18 红枣银耳粥案（她今天点粥三连空的头一桩）：曼玲的菜叫「红枣银耳**枸杞**粥」，
        //   她嘴里是「红枣银耳粥」——中间被店家塞了两个字，includes 不中、同长档不中、
        //   散字对账也因「长度差≤1」把它拒了，123 样菜整本翻完报「没这道菜」。
        //   **插字档**：她说的每个字按原顺序都能在菜名里找着（子序列），菜名最多比她多 3 个字，就认。
        //   （小米粥→小米南瓜粥、牛肉面→牛肉炒面同理；顺序一乱就不认，防的是乱咬。）
        const 子序 = (t, n) => { let i = 0; for (const ch of n) { if (ch === t[i]) i++; if (i === t.length) return true; } return i === t.length; };
        c = list.filter((m) => m.name && m.name.length > DISH.length &&
          m.name.length - DISH.length <= 3 && 子序(DISH, m.name));
      }
      // （8/14 的「无奶优先」已被上面的奶性一致律盖住：那条只在有别的选择时才排奶，8/30 就是这么漏的）
      return c.sort((a, b) => 素(a.name) - 素(b.name) || 头(a.name) - 头(b.name) || 裸长(a.name) - 裸长(b.name) || a.name.length - b.name.length)[0] || null;
    };
    const 挑名 = (list) => {
      if (!DISH) return null;
      const DISHn = 同音(DISH);
      list = list.map((m) => ({ ...m, _rawName: m.name, name: 同音(m.name) }));
      const 兑 = (m) => (m ? { ...m, name: m._rawName } : m);   // 挑完把真名还回去（下游点字认的是屏上原文）
      const 硬0 = list.find((m) => m.name === DISHn);
      if (硬0) return 兑(硬0);
      let 原挑 = 挑名核(DISHn, list);
      const { 核 } = 拆口语(DISH);
      if (核 && 核 !== DISH && (!原挑 || !原挑.name.includes(DISHn))) {
        const 核挑 = 挑名核(同音(核), list);
        if (核挑 && (!原挑 || 核挑.name.includes(同音(核)))) {
          原挑 = 核挑;
          if (!挑名._说过) { 挑名._说过 = true; 足迹.push(`「${DISH}」菜单上没这个名，剥成「${核}」对上了「${原挑._rawName}」`); }
        }
      }
      return 兑(原挑);   // 同音归一只在比对时戴，还给下游的是屏上真名
    };

    // ⭐8/15 她的军令落地（「第一家没有就去第二家，不要拘泥于一家」「特别认死理」——治的就是认死理）：
    //   一趟最多看三家：门推不开＝换下一家；今天进过＝换下一家；整本翻完没这道菜＝换下一家。
    let 菜 = [], 规格菜 = [], 定了 = false, 缩过词 = false;
    const 起始位 = Math.max(1, Number(A.第几 || 1));
    // ⭐8/23 瑞幸「美式家族」案：店堂一次只渲染眼前六张卡，「标准美式」的真卡躺在第九个分类底下；
    //   「买过」面板里那行同名的（带「再来一单」）又不算菜——翻整本之前先看左栏：有分类名沾着她要的词
    //   （美式→美式家族、拿铁→风味拿铁、生椰→生椰家族）就先跳过去找，人也是这么找的。
    //   见菜/见规 是累计的菜单（跳完把分类底下的都并进去）；够了(list) 说什么时候算找着。
    const 跳分类找 = async (见菜, 见规, 够了) => {
      try {
        const 核词 = (拆口语(DISH).核 || DISH);
        const 栏 = await 露分类();
        // 8/23 那家店：「果C美式」和「美式家族」都沾「美式」，先跳的是果C那栏扑了空——排档：
        //   全等 > 去掉「家族/系列/专区」后全等 > 包含 > 沾两个字；头两档都试一遍。
        const 档 = (t) => { const s0 = t.replace(/(家族|系列|专区|专场|专栏|区)$/, "");
          return t === 核词 ? 0 : s0 === 核词 ? 1 : t.includes(核词) ? 2 : ([...核词].filter((ch) => t.includes(ch)).length >= 2 ? 3 : 9); };
        const 沾们 = 栏.filter((x) => 档(x.t) < 9).sort((a, b) => 档(a.t) - 档(b.t)).slice(0, 2);
        if (!沾们.length) { 足迹.push(`左栏没有沾「${核词}」的分类`); return false; }
        for (const 沾 of 沾们) {
          足迹.push(`左栏有「${沾.t}」沾着「${核词}」——先跳过去找`);
          const r = await 切分类(沾.t);
          if (!r) continue;
          r.菜.forEach((m) => m.name && 见菜.set(m.name, m));
          r.规格菜.forEach((m) => m.name && 见规.set(m.name, m));
          for (let k = 0; k < 3 && !够了([...见菜.values(), ...见规.values()]); k++) {   // 分类底下不止一屏就往下拱两三屏
            await 拱一屏(); await 睡(900 + Math.floor(Math.random() * 600));
            const r2 = await 读菜();
            r2.菜.forEach((m) => m.name && 见菜.set(m.name, m));
            r2.规格菜.forEach((m) => m.name && 见规.set(m.name, m));
          }
          const 成 = 够了([...见菜.values(), ...见规.values()]);
          足迹.push(成 ? `在「${沾.t}」底下找见了「${DISH}」` : `「${沾.t}」底下没见着「${DISH}」`);
          if (成) return true;
        }
        return false;
      } catch (e) { 足迹.push("跳分类没跳成：" + String(e && e.message).slice(0, 60)); return false; }
    };
    // 命中算不算「准」：全等、等于剥掉冰/热/杯型的核、或去掉「标准/经典」这类素字头后等于核——才算。
    // 「美式」只对上「橙C美式」是近亲不是准（8/23 演习二就是这么端错的：眼前六张卡里没有标准美式）。
    const 准 = (h) => {
      if (!h) return false;
      // 8/30 顺手：括号里的「（首创）」「(大杯)」不算名字的一部分——「生椰拿铁（首创）」就是「生椰拿铁」本尊
      const n = 同音(h.name).replace(/[（(【\[][^)）】\]]*[)）】\]]/g, ""), d = 同音(DISH), k = 同音(拆口语(DISH).核 || DISH);
      // ⭐8/30：「六窨」「古法」是工艺字头不是菜名——她说「六窨茉莉绿茶」，菜单上的「茉莉绿茶」就是准的
      //   （挑名核早就会剥这个头去对，准() 却不认，害它对上了也当近亲继续翻、最后拿奶绿将就）。
      const 去前 = (x) => (x || "").replace(/^(六窨|七窨|九窨|古法|招牌|经典|手作|鲜萃)/, "");
      return n === d || n === k || n.replace(/^(标准|经典|原味|招牌|普通|纯|鲜萃|经典款|原味款)/, "") === k ||
        去前(n) === 去前(d) || n === 去前(k) || 去前(n) === 去前(k);
    };
    const 本来点了名 = !!DISH;   // 8/23：短词是「试」出来的菜名，每家店进门先还原再试
    for (let 位 = 起始位; 位 < 起始位 + 3; 位++) {
      if (!本来点了名) DISH = "";
      const 卡 = await 找店卡(位);
      if (!卡) {
        // ⚠️8/15 蒜苔炒肉盖饭案：拿全名搜、平台一家店不给就报「没店」＝又一桩认死理——
        //   人搜不到会把词缩短再试（去掉「盖饭/米饭」这类尾巴）。缩一次，还不行才认输。
        if (!缩过词) {
          const 原词 = SHOP || KW || DISH;
          const 短 = 原词.replace(/(盖浇饭|盖饭|米饭|拌饭|炒饭|焖饭|套餐|饭)$/, "").trim();
          if (短 && 短.length >= 2 && 短 !== 原词) {
            缩过词 = true;
            足迹.push(`「${原词}」搜不出店，缩成「${短}」再搜`);
            await page.goto(`https://h5.ele.me/minisearch/result?keyword=${encodeURIComponent(短)}${坐标}` +
              `&from=mobile.default&refer=%E7%9B%B4%E6%8E%A5%E6%90%9C%E7%B4%A2`, { waitUntil: "domcontentloaded" });
            try { await page.waitForFunction(() => /起送¥/.test(document.body.innerText || ""), null, { timeout: 20000 }); } catch {}
            await 慢();
            await 查验证("缩词重搜");
            位--;
            continue;
          }
        }
        死("搜店", `「${SHOP || KW}」附近没搜到能送的店`, { 现场: (await 文()).slice(0, 300) });
      }
      if (卡.没招牌) 死("搜店", `搜「${SHOP || KW}」出来的店里没一家挂着「${A.店含}」的招牌——不硬闯别家门`, { 见到的: 卡.没招牌 });
      if (卡.到底了 != null) { 足迹.push(`店单到底了（共 ${卡.到底了} 家）`); break; }
      店 = 卡;
      // ⭐8/16 她的火（「还是因为你选了一家起送50才给送的💢不选这个就好了」）：
      // 起送线超过她给的预算＝这家永远结不了账，别进门白折腾——门口看一眼牌子就换下一家。
      if (店.起送 > MAX) { 足迹.push(`第${位}家「${店.name}」起送¥${店.起送} 比预算¥${MAX}还高——不进，换下一家`); continue; }
      if (!DRY && (账.店[店.name] || 0) >= 1) { 足迹.push(`第${位}家「${店.name}」今天进过了，换下一家`); continue; }
      if (!(await 进店(店))) { 足迹.push(`第${位}家「${店.name}」门没推开，换下一家`); await 回搜索(); continue; }
      if (!DRY && (账.店[店.name] || 0) >= 1) { 足迹.push(`「${店.name}」（进门认出真名）今天进过了，换下一家`); await 回搜索(); continue; }

      // 抄菜单模式（8/14）：只抄不买、一分不花——抄的是第一家能进的店
      if (A.菜单) {
        const 见过 = new Map();
        await 扫菜单(async (r) => {
          const 前 = 见过.size;
          [...r.菜, ...r.规格菜].forEach((m) => { if (m.name) 见过.set(m.name, `${m.name} ¥${m.价}`); });
          return 见过.size > 前;
        });
        out({ ok: true, 抄菜单: true, shop: 店.name, 菜: [...见过.values()], 足迹 });
      }

      ({ 菜, 规格菜 } = await 读菜());
      // ⭐8/23 冰美式案：短词先当菜名到这家菜单里对一遍——对上了就是她要的；翻完对不上才当品类词挑月售王
      if (!本来点了名 && 短词) { DISH = 短词; 足迹.push(`「${短词}」不够四个字，先当菜名到「${店.name}」菜单里对一遍`); }
      // ⭐8/23 演习二的教训：眼前这几张卡只对上个近亲（「美式」→「橙C美式」）就先别认——跳到沾边的分类底下
      //   看看有没有更准的（「标准美式」），有就把那一片菜单并进来，挑名的素字头排序自然会挑准的那个。
      {
        const h0 = DISH ? 挑名([...菜, ...规格菜]) : null;
        if (h0 && !准(h0)) {
          足迹.push(`眼前只对上个近亲「${h0.name}」，先去沾边的分类底下找更准的`);
          const 见菜 = new Map(), 见规 = new Map();
          菜.forEach((m) => m.name && 见菜.set(m.name, m));
          规格菜.forEach((m) => m.name && 见规.set(m.name, m));
          let 准了 = await 跳分类找(见菜, 见规, (l) => 准(挑名(l)));
          if (!准了) {      // 分类底下没有就翻整本，翻到准的为止（8/23 那家店：跳到「果C美式」扑空，真卡在「美式家族」）
            准了 = await 扫菜单(async (r) => {
              const 前 = 见菜.size + 见规.size;
              r.菜.forEach((m) => m.name && 见菜.set(m.name, m));
              r.规格菜.forEach((m) => m.name && 见规.set(m.name, m));
              if (准(挑名([...见菜.values(), ...见规.values()]))) return "停";
              return 见菜.size + 见规.size > 前;
            });
          }
          菜 = [...见菜.values()]; 规格菜 = [...见规.values()];
          const h1 = 挑名([...菜, ...规格菜]);
          足迹.push(h1 && 准(h1) ? `找着更准的了：「${h1.name}」` : `整本翻完也没更准的，就按「${(h1 || h0).name}」`);
        }
      }
      // ⭐8/14：店铺页菜单是懒加载的——点了名的就往下翻着找，翻到底为止（边滚边留底，一见着就收手；
      //   别点左边分类栏——8/14 十诊拿验证换来的法）。
      if (DISH && !挑名([...菜, ...规格菜])) {
        const 见菜 = new Map(), 见规 = new Map();
        菜.forEach((m) => m.name && 见菜.set(m.name, m));
        规格菜.forEach((m) => m.name && 见规.set(m.name, m));
        let 中 = await 跳分类找(见菜, 见规, (l) => !!挑名(l));
        if (!中) 中 = await 扫菜单(async (r) => {
          const 前 = 见菜.size + 见规.size;
          r.菜.forEach((m) => m.name && 见菜.set(m.name, m));
          r.规格菜.forEach((m) => m.name && 见规.set(m.name, m));
          if (挑名([...见菜.values(), ...见规.values()])) return "停";
          return 见菜.size + 见规.size > 前;
        });
        菜 = [...见菜.values()]; 规格菜 = [...见规.values()];
        await 查验证("翻菜单");
        if (!中) {
          if (!本来点了名) {
            足迹.push(`第${位}家「${店.name}」整本翻完（${菜.length + 规格菜.length} 样）没对上「${DISH}」——当品类词，挑这家月售高的（见着的：${[...菜, ...规格菜].slice(0, 30).map((m) => m.name).join("、")}）`);
            DISH = "";
          } else {
            足迹.push(`第${位}家「${店.name}」整本翻完（${菜.length + 规格菜.length} 样）没见着「${DISH}」，换下一家`);
            await 回搜索();
            continue;
          }
        } else 足迹.push(`第${位}家「${店.name}」滚着找见了「${DISH}」`);
      } else if (DISH && !本来点了名) {
        足迹.push(`短词「${短词}」在「${店.name}」菜单里对上了「${(挑名([...菜, ...规格菜]) || {}).name}」——按这个买，不挑月售王`);
      }
      定了 = true;
      break;
    }
    if (!定了) 死("挑菜", DISH ? `连着看了几家都没见着「${DISH}」——要不换个说法，要不我随便挑` : "一家能进的店都没有", { 足迹 });

    // ⭐8/14 十二诊（她要大杯，我端上来中杯大杯各一）：8/13 六诊说「除非真缺选，一个规格都别动」
    //   ——那条拦的是「乱点」，不是「她点了名的」。她说大杯就得挑大杯：只点她点名的那几个词，
    //   别的一概不碰。⚠️第二杯也得挑一遍（sku 面板每次拉出来都是默认档，不记上一次）。
    const 挑规格 = async () => {
      for (const g of (A.规格 || [])) {
        // ⭐8/23：默认档已经是她要的（「已选：超大杯/冰/…」）就别碰——多点一下只会点歪
        const 已 = ((await 文()).match(/已选[：:]\s*([^\n]{2,80})/) || [])[1] || "";
        if (已 && 已.split(/[\/／、,，\s]+/).includes(g)) { 足迹.push(`规格「${g}」默认已选，不动`); continue; }
        const 严 = 自动规格.has(g);   // 从「冰美式」里剥出来的「冰」：只认规格面板里的字，别咬到页底推荐的「冰吸生椰拿铁」
        const 有 = await page.evaluate(({ g, 严 }) => {
          document.querySelectorAll("[data-opt]").forEach((e) => e.removeAttribute("data-opt"));
          const 叶 = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0);
          let e = 叶.filter((x) => (x.innerText || "").trim() === g).pop();
          if (!e) e = 叶.filter((x) => {                       // 选项常带个加价角标（「大杯 +2」）
            const t = (x.innerText || "").trim();
            return t.startsWith(g) && t.length < g.length + 8;
          }).pop();
          if (!e) return false;
          const 盒 = e.closest("[class*='prop' i],[class*='sku' i],[class*='option' i],[class*='spec' i]");
          if (严 && !盒) return false;
          (盒 || e).setAttribute("data-opt", "1");
          return true;
        }, { g, 严 });
        if (有) { await 鼠标点("[data-opt='1']", `规格「${g}」`); await 慢(900, 2000); }
        else 足迹.push(`规格「${g}」没找着`);
      }
      if ((A.规格 || []).length)
        足迹.push("挑完规格：" + (((await 文()).match(/已选[：:]\s*([^\n]{2,80})/) || [])[1] || "页面没写「已选」"));
    };

    const 加规格菜 = async (m, 份 = 1) => {
      // ⚠️8/14：往下翻过菜单之后卡片索引会漂（懒加载又插进来好几屏）——认名字优先、索引兜底；
      //   而且目标多半已经不在视口里了，先滚到眼前再点，不然真鼠标打的是空坐标。
      await page.evaluate(({ idx, name }) => {
        document.querySelectorAll("[data-spec]").forEach((e) => e.removeAttribute("data-spec"));
        // ⭐8/15 晨案（咖啡空了一早上的病根）：瑞幸这类店的真菜卡**不是** .menuItem--info——
        //   那个类在这种店里穿在「买过/刚刚搜过」面板的旧账身上，按名字一撞就咬到旧账，
        //   点下去＝快捷加购不带规格＝「以下商品无法购买·未选必选品」。
        //   真卡的标题元素＝.food-name（买过面板没有它），先精确对名认它，认不着再走老路。
        const fns = [...document.querySelectorAll(".food-name")];
        const fn = fns.find((e) => (e.innerText || "").trim() === name)
                || fns.find((e) => (e.innerText || "").includes(name));
        const cards = [...document.querySelectorAll(".menuItem--info")];
        const el = fn
                || cards.find((e) => (e.innerText || "").split("\n")[0].trim() === name)
                || cards.find((e) => (e.innerText || "").includes(name)) || cards[idx];
        if (el) { el.setAttribute("data-spec", "1"); el.scrollIntoView({ block: "center" }); }
      }, { idx: m.i, name: m.name });
      await 睡(1300 + Math.floor(Math.random() * 900));
      if (!(await 鼠标点('[data-spec="1"]', `「${m.name}」卡片`))) {
        await page.locator('[data-spec="1"]').first().click();
      }
      // 详情页也是 Tiga 渲染，骨架先到——等那颗真按钮出现，别按秒数猜（8/13 七诊：慢 3 秒还是没开）
      try {
        await page.waitForFunction(
          () => !!document.querySelector(".sku__button") || /加入购物车/.test(document.body.innerText || ""),
          null, { timeout: 15000 });
      } catch {}
      await 慢(1200, 2200);
      await 查验证("商品详情页");
      let 详 = await 文();
      let 开了 = /加入购物车/.test(详);
      足迹.push(`点开「${m.name}」→${开了 ? "商品详情页开了" : "没开"}`);
      if (!开了) {
        // ⚠️8/15 和合谷案：有的店卡标题不认手、图才认——补一脚点卡图再等一回
        const 图 = await page.evaluate(() => {
          const el = document.querySelector('[data-spec="1"]');
          const card = el && (el.closest(".menuItem--info") || el.parentElement);
          const im = card && card.querySelector("img");
          if (!im) return null;
          const r = im.getBoundingClientRect();
          return r.width > 20 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        });
        if (图) {
          await page.mouse.move(图.x - 25, 图.y - 20, { steps: 6 });
          await 睡(300 + Math.floor(Math.random() * 200));
          await page.mouse.click(图.x, 图.y);
          足迹.push("标题不认手，点了卡图");
          try {
            await page.waitForFunction(
              () => !!document.querySelector(".sku__button") || /加入购物车/.test(document.body.innerText || ""),
              null, { timeout: 12000 });
          } catch {}
          await 慢(1200, 2200);
          详 = await 文();
          开了 = /加入购物车/.test(详);
          足迹.push(`再试 →${开了 ? "开了" : "还是没开"}`);
        }
        if (!开了) {
          // ⭐8/16 螺蛳粉八里庄案：卡身、卡图都不应手——这家的卡上有颗「选规格」小钮，那才是正门门铃；
          //   没有「选规格」就摸卡上的加号。第三重后手，再不开才认输。
          const 钮 = await page.evaluate(() => {
            const el = document.querySelector('[data-spec="1"]');
            const card = el && (el.closest(".menuItem--info") || el.closest('[class*="menuItem"]') || (el.parentElement && el.parentElement.parentElement));
            const scope = card || document;
            const b = [...scope.querySelectorAll("div,span,button")].find((e) => (e.textContent || "").trim() === "选规格")
                   || scope.querySelector(".btn__plus,[class*='plus']");
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return (r.width > 8 && r.height > 8) ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
          });
          if (钮) {
            await page.mouse.move(钮.x - 20, 钮.y - 15, { steps: 5 });
            await 睡(280 + Math.floor(Math.random() * 220));
            await page.mouse.click(钮.x, 钮.y);
            足迹.push("卡身卡图都不应手，按了「选规格」小钮");
            try {
              await page.waitForFunction(
                () => !!document.querySelector(".sku__button") || /加入购物车/.test(document.body.innerText || ""),
                null, { timeout: 12000 });
            } catch {}
            await 慢(1200, 2200);
            详 = await 文();
            开了 = /加入购物车|sku/.test(详) || !!(await page.$(".sku__button"));
            足迹.push(`三试 →${开了 ? "开了" : "还是没开"}`);
          }
        }
        if (!开了) { 足迹.push(`「${m.name}」的详情页怎么都打不开，这样没加上`); return false; }
      }
      // ⭐8/13 六诊（这一版之前我栽得最惨的一处）：**规格默认就是选好的**
      //   （详情页顶上那行「已选：超大杯/冰/意式拼配/普通吸管/无奶/不另外加糖/默认浓度」），
      //   压根不需要挑。我上一版拿通用选择器「每组点头一个」，在详情页上乱点了 17 下、
      //   把页面点进了商品评价区，反倒按不着加购。**除非真缺选，一个规格都别动。**
      const 已选 = (详.match(/已选[：:]\s*([^\n]{2,80})/) || [])[1] || "";
      足迹.push("默认规格：" + (已选 || "读不到（页面没写「已选」）"));
      await 慢(1200, 2500);
      // ⚠️8/13 五诊：「选规格」不是弹层，是**整页跳到 `ele-product-detail`**；
      //   真按钮＝`.sku__button`（底部通栏，`getByText` 会咬到外层 wrap）。
      // ⭐8/13 九诊·加购是**两段**，不是一段（我连栽了三版才看明白）：
      //   ①商品详情页底下那颗「+ 加入购物车」只是**把 sku 面板拉出来**；
      //   ②面板出来之后才有真正的下单钮 `.sku__button`（通栏那条），点它才真进车。
      //   两颗都得用**真鼠标打坐标**：它们是一直在动的 Tiga div，playwright 的可点性检查
      //   （stable/visible）永远等不到它们稳下来，locator.click / boundingBox 必超时。
      //   CDP 鼠标事件 isTrusted 天生为真，跟人手点没区别（京东那单也是这么过的）。
      // 第一段：拉出 sku 面板（详情页底部那颗）
      if (!(await page.$(".sku__button"))) {
        await page.evaluate(() => {
          document.querySelectorAll("[data-add]").forEach((e) => e.removeAttribute("data-add"));
          const c = [...document.querySelectorAll("*")].filter(
            (e) => e.children.length === 0 && /加入购物车/.test((e.innerText || "").trim()));
          const t = c[c.length - 1];
          if (t) (t.closest('[class*="btn" i],[class*="button" i]') || t).setAttribute("data-add", "1");
        });
        await 鼠标点("[data-add='1']", "「+ 加入购物车」（拉面板）");
        try {
          await page.waitForFunction(() => !!document.querySelector(".sku__button"), null, { timeout: 12000 });
        } catch {}
        await 慢(1000, 2000);
      }
      // 探针（8/14）：sku 面板到底长什么样，一趟带回来——8/13 写的这段从没实测过，
      // 盲信自己写的注释＝明早再空一次。真结构比我猜的准。
      try {
        const 面板 = await page.evaluate(() => ({
          有面板: !!document.querySelector(".sku__button"),
          件: [...document.querySelectorAll(
            "[class*='sku'] [class*='btn'],[class*='sku'] button,[class*='quantity'],[class*='stepper'],[class*='count'],[class*='num']")]
            .slice(0, 14)
            .map((e) => ((e.className || "").toString().slice(0, 40) + "｜" + (e.innerText || "").trim().slice(0, 12))),
        }));
        足迹.push("sku面板：" + JSON.stringify(面板).slice(0, 420));
      } catch {}

      await 挑规格();

      // 第二段：面板里的真下单钮
      await 鼠标点(".sku__button", "sku 面板的下单钮");
      await 慢(1800, 3000);
      // ⚠️加完必须**退回店铺页**再看车——详情页底下从来没有「去结算」，在这儿找＝自己骗自己（我栽过一次）
      if (/ele-product-detail/.test(page.url())) {
        try { await page.goBack({ waitUntil: "domcontentloaded", timeout: 12000 }); } catch {}
        await 慢(1500, 2800);
      }
      足迹.push("退回后在：" + (page.url().match(/pages\/([\w-]+)/) || [])[1] + "｜车里 " +
                (((await 文()).match(/¥\s*([\d.]+)\s*\n?另需配送费|共(\d+)件/) || [])[0] || "看不出"));
      for (let k = 1; k < 份; k++) await 再来一杯(m);      // 第二杯起
      return true;
    };

    // 第二杯起（8/14 她点两杯茶：一杯不起送）——优先在店铺页那张卡片上点「+」：
    // 加过一次之后卡片会长出步进器，这是最像人的一下（人也不会为第二杯再翻一遍详情页）。
    // 点不着再退回去重走一遍详情页。
    const 再来一杯 = async (m) => {
      await 慢(1500, 3200);
      const 有加号 = await page.evaluate((name) => {
        document.querySelectorAll("[data-more]").forEach((e) => e.removeAttribute("data-more"));
        const cards = [...document.querySelectorAll(".menuItem--info")];
        const card = cards.find((e) => (e.innerText || "").split("\n")[0].trim() === name)
                  || cards.find((e) => (e.innerText || "").includes(name));
        if (!card) return false;
        const p = card.querySelector(".btn__plus") || card.querySelector("[class*='plus'],[class*='add']");
        if (!p) return false;
        p.setAttribute("data-more", "1");
        return true;
      }, m.name);
      if (有加号 && (await 鼠标点("[data-more='1']", "卡片上的「+」（再来一杯）"))) {
        await 慢(1500, 3000);
        // 点了「+」可能直接就加了，也可能又把 sku 面板拉出来——拉出来就把那颗按了
        if (await page.$(".sku__button")) {
          await 挑规格();                      // 第二杯也得挑：面板每次都回默认档
          await 鼠标点(".sku__button", "sku 面板（再来一杯）");
          await 慢(1800, 3000);
          if (/ele-product-detail/.test(page.url())) {
            try { await page.goBack({ waitUntil: "domcontentloaded", timeout: 12000 }); } catch {}
            await 慢(1500, 2800);
          }
        }
        return;
      }
      足迹.push("卡片上没长「+」→ 退回去重走一遍详情页加这一杯");
      await 加规格菜(m, 1);
    };

    if (!菜.length && !规格菜.length) {
      const 全 = await page.evaluate(() => [...document.querySelectorAll(".menuItem--info")].slice(0, 10)
        .map((e) => (e.innerText || "").replace(/\n+/g, " ").slice(0, 60)));
      死("挑菜", `「${店.name}」里没有能加购的菜（都卖完了？）`, { 看到的: 全 });
    }

    let 选 = [], 规格选 = [];
    if (DISH) {
      const hit0 = 挑名([...菜, ...规格菜]);
      const hit = hit0 && !hit0.规格 ? hit0 : null;
      const hit2 = hit0 && hit0.规格 ? hit0 : null;
      if (!hit && !hit2) 死("挑菜", `「${店.name}」没有「${DISH}」`,
        { 有的: [...菜, ...规格菜].slice(0, 40).map((m) => m.name), 足迹 });   // 8/14 从 10 加到 40：
        // 一趟就把整本菜单带回来，省得为了看一眼菜名再进一次店（同店一天一进是拿验证换来的法）
      if (hit) 选 = [hit]; else 规格选 = [hit2];
      // ⭐8/16 螺蛳粉起送案（她亲眼盯出「是起送费不够」并拍板「随便加几个小菜可以吗」→可以）：
      // 点名的菜一样菜不够起送线＝结算钮永远不出生。差多少就从菜单里挑便宜小菜凑：
      // 小菜/蛋/青菜/饮料这类优先、按价从低到高，至多补 3 样、原价总账不越预算太远（同贪心路口径）。
      {
        const 主价 = (hit ? hit.价 : (hit2 ? hit2.价 : 0)) || 0;
        if (店.起送 > 0 && 主价 > 0 && 主价 < 店.起送) {
          const 差 = 店.起送 - 主价;
          const 配 = [...菜].filter((m) => m !== hit && m.价 > 0)
            .sort((a, b) => {
              const sa = /小菜|青菜|生菜|油麦|腐竹|木耳|花生|蛋|豆|鸭|饮|可乐|王老吉|酸奶|凉菜/.test(a.name) ? 0 : 1;
              const sb = /小菜|青菜|生菜|油麦|腐竹|木耳|花生|蛋|豆|鸭|饮|可乐|王老吉|酸奶|凉菜/.test(b.name) ? 0 : 1;
              return sa - sb || a.价 - b.价;
            });
          let 补 = 0;
          for (const m of 配) {
            if (选.length >= 4 || 补 >= 差) break;
            if (主价 + 补 + m.价 > MAX * 1.9) continue;
            if (m.价 > 差 - 补 + 12) continue;   // 8/23 那家店：差¥5 去拿¥33 的特惠套餐凑，荒唐——不够的交给加购后看底栏那一手
            选.push(m); 补 += m.价;
            足迹.push(`凑起送：加「${m.name}」¥${m.价}（还差 ¥${Math.max(0, 差 - 补).toFixed(1)}）`);
          }
          if (补 < 差) 足迹.push(`凑起送：小菜凑不满（差 ¥${(差 - 补).toFixed(1)}），先试着结——结不了她会看见账`);
        }
      }
    } else if (!菜.length) {
      // 整店都要选规格（咖啡奶茶）——挑月售最高的一杯
      规格选 = [[...规格菜].sort((a, b) => b.售 - a.售 || a.价 - b.价)[0]];
    } else {
      // 贪心：月售高的优先，凑到起送线（起送按原价算），别超预算的八成
      // （8/15 曾在这儿绕开过「套餐」，她当场平反：「套餐不用选规格，一点就进车」——拦人的
      //   其实是店规必选小件，那针补在加购后的分诊里；套餐照点不误。）
      const 排 = [...菜].sort((a, b) => b.售 - a.售 || a.价 - b.价);
      let 和 = 0;
      for (const m of 排) {
        if (选.length >= 3) break;
        if (和 >= 店.起送) break;
        if (和 + m.价 > MAX * 1.9) continue;      // 原价可以高些（满减/红包会砍掉一大截）
        选.push(m); 和 += m.价;
      }
      if (!选.length) 选 = [排[0]];
    }

    // 倒空购物车（8/14）：车里混着上一趟留下的别的规格（中杯一杯、大杯一杯）就先倒干净，
    // 别在错的底子上加对的东西——那样只会付出去一笔她没点的钱。
    // ⭐8/23：底栏那一行钱是车里有没有货的唯一实证（面板/对话框的字会躲进影子里，钱躲不了）
    const 读底栏额 = async () => {
      const t = await 文();
      const m = t.slice(-320).match(/¥\s*(\d+(?:\.\d+)?)\s*\n?\s*(?:预估券后价|免配送费|另需配送费|配送费|共优惠)/);
      return m ? Number(m[1]) : NaN;
    };
    const 清车 = async () => {
      const 有 = await page.evaluate(() => {
        document.querySelectorAll("[data-cart]").forEach((e) => e.removeAttribute("data-cart"));
        const H = innerHeight;
        const c = [...document.querySelectorAll("[class*='cart' i],[class*='shopcart' i],[class*='basket' i]")]
          .filter((e) => { const r = e.getBoundingClientRect();
                           return r.width > 22 && r.height > 22 && r.y > H * 0.7; });
        if (!c.length) return false;
        c[0].setAttribute("data-cart", "1"); return true;
      });
      if (!有) {
        // ⚠️8/15：类名认不出就按老地方点——底栏最左那只袋子（今天亲手趟通的坐标）
        const vw0 = await page.evaluate(() => ({ h: innerHeight }));
        const 徽0 = await page.evaluate(() => {   // 8/23：袋子认徽标定位（见撤货那段）
          const e = [...document.querySelectorAll("*")].find((x) => !x.children.length && /^\d+$/.test((x.innerText || "").trim())
            && x.getBoundingClientRect().x < 90 && x.getBoundingClientRect().y > innerHeight * 0.85);
          if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        const q0 = 徽0 ? { x: 徽0.x - 14, y: 徽0.y + 22 } : { x: 47, y: vw0.h - 45 };
        await page.mouse.move(q0.x - 10, q0.y - 10, { steps: 6 });
        await 睡(300 + Math.floor(Math.random() * 200));
        await page.mouse.click(q0.x, q0.y);
        足迹.push(`按坐标点了车图标 @${Math.round(q0.x)},${Math.round(q0.y)}`);
      } else {
        await 鼠标点("[data-cart='1']", "购物车");
      }
      await 慢(1600, 2800);
      const 空 = await page.evaluate(() => {
        document.querySelectorAll("[data-clr]").forEach((e) => e.removeAttribute("data-clr"));
        let e = [...document.querySelectorAll("*")]
          .filter((x) => x.children.length === 0 && /^(清空|清空购物车|全部清空)$/.test((x.innerText || "").trim()))
          .pop();
        // ⚠️8/14：多半根本没有「清空」两个字——是个光秃秃的垃圾桶图标
        if (!e) e = [...document.querySelectorAll(
          "[class*='delete' i],[class*='trash' i],[class*='clear' i],[class*='empty' i],[class*='remove' i]")]
          .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 12 && r.height > 12; }).pop();
        if (!e) return false;
        e.setAttribute("data-clr", "1"); return true;
      });
      if (!空) { 足迹.push("购物车面板里没有「清空」"); return false; }
      await 鼠标点("[data-clr='1']", "清空");
      await 慢(1200, 2200);
      // ⚠️8/15 实测：确认框住在闭壳影子里（DOM/穿透眼/逐帧全瞎），按钮也不叫「确定」叫「清空」——
      //   先礼后兵：getByText 试一把；面板头上的「清空」还赖着＝确认框还开着，按今天量好的比例位
      //   （0.674w, 0.534h＝居中弹窗右边那颗橙钮）拍一掌。
      try { await page.getByText(/^(确定|清空)$/).last().click({ timeout: 2500 }); } catch {}
      await 慢(1200, 2000);
      const 仍开着 = await page.evaluate(() => [...document.querySelectorAll("*")].some(
        (x) => x.children.length === 0 && /^(清空|全部清空)$/.test((x.innerText || "").trim())));
      // ⭐8/23 演习二：点了「清空」之后面板头那个「清空」字也进了影子里、看不见，旧法以为框关了直接报「车倒过了」，
      //   车里其实还躺着上一趟的两杯（结算页 ¥74.7 就是这么来的）。底栏的钱才是证据：还不是 ¥0 就再拍一下确认钮，拍完再验。
      const 读额 = 读底栏额;
      let 额 = await 读额();
      if (仍开着 || 额 > 0) {
        const vw2 = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
        await page.mouse.move(vw2.w * 0.6, vw2.h * 0.5, { steps: 5 });
        await 睡(300 + Math.floor(Math.random() * 200));
        await page.mouse.click(vw2.w * 0.674, vw2.h * 0.534);
        足迹.push(`按比例位拍了确认清空（面板${仍开着 ? "还开着" : "看不见了"}·底栏 ¥${额}）`);
        await 慢(3200, 4800);       // 8/23：拍中了钱也要过两三秒才归零，别早读一眼就冤枉它
        额 = await 读额();
      }
      if (额 > 0) { 足迹.push(`车没倒干净（底栏还是 ¥${额}）`); return false; }
      足迹.push(`车倒过了（底栏 ¥${isNaN(额) ? "?" : 额}）`);
      return true;
    };
    if (A.清车) await 清车();
    // ⭐8/18：`只清车` ＝进店把车倒干净就收工，一样东西都不加（她今天连着两单被自家账房闸
    //   拦下——车里躺着昨夜 dry 演习留下的旧货。清完这一条命令就够，不用赌一趟真单）。
    if (A.只清车) {
      let 倒了 = A.清车 ? true : false;
      if (!A.清车) { try { 倒了 = await 清车(); } catch (e) { 足迹.push("清车没成：" + e.message); } }
      out({ ok: true, 清车: !!倒了, 店: (店 && 店.name) || "", 足迹, note: "只把车倒干净了，没加东西没花钱" });
    }

    // 份数只跟着「点名的那样东西」走（qty）；自动凑单那条路仍是一样一件
    const 份 = DISH ? QTY : 1;
    let 小件加了 = 0;   // 8/15：必选小件（餐具）是脚本自己补的，账房先生要数上它
    let 主菜没加上 = "";  // 8/23：她点名的那样没进车就不许去结算
    // 8/14：东西已经在车里了（上一趟卡在结算页读空），这趟只管结账，别再往车里堆
    if (A.跳加购) 足迹.push("跳过加购：车里本来就有");
    else {
      for (const m of 选) {
        for (let k = 0; k < 份; k++) {
          // ⚠️8/15 宫保鸡丁案（她逮的：「两回都是点两份外卖」）：`:has-text` 会咬到包着好几道菜的
          //   大容器，`.first()` 抓到的加号≠目标菜自己的加号——京酱肉丝就是这么被捎进车的。
          //   正法＝认「标题正好是这道菜」的叶子，往上只认**独门独户**的那行（一行只许一个「月售」），
          //   加号才是它自己的；认不出再退回 has-text 兜底。
          const 妥 = await page.evaluate((name) => {
            document.querySelectorAll("[data-plus]").forEach((e) => e.removeAttribute("data-plus"));
            const 叶 = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && (e.innerText || "").trim() === name);
            for (const t of 叶) {
              let p = t.parentElement;
              for (let k2 = 0; k2 < 6 && p; k2++) {
                const btn = p.querySelector(".btn__plus,[class*='plus' i]");
                if (btn) {
                  const 售 = (p.innerText || "").match(/月售/g);
                  // 8/15 她破的案：「买过/再来一单」面板的行也挂着同名菜——按下去=把整张旧单倒进车
                  if (/再来一单|再买一单|购买过/.test(p.innerText || "")) { p = p.parentElement; continue; }
                  if (!售 || 售.length <= 1) { btn.setAttribute("data-plus", "1"); btn.scrollIntoView({ block: "center" }); return true; }
                }
                p = p.parentElement;
              }
            }
            return false;
          }, m.name);
          await 慢(1000, 1800);
          if (妥 && (await 鼠标点("[data-plus='1']", `「${m.name}」自己的加号`))) { /* 加上了 */ }
          else {
            足迹.push(`「${m.name}」没认出独门加号，退回 has-text 兜底`);
            try { await page.locator(`.menuItem--info:has-text("${m.name}") .btn__plus`).first().click({ timeout: 8000 }); } catch (e2) { 足迹.push("兜底也没点动：" + String(e2.message).slice(0, 50)); }
          }
          await 慢(1200, 2800);
          // ⭐8/17 真进车了没有？看**卡上的份数徽标**（[class*=num] 的数字），别信购物车条那行文案——
          // 它更新慢一拍，我那夜连点两样、条上一直写「1」，其实两样都在车里（差点当没加上又点一遍）。
          try {
            const 读徽标 = () => page.evaluate((name) => {
              const cards = [...document.querySelectorAll(".menuItem--info")];
              const c = cards.find((e) => (e.innerText || "").split("\n")[0].trim() === name)
                     || cards.find((e) => (e.innerText || "").includes(name));
              if (!c) return -1;
              const n = [...c.querySelectorAll("*")].filter((x) => !x.children.length
                && /^\d+$/.test((x.innerText || "").trim())
                && x.className && /num/i.test(x.className.toString()));
              return n.length ? Number(n[0].innerText.trim()) : 0;
            }, m.name);
            // 徽标也会慢一拍（8/17 dry 实测：银耳粥明明进了车、这儿读出 0，结算页两样都在）
            // ——等两拍再定论，且**只记账不拦路**（真没加上有结算页的份数核对兜着）
            let 份数 = await 读徽标();
            for (let 补 = 0; 补 < 2 && 份数 === 0; 补++) { await 睡(1200); 份数 = await 读徽标(); }
            足迹.push(`「${m.name}」卡上份数徽标＝${份数}`);
          } catch {}
        }
      }
      // ⭐8/15 她的眼睛平反了套餐案（「咪看这个套餐不需要选规格，直接点一下就进购物车了」）：
      //   「未选必选品」多半是**店规**——店里有「必选商品」栏（餐盒/打包盒那类一两块的小件），
      //   车里不带它结算钮就不亮。先补小件；实在补不上再走清车+详情页的老路。
      if (选.length && /未选必选品/.test(await 文())) {
        // ⭐8/15 晚·手验过的捷径（晨曦炖汤案）：按一下「未选必选品」那颗钮，菜单自己跳到必选栏
        //   （「餐具自选」），¥0 的「需要餐具」就在眼前——比满菜单扫快十倍，先走这条。
        足迹.push("撞上「未选必选品」——按钮跳必选栏补小件");
        const 必选钮 = await page.evaluate(() => {
          const c = [...document.querySelectorAll("*")].filter((e) => !e.children.length && (e.innerText || "").trim() === "未选必选品");
          const el = c[0]; if (!el) return null;
          const r = el.getBoundingClientRect();
          return r.width > 20 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        });
        if (必选钮) {
          await page.mouse.move(必选钮.x - 25, 必选钮.y - 18, { steps: 5 });
          await 睡(300 + Math.floor(Math.random() * 200));
          await page.mouse.click(必选钮.x, 必选钮.y);
          足迹.push("按了「未选必选品」钮");
          await 慢(2500, 4200);
        }
        const 加小件 = async (m) => {
          const 妥2 = await page.evaluate((name) => {
            document.querySelectorAll("[data-plus]").forEach((e) => e.removeAttribute("data-plus"));
            const 叶 = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && (e.innerText || "").trim() === name);
            for (const t of 叶) {
              let p = t.parentElement;
              for (let k2 = 0; k2 < 6 && p; k2++) {
                const btn = p.querySelector(".btn__plus,[class*='plus' i]");
                if (btn) {
                  const 售 = (p.innerText || "").match(/月售/g);
                  // 8/15 她破的案：「买过/再来一单」面板的行也挂着同名菜——按下去=把整张旧单倒进车
                  if (/再来一单|再买一单|购买过/.test(p.innerText || "")) { p = p.parentElement; continue; }
                  if (!售 || 售.length <= 1) { btn.setAttribute("data-plus", "1"); btn.scrollIntoView({ block: "center" }); return true; }
                }
                p = p.parentElement;
              }
            }
            return false;
          }, m.name);
          await 慢(1000, 1800);
          return 妥2 && (await 鼠标点("[data-plus='1']", `必选小件「${m.name}」的加号`));
        };
        const 认小件 = (list) => list.filter((m) => /餐盒|打包|餐具|必选|必点/.test(m.name || "")).sort((a, b) => (a.价 || 9) - (b.价 || 9))[0];
        // 跳完栏先点名「需要餐具」（她的默认·¥0），认不着再走通配
        if (await 加小件({ name: "需要餐具" })) { 小件加了++; await 慢(1500, 2500); }
        let 小件 = /未选必选品/.test(await 文()) ? 认小件([...菜, ...规格菜]) : null;
        if (!小件 && /未选必选品/.test(await 文())) {
          // 首屏没有——滚着找一遍（必选栏常在菜单深处）
          const 见 = new Map();
          await 扫菜单(async (r) => {
            [...r.菜, ...r.规格菜].forEach((m) => m.name && 见.set(m.name, m));
            return !认小件([...见.values()]) && 见.size > 0;
          });
          小件 = 认小件([...见.values()]);
        }
        if (小件) { if (await 加小件(小件)) 小件加了++; await 慢(1500, 2500); }
        if (/未选必选品/.test(await 文())) {
          足迹.push("必选小件没补上——清车重来，改走详情页（老路）");
          await 清车();
          await 慢(1500, 2500);
          for (const m of 选) await 加规格菜(m, 份);
        }
      }
      for (const [idx, m] of 规格选.entries()) {
        const 成 = await 加规格菜(m, 份);
        if (!成 && DISH && idx === 0) 主菜没加上 = m.name;   // 8/23 那家店：「柚C 美式」没开详情页，旧法照样去结算，差点替她付了杯没点的特惠套餐
      }
    }
    await 慢();
    await 查验证("加购后");

    // ───── 三、结算（钱的闸在这一步，订单还没生成） ─────
    // 先确认东西真进了购物车（8/13 三诊：规格弹层没点上时，「去结算」根本不存在，死等 15 秒才报错）
    // ⚠️结算按钮的文案各店不一样（8/13：糕幸写「去结算」、瑞幸写「选好了」；京东那边还见过「领券结算 (1)」）
    //   ——**别拿死文本认它**，认「结算/选好了/下单」这一族，认不出就把车底原样带回来看。
    const 结按钮 = /去结算|选好了|结算|去下单|立即下单/;
    店堂URL = page.url();   // ⭐8/18：dry 收尾要回这道门清车（结算页上没有购物车面板）
    // ⭐8/18 她今天点粥连着空手的滚雪球病根：账房闸拦下时**只停手不收摊**，我这趟加的两样
    //   原样留在车里，下一单的账更对不上，越滚越脏。可整车清空又会误删她自己存的东西——
    //   正法＝**我自己加的我自己撤**：回店堂，对我碰过的每样点减号点到那颗钮自己消失。
    const 撤货 = async () => {
      const 我加的 = [...选, ...规格选].filter(Boolean);
      if (!我加的.length) return false;
      try {
        if (店堂URL && !/ele-takeout-index/.test(page.url())) {
          await page.goto(店堂URL, { waitUntil: "domcontentloaded" });
          await 慢(2500, 4000);
        }
      } catch {}
      // ⭐8/23 演习二血账：咖啡奶茶这类规格菜的卡上**没有减号**（只有份数徽标），旧法在卡上找不着减号就 break、
      //   还照报「都撤回去了」——三杯生椰拿铁就这么留在她车里，下一趟结算页 ¥74.7。
      //   正法＝打开底栏的购物车面板，按行名找**那一行**的减号，按到那行消失；她自己存的行一根指头不碰；
      //   最后拿底栏的钱对账，说话算数。
      // ⚠️8/23 那家店：[class*=cart] 咬中的是右边一个推销件（454,714），点下去开的是商品详情页——袋子不认类名，
      //   认**徽标**：底栏左下那个数字徽标右上角挂在袋子上，袋心＝徽标左下 (−14, +22)；没徽标就按 (47, H−45)/(49, H−62) 轮着试。
      const 开着 = () => page.evaluate(() => [...document.querySelectorAll("*")].some(
        (x) => !x.children.length && /^(已选商品|清空购物车)$/.test((x.innerText || "").trim())));
      const 开面板 = async () => {
        if (await 开着()) return true;
        const vw = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
        const 徽 = await page.evaluate(() => {
          const e = [...document.querySelectorAll("*")].find((x) => !x.children.length && /^\d+$/.test((x.innerText || "").trim())
            && x.getBoundingClientRect().x < 90 && x.getBoundingClientRect().y > innerHeight * 0.85);
          if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        const 试 = [徽 ? { x: 徽.x - 14, y: 徽.y + 22 } : null, { x: 47, y: vw.h - 45 }, { x: 49, y: vw.h - 62 }].filter(Boolean);
        for (const q of 试) {
          await page.mouse.move(q.x - 10, q.y - 10, { steps: 5 }); await 睡(300 + Math.floor(Math.random() * 200));
          await page.mouse.click(q.x, q.y); await 慢(1600, 2600);
          await 查验证("购物车面板");
          if (await 开着()) { 足迹.push(`购物车面板开了 @${Math.round(q.x)},${Math.round(q.y)}`); return true; }
        }
        return false;
      };
      const 行在 = (name) => page.evaluate((name) => [...document.querySelectorAll("*")].some(
        (e) => !e.children.length && (e.innerText || "").trim() === name && e.getBoundingClientRect().y > innerHeight * 0.3), name);
      const 标减 = (name) => page.evaluate((name) => {
        document.querySelectorAll("[data-minus]").forEach((e) => e.removeAttribute("data-minus"));
        const 叶 = [...document.querySelectorAll("*")].filter(
          (e) => e.children.length === 0 && (e.innerText || "").trim() === name);
        const 候 = [];
        for (const t of 叶) {
          let p = t.parentElement;
          for (let k2 = 0; k2 < 6 && p; k2++) {
            if (/再来一单|再买一单|购买过|买过/.test(p.innerText || "")) { p = p.parentElement; continue; }
            const pr = p.getBoundingClientRect();
            if (pr.height > 320) break;                    // 走到整个面板/整页了，别再往上
            // ⚠️8/16 血账：[class*=minus] 会咬中「shop-minus-num-plus」整条容器，点它中心＝按了加号。只认小小的那颗真钮。
            const 钮 = [...p.querySelectorAll(".btn__minus,[class*='minus' i]")].find((b) => {
              const c = (b.className || "").toString();
              if (/plus|row|mask/i.test(c) && !/btn__minus$/.test(c.trim())) { if (/plus/i.test(c)) return false; }
              const r = b.getBoundingClientRect();
              return r.width > 8 && r.width < 60 && r.height > 8 && r.height < 60 && (b.innerText || "").trim().length <= 1;
            });
            if (钮) { const r = 钮.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                      候.push({ 钮, 露: !!(top && (top === 钮 || 钮.contains(top) || top.contains(钮))) }); break; }
            p = p.parentElement;
          }
        }
        const pick = 候.find((c) => c.露) || 候[0];
        if (!pick) return false;
        pick.钮.setAttribute("data-minus", "1"); pick.钮.scrollIntoView({ block: "center" }); return true;
      }, name);
      const 额前 = await 读底栏额();
      if (!(await 开面板())) { 足迹.push(`购物车面板没打开，撤不了货（底栏 ¥${额前}）`); return false; }
      let 净 = true;
      for (const m of 我加的) {
        let 按 = 0;
        for (let k = 0; k < 份 + 3; k++) {
          if (!(await 行在(m.name))) break;          // 那一行没了＝撤干净了
          if (!(await 标减(m.name))) break;
          await 慢(900, 1700);
          if (!(await 鼠标点("[data-minus='1']", `面板里「${m.name}」的减号`))) break;
          按++;
          await 慢(1200, 2000);
        }
        if (await 行在(m.name)) { 净 = false; 足迹.push(`「${m.name}」按了 ${按} 下减号，行还在`); }
      }
      await 慢(1500, 2500);
      const 额 = await 读底栏额();
      足迹.push(净 ? `我这趟加的都撤回去了（底栏 ¥${额前} → ¥${额}；她原先车里的东西一样没动）`
                  : `有几样撤不回去，车里还留着我加的（底栏 ¥${额前} → ¥${额}）`);
      // 面板还开着就再点一下袋子收起来（车空了它多半自己关）
      try {
        const 开着 = await page.evaluate(() => [...document.querySelectorAll("*")].some(
          (x) => !x.children.length && /^(已选商品)$/.test((x.innerText || "").trim())));
        if (开着) { const H3 = await page.evaluate(() => innerHeight); await page.mouse.click(49, H3 - 62); await 睡(900); }
      } catch {}
      return 净;
    };
    if (主菜没加上) { await 撤货(); 死("加购", `她点名的「${主菜没加上}」没加进车（详情页打不开），别的我也撤了，没去结算`); }
    let 车 = await 文();
    // ⭐8/23 冰美式案：瑞幸的起送线按到手价算（标价¥13的美式到手¥9.9，起送¥20），东西明明进了车，
    //   底栏那颗钮写的是「差¥10.1起送」而不是「选好了」——旧法一看没有结算字样就报「没进车」，冤。
    //   法：底栏说「差¥X起送」＝车里有货、差起送线 → 从菜单里挑一样便宜的凑上去（一样够就挑最便宜的够数那样；
    //   最多两样、不越预算），凑完再看钮；钮写「¥20起送」且车还是 ¥0 才是真没进车。
    const 读差 = (t) => { const m = (t || "").slice(-500).match(/(?:还差|差)\s*¥?\s*(\d+(?:\.\d+)?)\s*(?:元)?\s*(?:起送|配送|可配送)/); return m ? Number(m[1]) : 0; };
    if (!结按钮.test(车) && 读差(车) > 0 && !A.跳加购) {
      const 已加 = new Set([...选, ...规格选].filter(Boolean).map((m) => m.name));
      let 花 = [...选, ...规格选].filter(Boolean).reduce((a, m) => a + (m.价 || 0), 0);
      for (let 轮 = 0; 轮 < 2; 轮++) {
        const 差 = 读差(车);
        if (差 <= 0) break;
        const 候 = [...菜, ...规格菜].filter((m) => m.name && m.价 > 0 && !已加.has(m.name) && 花 + m.价 <= MAX * 1.9);
        const 够 = 候.filter((m) => m.价 >= 差).sort((a, b) => a.价 - b.价)[0];
        const m = 够 || 候.sort((a, b) => b.价 - a.价)[0];
        if (!m) { 足迹.push(`凑起送：底栏说还差 ¥${差}，菜单里挑不出合适的凑头`); break; }
        足迹.push(`凑起送：底栏说还差 ¥${差}，加「${m.name}」¥${m.价} 凑上去`);
        已加.add(m.name); 花 += m.价;
        if (m.规格) 规格选.push(m); else 选.push(m);
        await 加规格菜(m, 1);      // 详情页那条路两种卡都走得通（8/15 必选品安全网就是这么补的）
        await 慢(1500, 2800);
        await 查验证("凑起送");
        车 = await 文();
      }
    }
    if (!结按钮.test(车)) {
      await 撤货();   // 8/23：万一进了车只是钮的字我不认得，收场前把自己加的撤回去，别坑下一单
      死("加购", "东西没真进购物车（底下找不到结算那颗扣子）",
         { 足迹, 想加: [...选, ...规格选].filter(Boolean).map((m) => m.name), 车底: 车.slice(-260) });
    }
    // ⚠️8/13 十三诊：`getByText(...).last()` 会咬到「拼单」那个 span——
    //   结算钮永远在**页面最底下那条通栏**，按位置认它，再用真鼠标点。
    await page.evaluate(() => {
      document.querySelectorAll("[data-settle]").forEach((e) => e.removeAttribute("data-settle"));
      const H = innerHeight;
      const c = [...document.querySelectorAll("*")].filter((e) => {
        const t = (e.innerText || "").trim();
        if (!/^(去结算|选好了|结算|去下单|立即下单)/.test(t) || t.length > 12) return false;
        const r = e.getBoundingClientRect();
        return r.width > 40 && r.height > 20 && r.y > H * 0.7;
      });
      const t = c[c.length - 1];
      if (t) t.setAttribute("data-settle", "1");
    });
    if (!(await 鼠标点("[data-settle='1']", "结算钮"))) {
      await page.getByText(结按钮).last().click({ force: true });
    }
    // ⚠️8/14 十一诊：点完结算钮就去读，读了个空字符串——结算页还在路上（Tiga 又是骨架先到）。
    //   于是「份数核对」看见 0 杯、把我自己拦下了（拦得对：宁可空手也不能糊涂付）。等它真出来。
    await 慢(3000, 5000);
    try {
      await page.waitForFunction(
        () => { const t = (document.body && document.body.innerText) || ""; return t.length > 40 && /合计|实付|支付|提交订单/.test(t); },
        null, { timeout: 20000 });
    } catch {}
    await 慢(1500, 3000);
    let 结文 = await 文();
    if (/起送/.test(结文) && /还差/.test(结文)) {
      await 撤货();   // 8/18：凑不够起送就收摊，别把菜留在车里坑下一单
      死("结算", "没够起送价（我加的已撤回）", { 摘: 结文.slice(0, 120), 足迹 });
    }

    // 地址若还挂着「请确认」，必须先点「使用」——不点的话「立即支付」按了没反应（8/13 实测）
    if (/请选择收货地址|请确认/.test(结文)) {
      try { await page.getByText("使用", { exact: true }).first().click({ timeout: 4000 }); await 慢(2000, 3500); } catch {}
      结文 = await 文();
    }

    // ⚠️购物车是账号级的，可能躺着**别的时候加的旧货**（8/13 我调试时就在车里留了两件）——
    //   结算页按「× N」数一遍，比我这一趟加的还多就停手，别替她买上不知情的东西。
    // ⚠️只在「商品明细」那一段数（8/13 十一诊：底部推销的「60元超级吃货卡 ×12张」被我数成了商品）
    const 明细 = 结文.slice(0, (结文.indexOf("打包费") + 1) || 结文.length);
    const 车件 = (明细.match(/×\s*\d+/g) || []).length;
    // 8/15 晚：必选小件（餐具那类）是它自己补的，账房先生得数上——不然这类店永远「账对不上」
    const 该有 = [...选, ...规格选].filter(Boolean).length + (小件加了 || 0);
    if (车件 > 该有) {
      const 撤净 = await 撤货();   // 8/18：停手之前先把自己加的收回去，别给下一单留脏车
      死("车里有旧货", `结算页有 ${车件} 样，我这趟只加了 ${该有} 样——车里躺着我不知道的东西，没敢替她付。` +
         (撤净 ? "我加的那几样已经撤回去了，她把车清干净再喊我。" : "⚠️我加的那几样没撤利索，车得清一下。"),
         { 足迹, 结算页: 结文.slice(0, 300) });
    }
    if (车件 < 该有) {   // 8/23：少了也不付——我要加的没全进车，付了就是买错
      await 撤货();
      死("加购", `结算页只有 ${车件} 样，我要加的 ${该有} 样没全进车——没敢付（我加的已撤回）`, { 足迹, 结算页: 结文.slice(0, 300) });
    }
    // 份数核对（8/14 她点两杯：一杯不起送）——车里只有一杯就是第二杯没加上，别蒙混着付掉
    if (份 > 1) {
      const 份数 = Math.max(0, ...(明细.match(/×\s*(\d+)/g) || []).map((s) => Number(s.replace(/\D/g, ""))));
      if (份数 !== 份) {
        await 撤货();
        死("份数", `她要 ${份} 杯，结算页是 ${份数} 杯——没敢就这么付（我加的已撤回）`,
           { 足迹, 结算页: 结文.slice(0, 320) });
      }
    }
    // ⚠️「合计」的写法各店不一样（8/13：糕幸＝「合计¥33.6」一行；瑞幸＝「合计／已优惠 ¥17.5／¥16.5」三行）
    //   ——先认一行式，再认三行式（跳过「已优惠」那个数），都不中才认「合计」后面第一个价。
    const 尾 = 结文.slice(Math.max(0, 结文.lastIndexOf("合计")));
    const 合计 = 数(
      (结文.match(/合计¥\s*(\d+(?:\.\d+)?)/) || [])[1] ??
      (尾.match(/已优惠\s*¥\s*[\d.]+[\s\S]{0,12}?¥\s*(\d+(?:\.\d+)?)/) || [])[1] ??
      (尾.match(/¥\s*(\d+(?:\.\d+)?)/) || [])[1]);
    const eta = (结文.match(/预计\s*(\d{1,2}:\d{2}-\d{1,2}:\d{2})\s*送达/) || [])[1] || "";
    const 全选 = [...选, ...规格选].filter(Boolean);
    const 单子 = { shop: 店.name, items: 全选.map((m) => m.name), amount: 合计, eta };
    if (!isFinite(合计)) { await 撤货(); 死("结算", "读不出合计金额，没敢往下走（我加的已撤回）", { ...单子, 结算页: 结文.slice(0, 420) }); }
    if (合计 > MAX) { await 撤货(); 死("超额", `合计¥${合计} 超过上限¥${MAX}，一分没花（我加的已撤回），等她点头`, 单子); }   // 8/23：别把东西留在她车里
    if (DRY) {
      // ⭐8/18 铁律：**演习不许留脏车**。8/17 夜那趟 dry 走到结算页停手，红枣银耳枸杞粥＋
      //   青菜瘦肉粥就一直躺在曼玲的车里；今早她真要粥，账房先生一数「结算页 3 样、我只加了 2 样」
      //   当场停手——一趟 dry 害她连着两单点不成。收工前自己把车倒干净。
      //   ⚠️8/18 头一版栽在这儿：人还站在**结算页**上，底栏那只袋子根本不在这页——
      //   「购物车面板里没有清空」，车原样留着。正法＝先照来路退回店堂，再倒车。
      let 倒了 = false;
      try {
        if (店堂URL) { await page.goto(店堂URL, { waitUntil: "domcontentloaded" }); await 慢(2500, 4000); }
        else { await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {}); await 慢(2500, 4000); }
        倒了 = await 撤货();        // 8/23：只撤我加的；整车清空会把她自己存的也倒掉（今早真倒掉过一杯），那只手只许她喊「只清车」时用
      } catch (e) { 足迹.push("dry 收尾撤货没成：" + e.message); }
      const 余 = await 读底栏额();
      out({ ok: true, dry: true, ...单子, 份, 足迹, 收尾清车: !!倒了, 底栏: 余,
            note: 倒了 ? `试运行：走到结算页就停了，没下单没花钱，我加的已撤回（底栏 ¥${余}）`
                       : `试运行：走到结算页就停了，没下单没花钱——⚠️我加的没撤干净（底栏 ¥${余}），下一单会被账房闸拦，喊我 只清车` });
    }

    // ───── 四、下单＋付款 ─────
    await 慢();
    // ⚠️8/15 宫保鸡丁案：这颗提交钮也是 Tiga 活件——locator.click 的可点性检查在有些店永远等不到稳
    //   （15s 白等直接炸），跟其他按钮一个家法：打标记＋真鼠标；没打着再退回 locator 短兜底。
    await page.evaluate(() => {
      document.querySelectorAll("[data-pay-go]").forEach((e) => e.removeAttribute("data-pay-go"));
      const e = document.querySelector(".submit-btn__button");
      if (e) { e.setAttribute("data-pay-go", "1"); e.scrollIntoView({ block: "center" }); }
    });
    if (!(await 鼠标点('[data-pay-go="1"]', "结算页提交钮"))) {
      try { await page.locator(".submit-btn__button").first().click({ timeout: 8000 }); } catch (e) { 足迹.push("提交钮兜底也没按动：" + String(e.message).slice(0, 60)); }
    }
    await 慢(3500, 5500);
    await 查验证("收银台");
    await 收银台();

    const pwd = 口令();
    const 填密码 = async () => {
      const box = page.locator("input.my-passcode-input-native-input").first();
      if (!(await box.count())) return false;
      if (!pwd) 死("付款", "要支付密码，但 ~/.takeout_pay 里没有口令", 单子);
      await box.pressSequentially(pwd, { delay: 90 + Math.floor(Math.random()*80) });
      await 慢(3000, 4500);
      return true;
    };
    await 填密码();

    // 招行卡余额不足那道墙（8/13、8/17 两次实测）：改走余额宝
    // ⭐8/17 手动实录：撞墙后页面**当场把方式列表摊开**（余额宝 可用¥3677 就在里头），
    // 点它→再「确认付款」→**还要再敲一遍口令**才算完；这里用真鼠标点字（getByText 在 Tiga 活件上时灵时不灵）。
    if (/余额不足|更换其他付款方式/.test(await 文())) {
      try {
        足迹.push("招行卡余额不足 → 切余额宝重付");
        if (!(await 点字("余额宝", "余额宝"))) {
          await page.getByText("余额宝", { exact: false }).first().click({ timeout: 5000 });
        }
        await 慢(2000, 3200);
        if (!(await 点字("确认付款", "确认付款（余额宝）"))) {
          await page.getByText("确认付款", { exact: false }).first().click();
        }
        await 慢(2500, 4000);
        await 填密码();
      } catch (e) { 死("付款", "卡里余额不足，切余额宝也没成：" + e.message, 单子); }
    }

    for (let i = 0; i < 10 && !/支付成功/.test(await 文()); i++) await 睡(1800);
    if (!/支付成功/.test(await 文())) 死("付款", "没等到「支付成功」", { ...单子, 页面: (await 文()).slice(0, 160) });

    try { await page.getByText("完成", { exact: true }).first().click({ timeout: 5000 }); } catch {}
    await 慢(4000, 6000);
    const 详 = await 文();
    const 单号 = (详.match(/订单号\s*(\d{8,})/) || [])[1] || (page.url().match(/eosOrderId=(\d+)/) || [])[1] || "";
    const 实付 = 数((详.match(/实付¥\s*(\d+(?:\.\d+)?)/) || [])[1]);
    const eta2 = (详.match(/预计\s*(\d{1,2}:\d{2}-\d{1,2}:\d{2})/) || [])[1] || eta;

    // 仪式感那张（8/13 夜她点单：「点完记得发截图给咪呀！有仪式感一点呀！」）——
    // 订单详情页拍一张，落进脚本旁的 截图/，把路径带回去（怎么推给她，留给你自己的后端）。
    let shot = "";
    try {
      const buf = await page.screenshot({ type: "png" });
      const dir = path.join(__dirname, "截图");
      const name = crypto.createHash("sha1").update(buf).digest("hex") + ".png";
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), buf);
      shot = path.join(dir, name);
    } catch (e) { /* 拍不着就算了，别为一张图把这单搅黄 */ }

    // 记账（一天一单、同店一天一进的依据）
    账.单 = (账.单 || 0) + 1;
    账.店[店.name] = (账.店[店.name] || 0) + 1;
    写账(账);

    out({ ok: true, order: 单号, paid: isFinite(实付) ? 实付 : 合计, shop: 店.name,
          items: 全选.map((m) => m.name), eta: eta2, shot,
          状态: (详.split("\n")[0] || "").trim(), 足迹 });   // 8/30：成功也把足迹带回（奶绿案没足迹可查）
  } catch (e) {
    死("炸了", `${e.name}: ${String(e.message).slice(0, 200)}`);
  } finally {
    // ⚠️只关我自己开的那张页；复用她原本开着的页就留着（8/13 我一晚上开了八个标签，机器相全在这儿）
    try { if (还原窗) await 还原窗(); } catch {}     // 窗口宽度还给她，别让她回头看见一条细窗
    try { if (我开的) await page.close(); } catch {}
    try { await browser.close(); } catch {}   // connectOverCDP 的 close 只断连，不关她的那间 Chrome
  }
})();
