/* 项目体检（数据一致性 + 结构守卫）
 *
 * 这个项目反复栽在「两份数据对不上」上（找一鸣/找一名、webapp 副本没同步、
 * 悬空特效键），所以把这类不变量固化成检查。
 *
 * 用法：node tools/check.js        （在仓库根目录跑，退出码 0=通过、1=有错误）
 *
 * 为什么在仓库里而不是某个临时目录：这些检查是「改坏了立刻发现」的安全网，
 * 安全网必须跟着代码走。放在被 .gitignore 排除的目录里，换台机器就没了。
 *
 * 九项检查：
 *   1~3  名单/特效键的一致性（四份文件同集合、无重复、特效键对得上名单）
 *   4    cs/ 与 electron/webapp/cs/ 逐字节一致
 *   5    主站资源与桌面版副本一致
 *   6    data/*.json 不带 UTF-8 BOM（Node 的 JSON.parse 不剥 BOM）
 *   7    index.html / style.css 与桌面版副本「只允许预期差异」
 *   8    抽取点结构守卫：唯一、均匀、不引用任何权重字段
 *   9    设置持久化守卫：每个键都要能读回来；跨页共写的键必须「读出→合并→写回」
 *
 * 改完 cs/、assets/js/app.js、index.html、style.css、data/ 之后都该跑一遍。
 *
 * 第 8/9 项的守卫本身由 .workbuddy-ai/tmp/guard-negative.js 做变异测试
 * （故意注入 8 种破坏，确认每一种都被拦下）。守卫从不报警就等于没有守卫，
 * 所以那个反向测试不是可选项。改动这里的判定文案时要同步改它的 expect 字符串。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

let errors = 0;
let warns = 0;
const fail = (m) => { errors++; console.log("  [错误] " + m); };
const warn = (m) => { warns++; console.log("  [注意] " + m); };
const ok = (m) => console.log("  [通过] " + m);

// ---------- 静态分析小工具 ----------

// 取出某个函数的函数体，并带上它在文件里的位置区间。
// 位置区间是必需的：同一个写法在文件里可能合法地出现多次（例如「按随机下标取人」
// 既有决定结果的 pickWinner()，也有滚轮里的纯视觉陪跑卡），只数出现次数会误判，
// 必须判断每一处匹配落在哪个函数里。
// 按大括号配平扫描；这些函数的函数体里不含字符串形式的大括号，所以够用。
function extractFunction(src, name) {
  const decl = src.indexOf("function " + name + "(");
  if (decl < 0) return null;
  const open = src.indexOf("{", decl);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return { body: src.slice(open, i + 1), start: open, end: i };
    }
  }
  return null;
}

const inRange = (i, r) => Boolean(r) && i > r.start && i < r.end;

// 从 `let/var/const NAME = { ... }` 的对象字面量里取出顶层键名
// 去掉注释。理由：settings 字面量里给某个键写一句说明是很正常的（`nameColor` 就写了），
// 而下面的解析是「按顶层逗号切块、块首必须直接是 `key:`」—— 注释会把键名挤到第二行，
// 于是这个键被悄悄漏掉，守卫从此不再检查它。反过来，注释里写个 `foo:` 又会被误当成键。
//
// 注意：**把注释原地替换成空格，保持字符串长度不变**。否则索引会整体错位，
// 所有「先 strip 再按偏移切片」的用法（比如 innermostBlock）都会取到错的位置。
function stripComments(src) {
  const out = src.split("");
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { out[i] = " "; i++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      out[i] = " "; out[i + 1] = " "; i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < src.length) { out[i] = " "; out[i + 1] = " "; i += 2; }
      continue;
    }
    i++;
  }
  return out.join("");
}

// idx 所在的最近一层花括号块。用来回答「这行代码属于哪个函数 / 回调」——
// 只看具名函数会漏掉事件回调（CS 页的模式切换就写在 addEventListener 的匿名函数里）。
function innermostBlock(src, idx) {
  const s = stripComments(src);
  let depth = 0;
  let open = -1;
  for (let i = idx - 1; i >= 0; i--) {
    const c = s[i];
    if (c === "}") depth++;
    else if (c === "{") { if (depth === 0) { open = i; break; } depth--; }
  }
  if (open < 0) return null;
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") d++;
    else if (s[i] === "}") { d--; if (d === 0) return s.slice(open, i + 1); }
  }
  return null;
}

function objectLiteralKeys(src, decl) {
  src = stripComments(src);
  const at = src.indexOf(decl);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  const body = src.slice(open + 1, end);
  const keys = [];
  let d = 0;
  let line = "";
  const flush = (chunk) => {
    const m = chunk.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
    if (m) keys.push(m[1]);
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "[" || c === "(") d++;
    else if (c === "}" || c === "]" || c === ")") d--;
    if (c === "," && d === 0) { flush(line); line = ""; continue; }
    line += c;
  }
  flush(line);
  return keys;
}

// ---------- 读取 ----------
function readJsVars(p) {
  const ctx = { console: { log() {}, warn() {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: p });
  return ctx;
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));   // BOM 会在这里直接炸，正好当检查项
}
function flatten(value) {
  const out = [];
  (function walk(v) {
    if (typeof v === "string") { const t = v.trim(); if (t) out.push(t); return; }
    if (typeof v === "number" && Number.isFinite(v)) { out.push(String(v)); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === "object") Object.keys(v).forEach((k) => walk(v[k]));
  })(value);
  return out;
}

// ---------- 1. 名单：四个文件必须同集合 ----------
console.log("\n== 1. 名单一致性 ==");
const NAME_FILES = [
  "data/names.js", "data/names.json",
  "electron/webapp/data/names.js", "electron/webapp/data/names.json"
];
const nameSets = {};
for (const f of NAME_FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { fail("缺文件 " + f); continue; }
  let raw;
  try {
    raw = f.endsWith(".json") ? readJson(p) : readJsVars(p).NAMES_DATA;
  } catch (e) {
    fail(f + " 读取失败：" + e.message);
    continue;
  }
  if (!raw) { fail(f + " 里没有 NAMES_DATA"); continue; }
  const list = flatten(raw);
  const uniq = new Set(list);
  nameSets[f] = { list, uniq };
  console.log("  " + f.padEnd(38) + list.length + " 条 / 去重 " + uniq.size);
  if (uniq.size !== list.length) {
    fail(f + " 有 " + (list.length - uniq.size) + " 条重复：" +
      list.filter((x, i) => list.indexOf(x) !== i).join("、"));
  }
}
const nameKeys = Object.keys(nameSets);
if (nameKeys.length > 1) {
  const base = nameSets[nameKeys[0]].list;
  const baseStr = JSON.stringify(base);
  let allSame = true;
  for (const f of nameKeys) {
    if (JSON.stringify(nameSets[f].list) !== baseStr) { fail("名单与 " + nameKeys[0] + " 不一致：" + f); allSame = false; }
  }
  if (allSame) ok("四份名单顺序与内容完全一致，共 " + base.length + " 条");
}
const roster = nameSets["data/names.json"] ? nameSets["data/names.json"].list : [];

// ---------- 2. 特效：键集合一致 + 键必须能对上名字 ----------
console.log("\n== 2. 特效一致性 ==");
const EFF_FILES = [
  "data/effects.js", "data/effects.json",
  "electron/webapp/data/effects.js", "electron/webapp/data/effects.json"
];
const effKeys = {};
for (const f of EFF_FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { fail("缺文件 " + f); continue; }
  let obj;
  try {
    obj = f.endsWith(".json") ? readJson(p) : readJsVars(p).EFFECTS_DATA;
  } catch (e) {
    fail(f + " 读取失败：" + e.message);
    continue;
  }
  if (!obj || typeof obj !== "object") { fail(f + " 里没有 EFFECTS_DATA"); continue; }
  effKeys[f] = Object.keys(obj).sort();
  console.log("  " + f.padEnd(38) + effKeys[f].length + " 个键");
}
const eKeys = Object.keys(effKeys);
if (eKeys.length > 1) {
  const base = JSON.stringify(effKeys[eKeys[0]]);
  let allSame = true;
  for (const f of eKeys) {
    if (JSON.stringify(effKeys[f]) !== base) { fail("特效键与 " + eKeys[0] + " 不一致：" + f); allSame = false; }
  }
  if (allSame) ok("四份特效键集合完全一致");
}

// 键 vs 名单
console.log("\n== 3. 特效键能否对上名单 ==");
const SPECIAL = /^(color|bg|theme)\s*[:：]/;   // 形如 "color:（" 的按颜色/背景匹配的键，不走名字
const allKeys = new Set();
Object.values(effKeys).forEach((ks) => ks.forEach((k) => allKeys.add(k)));
const dangling = [];
const special = [];
for (const k of allKeys) {
  if (SPECIAL.test(k)) { special.push(k); continue; }
  if (!roster.includes(k)) dangling.push(k);
}
console.log("  特殊键（按颜色/主题匹配，不查名单）: " + (special.length ? special.join("、") : "无"));
if (dangling.length) {
  warn("对不上任何名字的特效键 " + dangling.length + " 个（不会触发）: " + dangling.join("、"));
} else {
  ok("所有名字类特效键都能对上名单");
}

// ---------- 4. cs/ 与 webapp 副本必须逐字节一致 ----------
console.log("\n== 4. cs/ 桌面版副本同步 ==");
for (const f of ["index.html", "style.css", "app.js"]) {
  const a = path.join(ROOT, "cs", f);
  const b = path.join(ROOT, "electron/webapp/cs", f);
  if (!fs.existsSync(a)) { fail("缺 " + rel(a)); continue; }
  if (!fs.existsSync(b)) { fail("缺桌面版副本 " + rel(b)); continue; }
  const ba = fs.readFileSync(a), bb = fs.readFileSync(b);
  if (ba.equals(bb)) ok("cs/" + f + " 与桌面版副本一致（" + ba.length + " 字节）");
  else fail("cs/" + f + " 与桌面版副本不一致！改完 cs/ 要 cp 到 electron/webapp/cs/ 再打包");
}

// ---------- 5. 主站资源与桌面版副本 ----------
console.log("\n== 5. 主站资源与桌面版副本 ==");
for (const f of ["assets/js/app.js", "data/names.js", "data/names.json",
                 "data/effects.js", "data/effects.json"]) {
  const a = path.join(ROOT, f);
  const b = path.join(ROOT, "electron/webapp", f);
  if (!fs.existsSync(a) || !fs.existsSync(b)) { fail("缺 " + f + " 或其副本"); continue; }
  if (fs.readFileSync(a).equals(fs.readFileSync(b))) ok(f + " 已同步");
  else fail(f + " 与 electron/webapp/" + f + " 不一致，桌面版会跑旧代码");
}

// ---------- 6. JSON 不能带 BOM ----------
console.log("\n== 6. JSON BOM 检查 ==");
const jsonFiles = [];
(function walk(dir, depth) {
  if (depth > 3) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === ".workbuddy-ai") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name.endsWith(".json")) jsonFiles.push(p);
  }
})(ROOT, 0);
let bomCount = 0;
for (const p of jsonFiles) {
  const b = fs.readFileSync(p);
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
    fail("带 UTF-8 BOM：" + rel(p) + "（浏览器会剥掉，但 Node 的 JSON.parse 会直接报错）");
    bomCount++;
  }
}
if (!bomCount) ok(jsonFiles.length + " 个 JSON 文件都不带 BOM");

// ---------- 7. 主站页面与桌面版副本「只允许预期差异」 ----------
console.log("\n== 7. index.html / style.css 的预期差异 ==");
// 桌面版这两份文件本来就该比网页版多出「回到悬浮球」相关内容，
// 除此之外任何差异都说明改了一边忘了另一边。手工同步两个文件太容易漏，
// 所以这里把已知差异精确剥掉再要求完全相等。
const BALL_RETURN_BLOCK = `
  <button class="ball-return" id="ballReturn" type="button" aria-label="回到悬浮球">✕ 回到悬浮球</button>
`.trim();

function stripExpectedIndex(html) {
  const lines = html.split(/\r?\n/);
  const out = [];
  let inBallScript = false;
  for (const line of lines) {
    if (line.trim() === BALL_RETURN_BLOCK) continue;
    if (line.trim() === "<script>" && !inBallScript) {
      // 只可能是「回到悬浮球」那段内联脚本，往后再看几行确认
      const idx = lines.indexOf(line);
      const window5 = lines.slice(idx, idx + 5).join("\n");
      if (window5.indexOf("ballReturn") >= 0) { inBallScript = true; continue; }
    }
    if (inBallScript) {
      if (line.trim() === "</script>") inBallScript = false;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{2,}/g, "\n").trim();
}

const rootIndex = stripExpectedIndex(fs.readFileSync(path.join(ROOT, "index.html"), "utf8"));
const webIndex = stripExpectedIndex(fs.readFileSync(path.join(ROOT, "electron/webapp/index.html"), "utf8"));
if (rootIndex === webIndex) {
  ok("index.html 与桌面版副本只差「回到悬浮球」按钮与脚本，其余完全一致");
} else {
  fail("index.html 与桌面版副本除预期差异外还有不一致！改一边要记得同步另一边");
  const a = rootIndex.split("\n"), b = webIndex.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.log("       第一处差异在第 " + (i + 1) + " 行：");
      console.log("         根目录: " + JSON.stringify(a[i]));
      console.log("         桌面版: " + JSON.stringify(b[i]));
      break;
    }
  }
}

// style.css：桌面版多一个 .ball-return 规则块，其余必须一致
function stripBallReturnCss(css) {
  return css.replace(
    /\/\* 悬浮球桌面版：回到悬浮球按钮 \*\/[\s\S]*?\.ball-return:hover\s*\{[^}]*\}/,
    ""
  ).replace(/\n{2,}/g, "\n").trim();
}
const rootCss = stripBallReturnCss(fs.readFileSync(path.join(ROOT, "assets/css/style.css"), "utf8"));
const webCss = stripBallReturnCss(fs.readFileSync(path.join(ROOT, "electron/webapp/assets/css/style.css"), "utf8"));
if (rootCss === webCss) {
  ok("style.css 与桌面版副本只差 .ball-return 规则，其余完全一致");
} else {
  fail("style.css 与桌面版副本除 .ball-return 外还有不一致！");
  const a = rootCss.split("\n"), b = webCss.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.log("       第一处差异在第 " + (i + 1) + " 行：");
      console.log("         根目录: " + JSON.stringify(a[i]));
      console.log("         桌面版: " + JSON.stringify(b[i]));
      break;
    }
  }
}

// ---------- 8. 「每人等概率」的结构性守卫 ----------
console.log("\n== 8. 抽取是否仍然等概率、且不引入任何权重 ==");
// 用户明确要求：概率对每个人完全一样。
// 这条约定靠统计能验（verify-uniform.js 跑 30 万次抽签），但统计是事后验证，
// 这里做一道事前的结构守卫：决定「谁被抽中」的逻辑必须只有一处、必须是均匀形式、
// 且不引用任何筛选/权重字段。这样以后有人想在抽取里加权重，会先在这里被拦下来。
//
// 注：等级（CS2 稀有度）已于 2026-09-15 整体去掉，所以下面探测的 tier/TIERS
// 现在不会出现在代码里；保留这些关键词是为了让「哪天有人把类似的分组字段塞回抽取」
// 这件事仍然会被拦下 —— 判定文案里的「等级/权重相关标识」被变异测试当锚点用，
// 改动它要同步改 guard-negative.js 的 expect。
{
  const csApp = fs.readFileSync(path.join(ROOT, "cs/app.js"), "utf8");

  const DRAW = /roster\[Math\.floor\(Math\.random\(\)\s*\*\s*roster\.length\)\]/;

  const pick = extractFunction(csApp, "pickWinner");
  if (!pick) {
    fail("cs/app.js 里找不到 pickWinner() —— 唯一抽取点被改名或删掉了，请确认抽取仍然均匀");
  } else {
    const randCount = (pick.body.match(/Math\.random\(\)/g) || []).length;
    const uniformForm = DRAW.test(pick.body);
    const touchesTier = /tier|TIERS|weight|权重|\.p\b/.test(pick.body);

    console.log("  pickWinner() 函数体：" + pick.body.replace(/\s+/g, " ").trim().slice(0, 90));
    if (randCount === 1 && uniformForm) {
      ok("抽取是单一均匀形式 roster[Math.floor(Math.random() * roster.length)]");
    } else {
      fail("抽取形式变了（Math.random 出现 " + randCount + " 次，均匀形式匹配=" + uniformForm + "）" +
           " —— 改动抽取逻辑前请先确认仍然「每人等概率」");
    }
    if (touchesTier) {
      fail("pickWinner() 里出现了等级/权重相关标识 —— 等级不该参与抽取");
    } else {
      ok("pickWinner() 不引用等级/权重，抽取点保持纯净");
    }
  }

  // 滚轮陪跑卡：fillReels() 里 61 张非中奖卡各随机取一个名字，纯视觉。
  // 它决定不了结果，但确实是第二处「随机取人」，所以这里单独认领它，
  // 并且要求它的随机只出现在 `isWinner ? winner : 随机` 的 else 分支上 ——
  // 一旦有人把中奖格也改成随机取（或把三元写反），抽取点就等于被搬走了。
  const filler = extractFunction(csApp, "fillReels");

  const draws = [];
  const DRAW_G = new RegExp(DRAW.source, "g");
  let m;
  while ((m = DRAW_G.exec(csApp)) !== null) draws.push(m.index);

  const stray = draws.filter((i) => !inRange(i, pick) && !inRange(i, filler));
  if (stray.length) {
    const line = csApp.slice(0, stray[0]).split("\n").length;
    fail("第 " + line + " 行有一处随机取人落在 pickWinner() / fillReels() 之外" +
         " —— 除这两处之外不该再有别的抽取点");
  } else if (draws.length === 2) {
    ok("随机取人恰好 2 处，且都在允许的位置：pickWinner()（决定结果）+ fillReels()（陪跑卡）");
  } else {
    fail("随机取人出现 " + draws.length + " 处，预期恰好 2 处（pickWinner + fillReels）");
  }

  if (!filler) {
    fail("找不到 fillReels() —— 滚轮填充逻辑被改名了，请人工确认陪跑卡不会影响结果");
  } else {
    const guarded = /isWinner\s*\?\s*winner\s*:\s*roster\[Math\.floor\(Math\.random\(\)\s*\*\s*roster\.length\)\]/
      .test(filler.body);
    if (guarded) {
      ok("fillReels() 的随机只喂给非中奖格，中奖格拿的是 pickWinner() 传进来的结果");
    } else {
      fail("fillReels() 里不再是「中奖格取 winner、其余取随机」—— 中奖卡可能被随机值覆盖");
    }
  }

  // startSpin 必须通过 pickWinner 取人，不能自己再抽一次
  const spin = extractFunction(csApp, "startSpin");
  if (!spin) {
    fail("找不到 startSpin()");
  } else if (spin.body.indexOf("pickWinner()") >= 0 && !DRAW.test(spin.body)) {
    ok("startSpin() 通过 pickWinner() 取人，没有自己另抽一次");
  } else {
    fail("startSpin() 没有走 pickWinner()，或自己又抽了一次 —— 抽取点不再唯一");
  }
}

// ---------- 9. 设置持久化：存进去的必须读回来，跨页共享的不能整体覆盖 ----------
console.log("\n== 9. 设置持久化 ==");
// 这一节来自两个真实缺陷（都已在 2026-09-14 修掉）：
//
//   A) 主站的初始化块逐项恢复 mode / funNames / studentNames / effects / student，
//      **唯独漏了 announce**。于是「关掉语音播报」确实写进了存储，但刷新后没人读回来，
//      又变回开启 —— 设置看着是保存了，其实每次重开都失效。
//   B) 主站与 CS 页共用同一个存储（网页版 localStorage 的 lucky_settings_v1，
//      桌面版 userData/settings.json），而**两边的写入都是整体覆盖**。
//      CS 页的 settings.effects 恒为 {}，于是只要在 CS 页点一下顶部模式 chip，
//      就会把用户在特效管理里配好的特效全部抹成空 —— 主站只会悄悄退回内置特效，不报错。
//
// 两条不变量，各自守一道：
//   1) settings 里的每一个键，都必须在初始化时被恢复（否则就是「存了不读」）。
//   2) 只负责部分键的那一页（CS 页只负责 mode 与 nameColor），写入必须是「读出现有 → 合并 → 写回」。
{
  const mainApp = fs.readFileSync(path.join(ROOT, "assets/js/app.js"), "utf8");
  const csApp = fs.readFileSync(path.join(ROOT, "cs/app.js"), "utf8");

  // ---- 9.1 存了就必须读回来 ----
  const decl = "let settings = {";
  const keys = objectLiteralKeys(mainApp, decl);
  if (!keys || !keys.length) {
    fail("在 assets/js/app.js 里找不到 settings 对象字面量，无法核对「存了是否读回来」");
  } else {
    // 初始化块 = 从 loadSettings() 到该 then 结束之间
    const from = mainApp.indexOf("const saved = await loadSettings();");
    const to = mainApp.indexOf("effectsByName = (settings.effects", from);
    const initBlock = (from >= 0 && to > from) ? mainApp.slice(from, to) : "";

    if (!initBlock) {
      fail("找不到主站的初始化恢复块（`const saved = await loadSettings();` 之后那段）");
    } else {
      // 兼容两种写法：`saved.xxx` 与 `saved.student.enabled`
      const notRestored = keys.filter((k) => initBlock.indexOf("saved." + k) < 0);
      if (notRestored.length) {
        fail("settings 里的 " + JSON.stringify(notRestored) + " 在初始化时没有被恢复" +
             " —— 这些设置会「存得进去、读不回来」（语音播报开关就是这么丢的）");
      } else {
        ok("settings 的 " + keys.length + " 个键全部在初始化时被恢复：" + keys.join(", "));
      }
    }
  }

  // ---- 9.2 跨页共享的写入必须合并 ----
  const csSave = extractFunction(csApp, "saveSettings");
  if (!csSave) {
    fail("找不到 cs/app.js 的 saveSettings()");
  } else {
    // 把整个 settings（或它的副本）直接交给写入函数，就是 B 类缺陷的写法
    const wholeWrite =
      /JSON\.stringify\(\s*settings\s*\)/.test(csSave.body) ||
      /JSON\.stringify\(\s*data\s*\)/.test(csSave.body) ||
      /bridge\.save\(\s*(settings|data)\s*\)/.test(csSave.body);

    // 更本质的不变量：**每一次写入都必须经过合并辅助函数**。
    // 只检查「有没有用过合并函数」是不够的 —— 只要还有一条写入路径绕过它
    // （比如桌面桥接那条），就仍然会把主站配置覆盖掉。
    // 函数名从 mergeModeInto 改成了 mergeOwnKeysInto（CS 页现在不止负责 mode），
    // 这里用宽松匹配，将来再改名也不会让守卫静默失效。
    const writeCalls = (csSave.body.match(/bridge\.save\(/g) || []).length +
                       (csSave.body.match(/localStorage\.setItem\(/g) || []).length;
    const mergeCalls = (csSave.body.match(/merge[A-Za-z]*Into\(/g) || []).length;
    const allMerged = writeCalls > 0 && writeCalls === mergeCalls;

    if (wholeWrite) {
      fail("cs/app.js 的 saveSettings() 把整个 settings 直接写回了 —— " +
           "CS 页里恒为 {} 的 effects 会覆盖主站配置，把用户的自定义特效抹掉");
    } else if (!allMerged) {
      fail("cs/app.js 的 saveSettings() 有 " + writeCalls + " 处写入、但只有 " + mergeCalls +
           " 处经过合并 —— 两个页面共用同一份设置，每一条写入路径都必须「读出→合并→写回」");
    } else {
      const writes = [];
      if (/localStorage\.setItem\(/.test(csSave.body)) writes.push("localStorage");
      if (/bridge\.save\(/.test(csSave.body)) writes.push("桌面版桥接");
      ok("cs/app.js 的 " + writeCalls + " 条写入路径全部走合并（只覆盖自己负责的 mode 与 nameColor）：" + writes.join(" / "));
    }

    // CS 页没有特效界面，不该碰这个键
    if (csSave.body.indexOf("effects") >= 0) {
      fail("cs/app.js 的 saveSettings() 里出现了 effects —— CS 页没有特效界面，不该碰这个键");
    }

    // ---- 9.3 CS 页改过的键，必须真的被合并函数带出去 ----
    // 9.2 只保证「每条写入都走了合并函数」，不保证合并函数里真的包含这个页面的所有键。
    // 有人加一项新设置、忘了加进合并对象 —— 9.2 依然全绿，而用户在 CS 页改的东西
    // 一刷新就没了（这正是 nameColor 这个新键最容易踩的坑）。
    // 判据：凡是「改完设置就调 saveSettings()」的函数，它赋值的每个 settings.<key>
    // 都必须在合并函数里出现。
    const mergeNameMatch = csSave.body.match(/merge[A-Za-z]*Into\(/);
    const mergeFnName = mergeNameMatch ? mergeNameMatch[0].slice(0, -1) : null;
    const mergeFn = mergeFnName ? extractFunction(csApp, mergeFnName) : null;
    if (!mergeFn) {
      fail("找不到 cs/app.js 的合并辅助函数 —— saveSettings() 里没有调用任何 merge*Into()");
    } else {
      const mutating = new Set();
      const reSet = /settings\.([A-Za-z_$][\w$]*)\s*=(?!=)/g;
      const collect = (text) => {
        let sm;
        reSet.lastIndex = 0;
        while ((sm = reSet.exec(text))) mutating.add(sm[1]);
      };
      // ① 具名函数：改完设置就保存的（比如 setNameColor）
      const reFn = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
      let fm;
      while ((fm = reFn.exec(csApp))) {
        const fn = extractFunction(csApp, fm[1]);
        if (!fn || fn.body.indexOf("saveSettings()") < 0) continue;
        collect(fn.body);
      }
      // ② 匿名回调：CS 页的模式切换写在 addEventListener 的匿名函数里，
      //    只扫具名函数会漏掉它 —— 那正是这个守卫最该盯住的一类代码。
      const reCall = /saveSettings\(\)/g;
      let cm;
      while ((cm = reCall.exec(csApp))) {
        // 函数**定义**后面跟的是 `{`，调用后面跟的是 `;` 或换行。
        // 不排除定义的话，它的「最近外层块」是整个 IIFE —— 初始化块里的
        // settings.funNames = ... 会被一并算进来，守卫直接误报。
        const after = csApp.slice(cm.index + "saveSettings()".length);
        if (/^\s*\{/.test(after)) continue;
        const blk = innermostBlock(csApp, cm.index);
        if (blk) collect(blk);
      }
      const owned = [...mutating];
      const merged = stripComments(mergeFn.body);
      const notMerged = owned.filter((k) => merged.indexOf(k) < 0);
      if (!owned.length) {
        fail("在 cs/app.js 里找不到任何「改完设置就保存」的函数，9.3 无从判断（守卫已失效）");
      } else if (notMerged.length) {
        fail("cs/app.js 会改写 " + JSON.stringify(owned) + "，但 " + mergeFnName + "() 里漏了 " +
             JSON.stringify(notMerged) + " —— 用户在 CS 页改的这一项会「存得进去、读不回来」");
      } else {
        ok("CS 页会改写的设置键 " + JSON.stringify(owned) + " 全部由 " + mergeFnName + "() 带出去");
      }
    }
  }
}

// ---------- 汇总 ----------
console.log("\n== 汇总 ==");
console.log("  错误 " + errors + " 项，注意 " + warns + " 项");
process.exit(errors ? 1 : 0);
