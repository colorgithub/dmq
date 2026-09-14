/* CS 点名器 —— 逻辑层
 *
 * 视觉与动效参数来自 CS2Deck 开箱器（cs2deck.com/zh-CN/tools/case-opener）逆向：
 *   - 滚轮 62 张卡，中奖卡固定在第 46 张（0 基）
 *   - 缓动 cubic-bezier(0.08, 0.72, 0.05, 1)，主滚动 5200ms，另有 160ms 起手
 *   - 落点公式：center - (46 * cardW + cardW * (0.18 + 0.64 * rand))
 *   - 稀有度中文名 / 官方色 / 真实掉率均取自该站 bundle
 *
 * 与主站共用：localStorage 键 lucky_settings_v1（模式、名单、学号规则）
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

  // CS2 稀有度：中文名 + 官方色 + 掉率（由稀到常见）
  var TIERS = [
    { key: "contraband", cn: "违禁", color: "#d4a848", p: 0.0026 },
    { key: "covert", cn: "隐秘", color: "#eb4b4b", p: 0.0064 },
    { key: "classified", cn: "保密", color: "#d32ce6", p: 0.0320 },
    { key: "restricted", cn: "受限", color: "#8847ff", p: 0.1602 },
    { key: "milspec", cn: "军规级", color: "#4b69ff", p: 0.7988 }
  ];
  var TIER_BY_KEY = {};
  TIERS.forEach(function (t) { TIER_BY_KEY[t.key] = t; });

  // 揭晓音阶（由稀到常见，越稀有音阶越长）
  var FANFARE = {
    contraband: [523.25, 659.25, 783.99, 1046.50, 1318.51],
    covert: [523.25, 659.25, 783.99, 1046.50],
    classified: [440.00, 554.37, 659.25],
    restricted: [392.00, 523.25],
    milspec: [392.00]
  };

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

  // ==================== 状态 ====================

  var baseNames = [];              // 内置名单（JSON 优先，script 兜底）
  var roster = [];                 // 当前生效名单 [{id, name, tier}]
  var history = [];                // [{name, id, tier}]
  var winnerCards = [];            // 本轮中奖卡元素
  var spinning = false;
  var soundOn = true;
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
    effects: {},
    student: { start: 1, pad: "", prefix: "", suffix: "" }
  };

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

  // ==================== 稀有度 ====================

  // FNV-1a：让同一个人永远拿到同一张卡（颜色稳定，滚轮观感才不花）
  function hashUnit(str) {
    var h = 2166136261;
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 1000000) / 1000000;
  }

  function tierForName(name) {
    var r = hashUnit(name);
    var acc = 0;
    for (var i = 0; i < TIERS.length; i++) {
      acc += TIERS[i].p;
      if (r < acc) return TIERS[i];
    }
    return TIERS[TIERS.length - 1];
  }

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
        return { id: r.id, name: r.name, tier: tierForName(r.name) };
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
      list.push({ id: null, name: t, tier: tierForName(t) });
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

  function saveSettings() {
    var data = JSON.parse(JSON.stringify(settings));
    try {
      var bridge = window.desktopBall && window.desktopBall.settings;
      if (bridge && bridge.save) { bridge.save(data); return; }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    } catch (e) { /* ignore */ }
  }

  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      var arr = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (h) {
        return h && typeof h.name === "string" && TIER_BY_KEY[h.tier];
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

  function blip(ctx, freq, when, dur, gain, type) {
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = type || "triangle";
    osc.frequency.setValueAtTime(freq, when);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(when);
    osc.stop(when + dur + 0.03);
  }

  function playTick() {
    if (!soundOn) return;
    var ctx = ac();
    if (!ctx) return;
    blip(ctx, 1400 + Math.random() * 500, ctx.currentTime, 0.04, 0.045, "square");
  }

  function playReveal(tier) {
    if (!soundOn) return;
    var ctx = ac();
    if (!ctx) return;
    var notes = FANFARE[tier.key] || [392];
    var t0 = ctx.currentTime + 0.02;
    var step = 0.085;
    for (var i = 0; i < notes.length; i++) {
      blip(ctx, notes[i], t0 + i * step, 0.5, 0.10, "triangle");
      blip(ctx, notes[i] * 2, t0 + i * step, 0.32, 0.03, "sine");
    }
    if (tier.key === "covert" || tier.key === "contraband") {
      blip(ctx, notes[0] / 2, t0, 1.4, 0.075, "sine");
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

  // 卡片池：两条滚轮各 62 张，抽签时只改文字与稀有度色，不重建 DOM。
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
    return card;
  }

  function updateCard(card, item) {
    card.style.setProperty("--rarity", item.tier.color);
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
      var tier = TIER_BY_KEY[h.tier] || TIERS[TIERS.length - 1];
      var li = document.createElement("li");
      li.className = "history-item";
      li.style.setProperty("--rarity", tier.color);

      var dot = document.createElement("span");
      dot.className = "history-dot";

      var text = document.createElement("span");
      text.textContent = (h.id ? h.id + " " : "") + h.name;

      li.appendChild(dot);
      li.appendChild(text);
      li.title = tier.cn;
      historyList.appendChild(li);
    });
    historyEmpty.hidden = history.length > 0;
  }

  function pushHistory(winner) {
    history.unshift({ name: winner.name, id: winner.id, tier: winner.tier.key });
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    saveHistory();
    renderHistory();
  }

  function showResult(winner) {
    resultTag.textContent = (winner.id ? winner.id + " · " : "") + winner.tier.cn;
    resultName.textContent = winner.name;
    resultEl.hidden = false;
    // 重放弹出动画
    resultCard.style.animation = "none";
    void resultCard.offsetWidth;
    resultCard.style.animation = "";
    // 窗口矮的时候结果卡可能落在折叠线以下，轻轻滚一点让它露出来
    if (typeof resultEl.scrollIntoView === "function") {
      try {
        resultEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } catch (e) {
        resultEl.scrollIntoView(false);
      }
    }
  }

  // ==================== 点名主流程 ====================

  function startSpin() {
    if (spinning || !roster.length) return;
    spinning = true;

    // 均匀抽取：名单在 buildRoster 里已去重，这里是唯一的抽取点，
    // 每人概率严格相等（1 / roster.length），没有任何权重。
    // 下面的稀有度只是抽完之后贴上去的展示标签，不参与抽取，也不影响概率。
    var winner = roster[Math.floor(Math.random() * roster.length)];

    clearWinnerHighlight();
    fillReels(winner);
    // 卡宽只在断点变化时才变，已经量过就不必再量（避免每次抽签强制一次布局）
    if (!metrics.valid) measure();

    var startCards = 0.5;
    var endCards = WINNER_INDEX + LAND_MIN + LAND_SPAN * Math.random();

    applyCards(startCards);

    var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
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
    root.style.setProperty("--win-color", winner.tier.color);

    showResult(winner);
    setStatus("★ " + winner.tier.cn + " ★", "is-win");
    // 状态条只报稀有度，人名单独播给屏幕阅读器
    if (srAnnounce) {
      srAnnounce.textContent = "抽中 " + (winner.id ? winner.id + " " : "") + winner.name + "，" + winner.tier.cn;
    }

    openBtn.disabled = false;
    openBtnLabel.textContent = "再来一次";

    pushHistory(winner);
    playReveal(winner.tier);
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

  clearHistoryBtn.addEventListener("click", function () {
    history = [];
    saveHistory();
    renderHistory();
  });

  document.addEventListener("keydown", function (e) {
    var key = e.key;
    if (key !== " " && key !== "Spacebar" && key !== "Enter") return;
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
      if (saved.student && typeof saved.student === "object") {
        settings.student = Object.assign({}, settings.student, saved.student);
      }
    }

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
