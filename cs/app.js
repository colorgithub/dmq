/* CS 点名器 —— 逻辑层
 *
 * 视觉与动效参数来自 CS2Deck 开箱器（cs2deck.com/zh-CN/tools/case-opener）逆向：
 *   - 滚轮 62 张卡，中奖卡固定在第 46 张（0 基）
 *   - 缓动 cubic-bezier(0.08, 0.72, 0.05, 1)，主滚动 5200ms，另有 160ms 起手
 *   - 落点公式：center - (46 * cardW + cardW * (0.18 + 0.64 * rand))
 *
 * 等级（CS2 稀有度）已整体去掉：不再有稀有度中文名 / 分档配色 / 按稀有度的揭晓音阶，
 * 所有人共用同一个名字颜色，揭晓音效也只有一种。
 * 颜色默认是 DEFAULT_NAME_COLOR 这个红，用户可以在顶部「颜色」里换成预设色或自定义色，
 * 选择存在共享设置里（键名 nameColor，见 mergeOwnKeysInto 与 assets/js/app.js 的 settings）。
 *
 * 与主站共用：localStorage 键 lucky_settings_v1（模式、名单、学号规则、名字颜色）
 * 与 data/names.json（失败时回退到 script 引入的 NAMES_DATA）
 */
(function () {
  "use strict";

  // ==================== 常量 ====================

  var REEL_COUNT = 62;      // 滚轮卡片数
  var WINNER_INDEX = 46;    // 中奖卡位置
  var SPIN_MS = 5200;       // 主滚动时长
  var KICK_MS = 160;        // 起手微推时长
  var KICK_CARDS = 1.2;     // 起手推进的卡宽倍数
  var LAND_MIN = 0.18;      // 落点在卡内的最小偏移比例
  var LAND_SPAN = 0.64;     // 落点可浮动区间宽度
  var REDUCED_MS = 900;     // prefers-reduced-motion 下的时长

  var SETTINGS_KEY = "lucky_settings_v1";
  var HISTORY_KEY = "cs_picker_history_v1";
  var SOUND_KEY = "cs_picker_sound_v1";
  var HISTORY_MAX = 12;

  // 名字颜色。等级去掉之后全员同一个颜色，默认是红；
  // 用户可以在顶部的「颜色」里改成别的（预设色或系统取色器任选）。
  //
  // 这一个颜色同时喂给两个 CSS 变量：
  //   --name-color → 卡片底条 / 卡片辉光 / 中奖描边 / 历史圆点
  //   --win-color  → 结果卡描边与光晕 / 结果卡上的学号
  // 两个都写在 :root 上，子元素继承 —— 所以**不需要再逐张卡去写**，
  // 改一处就全变（原来是每张卡各写一次，那是「每人一个颜色」时代留下的写法）。
  var DEFAULT_NAME_COLOR = "#eb4b4b";
  var nameColor = DEFAULT_NAME_COLOR;
  // 逐人颜色：{ 名字: "#hex" }。**没写在这张表里的名字就跟随默认色 nameColor。**
  // 键是名字而不是学号 —— 学号模式下的卡片内容是「12 张三」，抽的是名字，
  // 而且同一个人在两个模式的名单里都该是同一个颜色。
  var nameColors = {};

  // 预设色。除了这几个，还能用系统取色器选任意颜色。
  var COLOR_PRESETS = [
    ["#eb4b4b", "红"],
    ["#ffd700", "金"],
    ["#4b69ff", "蓝"],
    ["#8847ff", "紫"],
    ["#4ade80", "绿"],
    ["#e8e8e8", "白"]
  ];

  // 颜色来自存储 / 用户输入，**必须校验后再用**：只接受 #rgb / #rrggbb，
  // 统一成小写六位。非法值一律退回默认色 —— 不要把任意字符串塞进 CSS 变量。
  function normalizeColor(v) {
    if (typeof v !== "string") return null;
    var s = v.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    if (/^#[0-9a-f]{3}$/.test(s)) {
      return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    }
    return null;
  }

  // 逐人颜色表来自存储，同样不可信：逐个键值校验，非法的一律丢掉。
  // 返回普通对象（不是 Object.create(null)），这样 JSON.stringify 和
  // Object.keys 的行为跟别处一致；代价是要显式跳过 __proto__ 这类键。
  function sanitizeNameColors(raw) {
    var out = {};
    if (!raw || typeof raw !== "object") return out;
    for (var k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (!k) continue;
      var c = normalizeColor(raw[k]);
      if (c) out[k] = c;
    }
    return out;
  }

  // 这个人有没有**单独**设过颜色。没有就返回 null，表示跟随默认色。
  // 热路径（每张卡每次刷新都调），所以这里只查表、不做 normalize ——
  // 进表的值在 sanitizeNameColors / setNameColorFor 里已经规范化过了。
  function customColorFor(name) {
    if (!name) return null;
    var c = nameColors[name];
    return (typeof c === "string") ? c : null;
  }

  // ==================== DOM ====================

  var root = document.documentElement;
  var stripEl = document.querySelector(".strip");
  var stripReel = document.getElementById("stripReel");
  var lensInner = document.querySelector(".lens-inner");
  var lensReel = document.getElementById("lensReel");
  var statusEl = document.getElementById("status");
  var openBtn = document.getElementById("openBtn");
  var openBtnLabel = document.getElementById("openBtnLabel");
  var resultEl = document.getElementById("result");
  var resultCard = document.getElementById("resultCard");
  var resultTag = document.getElementById("resultTag");
  var resultName = document.getElementById("resultName");
  var historyList = document.getElementById("historyList");
  var historyEmpty = document.getElementById("historyEmpty");
  var clearHistoryBtn = document.getElementById("clearHistory");
  var soundBtn = document.getElementById("soundBtn");
  var modeChip = document.getElementById("modeChip");
  var rosterCountEl = document.getElementById("rosterCount");
  var srAnnounce = document.getElementById("srAnnounce");
  var colorBtn = document.getElementById("colorBtn");
  var colorSwatch = document.getElementById("colorSwatch");
  var colorPop = document.getElementById("colorPop");
  var colorGrid = document.getElementById("colorGrid");
  var colorCustom = document.getElementById("colorCustom");
  var nameColorBtn = document.getElementById("nameColorBtn");
  var nameColorModal = document.getElementById("nameColorModal");
  var nameColorList = document.getElementById("nameColorList");
  var nameColorClose = document.getElementById("nameColorClose");
  var nameColorSummary = document.getElementById("nameColorSummary");
  var nameColorResetAll = document.getElementById("nameColorResetAll");

  // ==================== 状态 ====================

  var baseNames = [];              // 内置名单（JSON 优先，script 兜底）
  var roster = [];                 // 当前生效名单 [{id, name}]
  var history = [];                // [{name, id}]
  var winnerCards = [];            // 本轮中奖卡元素
  var spinning = false;
  var soundOn = true;
  var colorPopOpen = false;        // 颜色下拉面板是否开着
  // 当前打开的模态弹层（null = 没开）。用显式变量记录，不从 .show 之类的 class 反推 ——
  // 反推的做法在「两个弹层互相切换」时会算错，主站那边踩过。
  var activeModal = null;
  var rafId = 0;
  var resizeRaf = 0;
  // 滚轮逻辑位置，单位＝卡宽。用「卡坐标」而不是像素，
  // 这样窗口尺寸变化（--card-w 从 256 变 160）时滚轮不会跑出可视区。
  var currentCards = 0;

  // 尺寸只在启动与窗口变化时量一次。卡宽由 CSS 变量 --card-w 决定，
  // 抽签过程中不会变，所以没必要每次抽签都强制一次布局。
  var metrics = { strip: 0, lens: 0, card: 256, valid: false };

  var settings = {
    mode: "fun",
    funNames: "",
    studentNames: "",
    announce: true,
    // 名字颜色。这是 CS 页**自己的**设置（主站用不到它，但必须原样带过 ——
    // 主站保存设置时是整份覆盖，所以那边也得知道这个键，否则会被抹掉）。
    nameColor: DEFAULT_NAME_COLOR,
    // 逐人颜色表 { 名字: "#hex" }。和 nameColor 一样属于 CS 页自己的设置，
    // 但主站必须认识这个键、原样带过（否则整份覆盖会把它抹掉）。
    nameColors: {},
    // CS 页没有特效界面，这个字段只是为了和主站的设置形状保持一致。
    // 它**不会被写回存储**（见 saveSettings：只合并 mode），所以别指望靠它
    // 覆盖主站的特效配置 —— 那正是之前把用户特效清空的原因。
    effects: {},
    student: { start: 1, pad: "", prefix: "", suffix: "" }
  };

  // ==================== 无障碍偏好 ====================

  // 用户是否要求减少动效。CSS 侧的 @media 只能管到样式，
  // 有两处是 JS 主动发起的动效，必须在这里单独判断：
  //   1) startSpin 里的滚动时长（5200ms -> 900ms）
  //   2) showResult 里 scrollIntoView 的 behavior（smooth -> auto）——
  //      CSS 的 scroll-behavior 覆盖不了显式传入的 behavior 选项
  function prefersReducedMotion() {
    return !!(window.matchMedia &&
              window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // ==================== 缓动 ====================

  // cubic-bezier 求值（牛顿迭代 + 二分兜底），返回 x -> y 的函数
  function cubicBezier(x1, y1, x2, y2) {
    var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;

    function sampleX(t) { return ((ax * t + bx) * t + cx) * t; }
    function sampleY(t) { return ((ay * t + by) * t + cy) * t; }
    function sampleDX(t) { return (3 * ax * t + 2 * bx) * t + cx; }

    function solve(x) {
      var t = x, i, dx, d;
      for (i = 0; i < 8; i++) {
        dx = sampleX(t) - x;
        if (Math.abs(dx) < 1e-6) return t;
        d = sampleDX(t);
        if (Math.abs(d) < 1e-6) break;
        t -= dx / d;
      }
      var lo = 0, hi = 1;
      t = x;
      for (i = 0; i < 24; i++) {
        dx = sampleX(t);
        if (Math.abs(dx - x) < 1e-6) return t;
        if (x > dx) lo = t; else hi = t;
        t = (hi + lo) / 2;
      }
      return t;
    }

    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      return sampleY(solve(x));
    };
  }

  var easeFn = cubicBezier(0.08, 0.72, 0.05, 1);

  // ==================== 名单 ====================

  function normalizeNames(data) {
    var out = [];
    (function walk(value) {
      if (typeof value === "string") {
        var t = value.trim();
        if (t) out.push(t);
        return;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        out.push(String(value));
        return;
      }
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (value && typeof value === "object") {
        Object.keys(value).forEach(function (k) { walk(value[k]); });
      }
    })(data);
    return out;
  }

  function loadBaseNames() {
    var fallback = Array.isArray(window.NAMES_DATA) ? window.NAMES_DATA.slice() : [];
    return fetch("../data/names.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("names.json " + r.status);
        return r.json();
      })
      .then(function (data) {
        var list = normalizeNames(data);
        return list.length ? list : fallback;
      })
      .catch(function () { return fallback; });
  }

  function parseRosterLine(line) {
    var t = String(line || "").trim();
    if (!t) return null;
    var m = t.match(/^(\d+)\s+(.+)$/);
    if (m) return { id: m[1], name: m[2].trim() };
    return { id: null, name: t };
  }

  function buildRoster() {
    var src, list = [], i, t;

    if (settings.mode === "student") {
      src = String(settings.studentNames || "").trim()
        ? settings.studentNames.split(/\r?\n/)
        : baseNames;
      var st = settings.student || {};
      var counter = (typeof st.start === "number" && isFinite(st.start)) ? st.start : 1;
      var pad = parseInt(st.pad, 10);
      for (i = 0; i < src.length; i++) {
        var p = parseRosterLine(src[i]);
        if (!p) continue;
        var id = p.id;
        if (id == null) {
          var num = String(counter);
          if (pad > 0) num = num.padStart(pad, "0");
          id = (st.prefix || "") + num + (st.suffix || "");
        }
        counter += 1;
        list.push({ id: String(id), name: p.name });
      }
      return list.map(function (r) {
        return { id: r.id, name: r.name };
      });
    }

    src = String(settings.funNames || "").trim()
      ? settings.funNames.split(/\r?\n/)
      : baseNames;
    var seen = {};
    for (i = 0; i < src.length; i++) {
      t = String(src[i] || "").trim();
      if (!t || seen[t]) continue;
      seen[t] = 1;
      list.push({ id: null, name: t });
    }
    return list;
  }

  // ==================== 设置持久化（与主站共用） ====================

  function readLocalSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return null;
  }

  function loadSettings() {
    try {
      var bridge = window.desktopBall && window.desktopBall.settings;
      if (bridge && bridge.load) {
        return Promise.resolve(bridge.load()).then(function (s) {
          return (s && typeof s === "object") ? s : readLocalSettings();
        }).catch(function () { return readLocalSettings(); });
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve(readLocalSettings());
  }

  // CS 页只负责 mode 和 nameColor 这两个键 —— 它没有名单 / 特效 / 学号的编辑界面，
  // settings 里其余字段对它来说都是「别人的数据」。
  //
  // 两个页面共用同一份设置：网页版是 localStorage 的 lucky_settings_v1，
  // 桌面版是 userData/settings.json，而且**两边的写入都是整体覆盖**。
  // 所以这里必须「读出当前存储 → 只覆盖自己改过的键 → 写回」。
  //
  // 原来这里是直接把整个 settings 写回去，于是 CS 页里恒为 {} 的 settings.effects
  // 会把用户在特效管理里配好的特效全部抹掉 —— 点一下顶部模式 chip 就会发生，
  // 而且不报任何错（主站只会悄悄退回内置特效）。
  //
  // 反过来也要小心：主站保存设置时同样是整份覆盖，所以主站那边也得知道 nameColor
  // 这个键（见 assets/js/app.js 的 settings 与初始化恢复），否则用户在 CS 页选的颜色
  // 会被主站的「保存设置」抹掉。tools/check.js 第 9 项守的就是这条。
  function mergeOwnKeysInto(prev) {
    var base = (prev && typeof prev === "object") ? prev : {};
    return Object.assign({}, base, {
      mode: settings.mode,
      nameColor: nameColor,
      nameColors: nameColors
    });
  }

  function saveSettings() {
    try {
      var bridge = window.desktopBall && window.desktopBall.settings;
      if (bridge && bridge.save) {
        // 桌面版：先读出磁盘上的完整设置，合并后再写回
        var commit = function (prev) { bridge.save(mergeOwnKeysInto(prev)); };
        if (bridge.load) {
          Promise.resolve(bridge.load()).then(commit, function () { commit(null); });
        } else {
          commit(null);
        }
        return;
      }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(mergeOwnKeysInto(readLocalSettings())));
    } catch (e) { /* ignore */ }
  }

  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      var arr = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (h) {
        return h && typeof h.name === "string";
      }).slice(0, HISTORY_MAX);
    } catch (e) { return []; }
  }

  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (e) { /* ignore */ }
  }

  function loadSoundPref() {
    try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch (e) { return true; }
  }

  // ==================== 音频（纯 WebAudio 合成，不依赖素材） ====================

  var audioCtx = null;

  function ac() {
    if (!audioCtx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      try { audioCtx = new Ctx(); } catch (e) { return null; }
    }
    if (audioCtx.state === "suspended") { audioCtx.resume(); }
    return audioCtx;
  }

  function unlockAudio() { ac(); }

  // ---------- CS:GO 开箱音效（全部现场合成，不依赖素材文件） ----------
  //
  // 参考 CS:GO 开箱的两段声音：
  //   1) 滚轮转动时连续的「咔哒」——干、短、偏机械，没有音乐性的音高。
  //      所以用极短的带通噪声脉冲来做；原来的方波 blip 听感太"电子"。
  //   2) 揭晓瞬间——一股由低扫到高的气流推上来，紧接一记金属感的钟声和低频落地，
  //      这样才像"箱子开了"；原来只是按稀有度播一段音阶，更像捡到金币。
  // 等级去掉之后揭晓只剩一种声音，不再按稀有度分档。

  var noiseBuf = null;

  // 白噪声缓冲只生成一次，之后所有噪声类音效共用
  function getNoise(ctx) {
    if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
    var len = Math.max(1, Math.floor(ctx.sampleRate * 0.5));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noiseBuf = buf;
    return buf;
  }

  // 带通噪声脉冲：开箱滚轮「咔哒」的本体
  function noiseHit(ctx, when, dur, freq, q, gain) {
    var src = ctx.createBufferSource();
    src.buffer = getNoise(ctx);
    var bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = q;
    bp.frequency.setValueAtTime(freq, when);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(ctx.destination);
    src.start(when);
    src.stop(when + dur + 0.02);
  }

  // 由低扫到高的气流声，给揭晓一个「推上来」的势
  function riser(ctx, when, dur, gain) {
    var src = ctx.createBufferSource();
    src.buffer = getNoise(ctx);
    var bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.8;
    bp.frequency.setValueAtTime(420, when);
    bp.frequency.exponentialRampToValueAtTime(5200, when + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + dur * 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(ctx.destination);
    src.start(when);
    src.stop(when + dur + 0.02);
  }

  // 钟声的一个分音（指数衰减）
  function bell(ctx, freq, when, dur, gain) {
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, when);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(when);
    osc.stop(when + dur + 0.03);
  }

  // 低频落地感：让揭晓有重量
  function thump(ctx, when, dur, gain) {
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(170, when);
    osc.frequency.exponentialRampToValueAtTime(62, when + dur);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(when);
    osc.stop(when + dur + 0.03);
  }

  // 滚轮转动时的一记「咔哒」：高频噪声脉冲 + 一记很轻的低频闷响
  function playTick() {
    if (!soundOn) return;
    var ctx = ac();
    if (!ctx) return;
    var t = ctx.currentTime;
    noiseHit(ctx, t, 0.035, 2200 + Math.random() * 1500, 1.1, 0.055);
    thump(ctx, t, 0.05, 0.03);
  }

  // 揭晓：锁扣声 → 气流 → 低频落地 → 金属钟声
  function playReveal() {
    if (!soundOn) return;
    var ctx = ac();
    if (!ctx) return;
    var t0 = ctx.currentTime + 0.01;

    // 滚轮停住的那一下，比普通 tick 更实
    noiseHit(ctx, t0, 0.05, 1500, 0.9, 0.075);
    thump(ctx, t0, 0.12, 0.06);

    // 气流推上来
    riser(ctx, t0 + 0.02, 0.30, 0.05);

    // 落地 + 钟声（分音刻意不成谐波关系，才有金属味）
    thump(ctx, t0 + 0.20, 0.34, 0.11);
    var partials = [
      [1046.50, 1.30, 0.075],
      [1567.98, 1.05, 0.048],
      [2093.00, 0.85, 0.032],
      [3135.96, 0.60, 0.018]
    ];
    for (var i = 0; i < partials.length; i++) {
      bell(ctx, partials[i][0], t0 + 0.21 + i * 0.012, partials[i][1], partials[i][2]);
    }
  }

  // ==================== 语音播报 ====================

  var voices = [];
  var zhVoice;            // undefined = 还没挑过；null = 挑过了但没有中文语音
  var speechTimer = null;

  function refreshVoices() {
    if (!("speechSynthesis" in window)) return;
    voices = window.speechSynthesis.getVoices().filter(Boolean);
    zhVoice = undefined;  // 语音列表变了，重新挑
  }

  function pickChineseVoice() {
    if (zhVoice !== undefined) return zhVoice;
    var zh = voices.filter(function (v) { return v.lang && v.lang.toLowerCase().indexOf("zh") === 0; });
    zhVoice = zh.find(function (v) { return v.localService !== false; }) || zh[0] || null;
    return zhVoice;
  }

  function speak(name, delay) {
    if (!soundOn || settings.announce === false) return;
    if (!("speechSynthesis" in window) || !name) return;
    if (speechTimer) clearTimeout(speechTimer);
    speechTimer = setTimeout(function () {
      try {
        var synth = window.speechSynthesis;
        // getVoices() 在 Windows 上要枚举一遍系统语音，没必要每次播报都问一次；
        // 首次为空时再取，之后靠 onvoiceschanged 刷新。
        if (!voices.length) refreshVoices();
        var u = new SpeechSynthesisUtterance(name);
        u.lang = "zh-CN";
        var zh = pickChineseVoice();
        if (zh) u.voice = zh;
        u.rate = 0.95;
        synth.cancel();
        synth.speak(u);
      } catch (e) { /* ignore */ }
    }, delay || 0);
  }

  // ==================== 滚轮渲染 ====================

  // 卡片池：两条滚轮各 62 张，抽签时只改文字与颜色，不重建 DOM。
  // 早先每次抽签要新建约 370 个节点再全部销毁，现在新建数为 0。
  var pool = { strip: [], lens: [] };

  function makeCard() {
    var card = document.createElement("div");
    card.className = "card";

    var inner = document.createElement("div");
    inner.className = "card-inner";

    var name = document.createElement("span");
    name.className = "card-name";

    var idEl = document.createElement("span");
    idEl.className = "card-id";
    idEl.hidden = true;

    var textNode = document.createTextNode("");
    name.appendChild(idEl);
    name.appendChild(textNode);
    inner.appendChild(name);
    card.appendChild(inner);

    // 缓存子节点引用，刷新时直接改 nodeValue，避免 textContent 重建文本节点
    card._id = idEl;
    card._text = textNode;
    // 这张卡当前内联写着的逐人颜色（null = 没写、走 :root 继承）。
    // 用来避免每次刷新都重复写同一个值 —— 见 applyCardColor。
    card._color = null;
    card._name = "";
    return card;
  }

  // 把「这个人该用什么颜色」落到卡片上。
  //
  // 没单独设过颜色的人 → 卡片上不写这个变量，颜色从 :root 继承（0 次样式写入）。
  // 设过的人 → 在他自己的卡上写一次覆盖掉继承值。
  // 关键是先跟 card._color 比一下：同一个人连续刷新、或整批人都是默认色时，
  // 一次写入都不会发生。所以「没人自定义颜色」的性能跟改造前完全一样。
  function applyCardColor(card) {
    var custom = customColorFor(card._name);
    if (custom === card._color) return;
    if (custom) card.style.setProperty("--name-color", custom);
    else card.style.removeProperty("--name-color");
    card._color = custom;
  }

  // 默认色或逐人颜色改了之后，把已经渲染出来的卡重新上色
  function repaintCards() {
    var i;
    for (i = 0; i < pool.strip.length; i++) applyCardColor(pool.strip[i]);
    for (i = 0; i < pool.lens.length; i++) applyCardColor(pool.lens[i]);
  }

  function updateCard(card, item) {
    card._name = item.name;
    applyCardColor(card);
    if (item.id) {
      card._id.textContent = item.id;
      card._id.hidden = false;
    } else {
      card._id.hidden = true;
    }
    card._text.nodeValue = item.name;
  }

  // 池子按需扩容；节点被摘下来过（例如名单清空时清空了 reel）就重新挂回去
  function attachPool(reel, list) {
    if (reel.childElementCount) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) frag.appendChild(list[i]);
    reel.appendChild(frag);
  }

  function ensurePool() {
    for (var i = pool.strip.length; i < REEL_COUNT; i++) {
      pool.strip.push(makeCard());
      pool.lens.push(makeCard());
    }
    attachPool(stripReel, pool.strip);
    attachPool(lensReel, pool.lens);
  }

  // 两条滚轮内容必须完全一致，放大镜才像同一个滚轮
  function fillReels(winner) {
    ensurePool();
    winnerCards = [];

    for (var i = 0; i < REEL_COUNT; i++) {
      var isWinner = !!winner && i === WINNER_INDEX;
      var item = isWinner ? winner : roster[Math.floor(Math.random() * roster.length)];
      updateCard(pool.strip[i], item);
      updateCard(pool.lens[i], item);
      if (isWinner) winnerCards.push(pool.strip[i], pool.lens[i]);
    }
  }

  function measure() {
    metrics.strip = stripEl.clientWidth;
    metrics.lens = lensInner.clientWidth;
    var first = stripReel.firstElementChild;
    metrics.card = first ? first.getBoundingClientRect().width : 256;
    if (!metrics.card) metrics.card = 256;
    metrics.valid = true;
  }

  // cards = 滚轮停留的卡坐标：整数部分是卡片序号，小数部分是卡内落点比例。
  // 两条滚轮分别按各自容器中心换算像素偏移。
  function applyCards(cards) {
    currentCards = cards;
    var travel = cards * metrics.card;
    var sx = metrics.strip / 2 - travel;
    var lx = metrics.lens / 2 - travel;
    stripReel.style.transform = "translate3d(" + sx.toFixed(2) + "px, -50%, 0)";
    lensReel.style.transform = "translate3d(" + lx.toFixed(2) + "px, -50%, 0)";
  }

  function clearWinnerHighlight() {
    var nodes = document.querySelectorAll(".card.is-winner");
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove("is-winner");
    winnerCards = [];
  }

  // ==================== 状态 / 结果 / 历史 ====================

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status" + (cls ? " " + cls : "");
  }

  function renderHistory() {
    historyList.textContent = "";
    history.forEach(function (h) {
      var li = document.createElement("li");
      li.className = "history-item";
      // 单独设过颜色的人，历史条目也跟着用他自己的色；没设过的从 :root 继承。
      // 历史列表每次都是整段重建的，所以这里直接写一次不影响性能。
      var hc = customColorFor(h.name);
      if (hc) li.style.setProperty("--name-color", hc);

      var dot = document.createElement("span");
      dot.className = "history-dot";

      var text = document.createElement("span");
      text.textContent = (h.id ? h.id + " " : "") + h.name;

      li.appendChild(dot);
      li.appendChild(text);
      historyList.appendChild(li);
    });
    historyEmpty.hidden = history.length > 0;
  }

  function pushHistory(winner) {
    history.unshift({ name: winner.name, id: winner.id });
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    saveHistory();
    renderHistory();
  }

  function showResult(winner) {
    // 原来这一行是「学号 · 稀有度」。等级去掉之后这里只剩学号，
    // 趣味模式下没有学号，就把整行收起来，免得结果卡上多一条空白。
    if (winner.id) {
      resultTag.textContent = winner.id;
      resultTag.hidden = false;
    } else {
      resultTag.textContent = "";
      resultTag.hidden = true;
    }
    resultName.textContent = winner.name;
    resultEl.hidden = false;
    // 重放弹出动画。pop 的终态就是基础样式（opacity:1 / transform:none），
    // 所以减少动效时直接跳过：既不用为了一次强制回流白跑一遍布局，
    // 视觉上也完全一致（CSS 那边已经把 .result-card 的 animation 关掉了）。
    if (!prefersReducedMotion()) {
      resultCard.style.animation = "none";
      void resultCard.offsetWidth;
      resultCard.style.animation = "";
    }
    // 窗口矮的时候结果卡可能落在折叠线以下，轻轻滚一点让它露出来
    if (typeof resultEl.scrollIntoView === "function") {
      try {
        resultEl.scrollIntoView({
          block: "nearest",
          behavior: prefersReducedMotion() ? "auto" : "smooth"
        });
      } catch (e) {
        resultEl.scrollIntoView(false);
      }
    }
  }

  // ==================== 点名主流程 ====================

  // ==================== 抽取 ====================

  // 全应用唯一的抽取点，必须保持均匀：每人概率严格相等（1 / roster.length）。
  //
  // 这里是「每人等概率」这个约定的唯一归属地。想在这里引入任何权重（比如让某几个人
  // 更容易被抽到），都必须先改这里，而改这里就等于明确地推翻上面的约定。
  //
  // 注：原来还挂着「稀有度」这层展示概念，现已按用户要求整体去掉 ——
  // 所有人的颜色统一为红色，抽取本身从来就没有权重，去掉后更没有。
  function pickWinner() {
    return roster[Math.floor(Math.random() * roster.length)];
  }

  function startSpin() {
    if (spinning || !roster.length) return;
    spinning = true;

    var winner = pickWinner();

    clearWinnerHighlight();
    fillReels(winner);
    // 卡宽只在断点变化时才变，已经量过就不必再量（避免每次抽签强制一次布局）
    if (!metrics.valid) measure();

    var startCards = 0.5;
    var endCards = WINNER_INDEX + LAND_MIN + LAND_SPAN * Math.random();

    applyCards(startCards);

    var reduce = prefersReducedMotion();
    var spinMs = reduce ? REDUCED_MS : SPIN_MS;
    var kickMs = reduce ? 0 : KICK_MS;
    var kickCards = reduce ? startCards : startCards + KICK_CARDS;

    setStatus("开启中…", "is-hot");
    openBtn.disabled = true;
    openBtnLabel.textContent = "开启中…";
    resultEl.hidden = true;

    var t0 = performance.now();
    var lastIdx = Math.floor(startCards);
    var lastTickAt = 0;

    function frame(now) {
      var elapsed = now - t0;
      var cards;

      if (elapsed < kickMs) {
        cards = startCards + (kickCards - startCards) * (elapsed / kickMs);
      } else {
        var p = Math.min(1, (elapsed - kickMs) / spinMs);
        cards = kickCards + (endCards - kickCards) * easeFn(p);
      }
      applyCards(cards);

      var idx = Math.floor(cards);
      if (idx !== lastIdx) {
        lastIdx = idx;
        // 高速段一帧能跨过好几张卡，限流避免爆音
        if (now - lastTickAt > 30) {
          lastTickAt = now;
          playTick();
        }
      }

      if (elapsed < kickMs + spinMs) {
        rafId = requestAnimationFrame(frame);
      } else {
        rafId = 0;
        finish(winner, endCards);
      }
    }

    rafId = requestAnimationFrame(frame);
  }

  function finish(winner, endCards) {
    spinning = false;
    applyCards(endCards);

    winnerCards.forEach(function (el) { el.classList.add("is-winner"); });
    // 结果卡用中奖者自己的色（单独设过的话），否则继承 :root 上的 --win-color。
    // 每轮揭晓只写一次，不在热路径上。
    var wc = customColorFor(winner.name);
    if (wc) resultCard.style.setProperty("--win-color", wc);
    else resultCard.style.removeProperty("--win-color");

    showResult(winner);
    setStatus("★ 开箱完成 ★", "is-win");
    // 状态条只报状态，人名单独播给屏幕阅读器
    if (srAnnounce) {
      srAnnounce.textContent = "抽中 " + (winner.id ? winner.id + " " : "") + winner.name;
    }

    openBtn.disabled = false;
    openBtnLabel.textContent = "再来一次";

    pushHistory(winner);
    playReveal();
    speak(winner.name, 900);
  }

  // ==================== 界面刷新 ====================

  function refreshRoster() {
    roster = buildRoster();

    modeChip.textContent = settings.mode === "student" ? "学号+名字模式" : "趣味模式";
    rosterCountEl.textContent = roster.length + " 人";
    resultEl.hidden = true;
    clearWinnerHighlight();

    if (!roster.length) {
      stripReel.textContent = "";
      lensReel.textContent = "";
      openBtn.disabled = true;
      setStatus("名单为空，请先回到「抽签」页设置名单", "");
      return;
    }

    fillReels(null);
    measure();
    applyCards(WINNER_INDEX + 0.5);
    openBtn.disabled = spinning;
    setStatus("准备就绪", "");
  }

  function syncSoundButton() {
    soundBtn.textContent = soundOn ? "音效 开" : "音效 关";
    soundBtn.classList.toggle("is-off", !soundOn);
    soundBtn.title = soundOn ? "点击关闭音效与语音" : "点击开启音效与语音";
  }

  // ==================== 名字颜色 ====================

  // 把当前颜色写到根元素上。卡片 / 放大镜 / 结果卡 / 历史圆点都继承这两个变量，
  // 所以只改这一处，全页跟着变。
  // 注意：**单独设过颜色的人不吃这一套** —— 他们的卡片上有自己的内联变量，优先于继承。
  // 改默认色时不必重刷卡片：跟随默认的那些是靠 CSS 继承自动变的，
  // 而单独设过色的本来就该保持不变。（逐人颜色表变了才需要重刷，见 setNameColorFor。）
  function applyNameColor() {
    root.style.setProperty("--name-color", nameColor);
    root.style.setProperty("--win-color", nameColor);
    syncColorUI();
  }

  function colorLabel(hex) {
    for (var i = 0; i < COLOR_PRESETS.length; i++) {
      if (COLOR_PRESETS[i][0] === hex) return COLOR_PRESETS[i][1];
    }
    return hex;
  }

  // 预设色块按需生成：色板只在 COLOR_PRESETS 里定义一处，
  // 不用在 HTML 和 JS 里各写一份（那正是「两份数据对不上」的老毛病）。
  function buildColorGrid() {
    for (var i = 0; i < COLOR_PRESETS.length; i++) {
      var hex = COLOR_PRESETS[i][0];
      var b = document.createElement("button");
      b.type = "button";
      b.className = "color-dot";
      b.dataset.color = hex;
      b.setAttribute("aria-label", COLOR_PRESETS[i][1]);
      var dot = document.createElement("span");
      dot.style.background = hex;
      b.appendChild(dot);
      colorGrid.appendChild(b);
    }
  }

  function syncColorUI() {
    colorSwatch.style.background = nameColor;
    colorBtn.title = "名字颜色：" + colorLabel(nameColor);
    colorCustom.value = nameColor;
    var dots = colorGrid.querySelectorAll(".color-dot");
    for (var i = 0; i < dots.length; i++) {
      // 哪个预设是当前色，用 aria-pressed 表达 —— 只靠描边颜色读屏读不到
      dots[i].setAttribute("aria-pressed",
        dots[i].dataset.color === nameColor ? "true" : "false");
    }
  }

  function setNameColor(v, persist) {
    var c = normalizeColor(v);
    if (!c) return;                       // 非法值直接忽略，不动当前颜色
    var changed = c !== nameColor;
    nameColor = c;
    settings.nameColor = c;
    applyNameColor();
    if (changed && persist !== false) saveSettings();
  }

  // ==================== 逐人颜色 ====================

  // 给某个人单独设色。hex 传 null / 非法值 = 清除这个人的单独颜色（回到跟随默认）。
  //
  // 「选了跟默认色一模一样的颜色」不写成单独设置 —— 否则名单里会攒一堆
  // 值等于默认色的废条目，而且「跟随默认」和「手动设成同色」在行为上没区别。
  function setNameColorFor(name, hex, persist) {
    if (!name) return;
    var c = hex == null ? null : normalizeColor(hex);
    if (c && c === nameColor) c = null;

    var before = customColorFor(name);
    if (c === before) return;             // 没变化就别写存储

    if (c) nameColors[name] = c;
    else delete nameColors[name];

    settings.nameColors = nameColors;
    repaintCards();
    syncNameColorRow(name);
    syncNameColorSummary();
    if (persist !== false) saveSettings();
  }

  function countCustomColors() {
    var n = 0;
    for (var k in nameColors) {
      if (Object.prototype.hasOwnProperty.call(nameColors, k)) n++;
    }
    return n;
  }

  // 名单里出现过的名字（去重）。重名的人共用同一个颜色 —— 键是名字，本来就是这样。
  function uniqueRoster() {
    var seen = {}, out = [];
    for (var i = 0; i < roster.length; i++) {
      var p = roster[i];
      if (seen[p.name]) continue;
      seen[p.name] = true;
      out.push(p);
    }
    return out;
  }

  function syncNameColorRow(name) {
    if (!nameColorList) return;
    var row = nameColorList.querySelector('[data-row-name="' + cssEscape(name) + '"]');
    if (!row) return;
    var input = row.querySelector(".nc-input");
    var reset = row.querySelector(".nc-reset");
    var c = customColorFor(name);
    if (input) {
      input.value = c || nameColor;
      input.style.setProperty("--nc-swatch", c || nameColor);
    }
    if (reset) reset.hidden = !c;
    row.classList.toggle("is-custom", Boolean(c));
    if (c) row.style.setProperty("--nc-row-color", c);
    else row.style.removeProperty("--nc-row-color");
  }

  function syncNameColorSummary() {
    if (!nameColorSummary) return;
    var n = countCustomColors();
    nameColorSummary.textContent = n ? ("已单独设色 " + n + " 人") : "都跟随默认色";
    if (nameColorResetAll) nameColorResetAll.disabled = n === 0;
  }

  // 用于把名字安全地塞进属性选择器：CSS.escape 在老环境没有，退回手工转义
  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  function renderNameColorList() {
    if (!nameColorList) return;
    nameColorList.textContent = "";
    var list = uniqueRoster();

    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "nc-empty";
      empty.textContent = "名单是空的，先回「抽签」页设置名单";
      nameColorList.appendChild(empty);
      return;
    }

    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var c = customColorFor(p.name);

      var row = document.createElement("li");
      row.className = "nc-row" + (c ? " is-custom" : "");
      row.setAttribute("data-row-name", p.name);
      if (c) row.style.setProperty("--nc-row-color", c);

      var nameEl = document.createElement("span");
      nameEl.className = "nc-name";
      nameEl.textContent = p.name;

      row.appendChild(nameEl);

      // 学号模式下把学号也显示出来，否则同名/相似名不好分辨
      if (settings.mode === "student" && p.id) {
        var idEl = document.createElement("span");
        idEl.className = "nc-id";
        idEl.textContent = p.id;
        row.appendChild(idEl);
      }

      var input = document.createElement("input");
      input.type = "color";
      input.className = "nc-input";
      input.value = c || nameColor;
      input.style.setProperty("--nc-swatch", c || nameColor);
      input.setAttribute("aria-label", p.name + " 的名字颜色");
      row.appendChild(input);

      var reset = document.createElement("button");
      reset.type = "button";
      reset.className = "nc-reset";
      reset.textContent = "跟随默认";
      reset.hidden = !c;
      reset.setAttribute("aria-label", "把 " + p.name + " 恢复成默认颜色");
      row.appendChild(reset);

      frag.appendChild(row);
    }
    nameColorList.appendChild(frag);
    syncNameColorSummary();
  }

  function openNameColorModal() {
    renderNameColorList();
    nameColorModal.hidden = false;
    activeModal = nameColorModal;
    syncModalInert();
    if (nameColorClose) nameColorClose.focus();
  }

  function closeNameColorModal(restoreFocus) {
    if (activeModal !== nameColorModal) return;
    nameColorModal.hidden = true;
    activeModal = null;
    syncModalInert();
    // 焦点还给顶部的「颜色」按钮，而不是弹层入口 #nameColorBtn ——
    // 后者在已经收起来的下拉面板里，对隐藏元素调 focus() 是无效的，焦点会掉到 body。
    if (restoreFocus !== false) colorBtn.focus();
  }

  // 一次挡掉「焦点遍历 + 指针事件 + 无障碍树」三件事。
  // 靠 body 的直接子元素来扫，所以弹层必须是 body 的子元素（和主站一样）。
  function syncModalInert() {
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].inert = Boolean(activeModal) && kids[i] !== activeModal;
    }
  }

  function openColorPop() {
    colorPop.hidden = false;
    colorBtn.setAttribute("aria-expanded", "true");
    colorPopOpen = true;
  }

  // 下拉面板不是模态：不遮罩、不锁焦点，所以不需要 inert
  // （和主站的 .admin-panel 同类，判据见项目约定）。
  function closeColorPop(restoreFocus) {
    if (!colorPopOpen) return;
    colorPop.hidden = true;
    colorBtn.setAttribute("aria-expanded", "false");
    colorPopOpen = false;
    if (restoreFocus) colorBtn.focus();
  }

  // ==================== 事件 ====================

  openBtn.addEventListener("click", startSpin);

  soundBtn.addEventListener("click", function () {
    soundOn = !soundOn;
    try { localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off"); } catch (e) { /* ignore */ }
    syncSoundButton();
    if (!soundOn && "speechSynthesis" in window) window.speechSynthesis.cancel();
    if (soundOn) { unlockAudio(); playTick(); }
  });

  modeChip.addEventListener("click", function () {
    if (spinning) return;
    settings.mode = settings.mode === "student" ? "fun" : "student";
    saveSettings();
    refreshRoster();
  });
  modeChip.title = "点击切换趣味模式 / 学号+名字模式";

  colorBtn.addEventListener("click", function () {
    if (colorPopOpen) closeColorPop(false);
    else openColorPop();
  });

  colorGrid.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target.closest(".color-dot") : null;
    if (t && t.dataset.color) setNameColor(t.dataset.color);
  });

  // 系统取色器拖的时候就会连发 input，实时预览；松手才落盘由 change 收尾
  colorCustom.addEventListener("input", function () { setNameColor(colorCustom.value); });

  // 点面板外面关掉。面板自己的点击会先冒泡到这里，
  // 所以要显式排除「点在面板里」和「点在触发按钮上」两种情况。
  document.addEventListener("click", function (e) {
    if (!colorPopOpen) return;
    if (colorPop.contains(e.target) || colorBtn.contains(e.target)) return;
    closeColorPop(false);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && colorPopOpen) {
      e.preventDefault();
      closeColorPop(true);
    }
  });

  // ---- 逐人颜色弹层 ----

  nameColorBtn.addEventListener("click", function () {
    // 弹层和颜色下拉是两个入口，同时开着会互相盖住
    if (colorPopOpen) closeColorPop(false);
    openNameColorModal();
  });

  nameColorClose.addEventListener("click", function () { closeNameColorModal(); });

  // 点遮罩空白处关掉（点内容区不关）
  nameColorModal.addEventListener("click", function (e) {
    if (e.target === nameColorModal) closeNameColorModal();
  });

  // 用事件委托，不给几十个取色器各绑一个监听。
  // 注意：**这里不能整段重建列表** —— 系统取色器拖着的时候会连发 input，
  // 一重建就把正在拖的那个控件换掉了，拖动手感直接断掉。所以只改这一行。
  nameColorList.addEventListener("input", function (e) {
    var input = e.target;
    if (!input || !input.classList || !input.classList.contains("nc-input")) return;
    var row = input.closest(".nc-row");
    if (!row) return;
    setNameColorFor(row.getAttribute("data-row-name"), input.value);
  });

  nameColorList.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(".nc-reset") : null;
    if (!btn) return;
    var row = btn.closest(".nc-row");
    if (!row) return;
    setNameColorFor(row.getAttribute("data-row-name"), null);
  });

  nameColorResetAll.addEventListener("click", function () {
    nameColors = {};
    settings.nameColors = nameColors;
    repaintCards();
    renderNameColorList();
    saveSettings();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && activeModal) {
      e.preventDefault();
      closeNameColorModal();
    }
  });

  clearHistoryBtn.addEventListener("click", function () {
    history = [];
    saveHistory();
    renderHistory();
  });

  document.addEventListener("keydown", function (e) {
    var key = e.key;
    if (key !== " " && key !== "Spacebar" && key !== "Enter") return;
    // 弹层开着的时候，空格绝不该开始点名。弹层里除了 input/button 还有别的可聚焦元素
    // （比如列表本身），只靠下面那几个 tag 判断挡不住。
    if (activeModal) return;
    var t = e.target;
    var tag = (t && t.tagName) || "";
    // 输入框和按钮交回原生行为：按钮上按空格＝激活该按钮（含「开始点名」）
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        tag === "BUTTON" || (t && t.isContentEditable)) return;
    e.preventDefault();
    if (!spinning) startSpin();
  });

  document.addEventListener("pointerdown", unlockAudio, { once: true });
  document.addEventListener("keydown", unlockAudio, { once: true });

  // resize 会连发几十次，每次都 measure() 就是几十次强制布局。合并到一帧里做一次。
  window.addEventListener("resize", function () {
    if (spinning || resizeRaf) return;
    resizeRaf = requestAnimationFrame(function () {
      resizeRaf = 0;
      if (spinning) return;
      measure();
      applyCards(currentCards);
    });
  });

  // ==================== 启动 ====================

  openBtn.disabled = true;
  soundOn = loadSoundPref();
  syncSoundButton();
  // 先用默认色把变量写上去（避免首帧没有颜色），等设置读回来后再覆盖一次
  buildColorGrid();
  applyNameColor();

  if ("speechSynthesis" in window) {
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = refreshVoices;
  }

  Promise.all([loadBaseNames(), loadSettings()]).then(function (res) {
    baseNames = res[0];
    var saved = res[1];

    if (saved && typeof saved === "object") {
      if (typeof saved.mode === "string") settings.mode = saved.mode;
      else if (saved.student && saved.student.enabled) settings.mode = "student"; // 兼容旧数据
      if (typeof saved.funNames === "string") settings.funNames = saved.funNames;
      if (typeof saved.studentNames === "string") settings.studentNames = saved.studentNames;
      if (typeof saved.namesText === "string") settings.funNames = saved.namesText; // 兼容旧数据
      if (typeof saved.announce === "boolean") settings.announce = saved.announce;
      // 颜色要过一遍校验：存储里的值可能是手改的、也可能是旧版本留下的
      var savedColor = normalizeColor(saved.nameColor);
      if (savedColor) { nameColor = savedColor; settings.nameColor = savedColor; }
      // 逐人颜色同理，而且它是个对象 —— 每个键值都要单独验，非法条目直接丢掉，
      // 不能让任意字符串漏进 CSS 变量。
      nameColors = sanitizeNameColors(saved.nameColors);
      settings.nameColors = nameColors;
      if (saved.student && typeof saved.student === "object") {
        settings.student = Object.assign({}, settings.student, saved.student);
      }
    }

    applyNameColor();     // 用读回来的颜色覆盖掉启动时的默认色
    history = loadHistory();
    renderHistory();
    refreshRoster();
  });

  // 防止关闭页面时还在跑的动画留个悬空定时器
  window.addEventListener("pagehide", function () {
    if (rafId) cancelAnimationFrame(rafId);
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    if (speechTimer) clearTimeout(speechTimer);
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  });
})();
