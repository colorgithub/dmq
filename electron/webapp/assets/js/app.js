/**
 * 谁是幸运儿 - 主逻辑
 */

// ---------- 基础数据 ----------
function normalizeNames(data) {
  const result = [];
  const walk = (value) => {
    if (typeof value === "string") {
      const t = value.trim();
      if (t) result.push(t);
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      result.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(data);
  return [...new Set(result)];
}

let names = (typeof NAMES_DATA !== "undefined" && Array.isArray(NAMES_DATA))
  ? NAMES_DATA.map(v => String(v).trim()).filter(Boolean)
  : [];
let defaultNames = [...names];

let effectsByName = (typeof EFFECTS_DATA !== "undefined" && EFFECTS_DATA && typeof EFFECTS_DATA === "object")
  ? EFFECTS_DATA
  : {};
let defaultEffects = {};

const body = document.body;
const nameDisplay = document.getElementById("nameDisplay");
const startBtn = document.getElementById("startBtn");
const speedControl = document.getElementById("speedControl");
const musicControl = document.getElementById("musicControl");
const adminToggle = document.getElementById("adminToggle");
const adminPanel = document.getElementById("adminPanel");
const adminNameSelect = document.getElementById("adminNameSelect");
const adminApplyBtn = document.getElementById("adminApplyBtn");
const adminExitBtn = document.getElementById("adminExitBtn");
const audioIndicator = document.getElementById("audioIndicator");
const effectAudio = document.getElementById("effectAudio");

const settingsToggle = document.getElementById("settingsToggle");
const settingsOverlay = document.getElementById("settingsOverlay");
const settingsClose = document.getElementById("settingsClose");
const settingsSave = document.getElementById("settingsSave");
const settingsFunNames = document.getElementById("settingsFunNames");
const funCount = document.getElementById("funCount");
const funSave = document.getElementById("funSave");
const funReset = document.getElementById("funReset");
const settingsStudentNames = document.getElementById("settingsStudentNames");
const studentListCount = document.getElementById("studentListCount");
const studentNamesSave = document.getElementById("studentNamesSave");
const studentNamesReset = document.getElementById("studentNamesReset");
const studentStart = document.getElementById("studentStart");
const studentPad = document.getElementById("studentPad");
const studentPrefix = document.getElementById("studentPrefix");
const studentSuffix = document.getElementById("studentSuffix");
const studentCount = document.getElementById("studentCount");
const modeBadge = document.getElementById("modeBadge");
const announceToggle = document.getElementById("announceToggle");
const effectsToggle = document.getElementById("effectsToggle");
const effectsOverlay = document.getElementById("effectsOverlay");
const effectsClose = document.getElementById("effectsClose");
const effectsList = document.getElementById("effectsList");
const effectsAdd = document.getElementById("effectsAdd");
const effectsReset = document.getElementById("effectsReset");
const effectsSave = document.getElementById("effectsSave");

const bodyClasses = ["black-bg", "color-bg", "grape-bg", "li-bg", "media-bg"];
let running = false;
let timer = null;
let muted = false;
let isAdmin = false;

const SETTINGS_KEY = "lucky_settings_v1";
// mode: "fun" 趣味模式 | "student" 学号+名字模式
// 两个模式各自独立名单；"" 表示使用内置名单
let settings = {
  mode: "fun",
  funNames: "",
  studentNames: "",
  announce: true,
  effects: {},
  student: { start: 1, pad: "", prefix: "", suffix: "" }
};

function sliderToInterval(value) {
  const min = Number(speedControl.min);
  const max = Number(speedControl.max);
  return max + min - Number(value);
}
let intervalMs = sliderToInterval(speedControl.value);

const speakerSvg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 9V15H7L12 20V4L7 9H3Z" fill="#ff5f8f"/><path d="M16.5 12C16.5 10.23 15.48 8.71 14 7.97V16.02C15.48 15.29 16.5 13.77 16.5 12Z" fill="#ff5f8f"/><path d="M14 3.23V5.29C16.89 6.15 19 8.83 19 12C19 15.17 16.89 17.85 14 18.71V20.77C18.01 19.86 21 16.28 21 12C21 7.72 18.01 4.14 14 3.23Z" fill="#ff5f8f"/></svg>';
const mutedSvg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 9V15H7L12 20V4L7 9H3Z" fill="#ff5f8f"/><path d="M16 8L20 16M20 8L16 16" stroke="#ff5f8f" stroke-width="2" stroke-linecap="round"/></svg>';

// ========== 模式 / 名单 / 学号 ==========

function isStudentMode() {
  return settings.mode === "student";
}

function parseRosterLine(line) {
  const t = String(line || "").trim();
  if (!t) return null;
  const m = t.match(/^(\d+)\s+(.+)$/);
  if (m) return { id: m[1], name: m[2].trim() };
  return { id: null, name: t };
}

// 名单解析并不便宜（split + 逐行正则 + 补零 + 去重），而滚动最快每 5ms 就要取一次
// 随机项 —— 按 5ms 算就是每秒 200 次解析、学号模式下每秒上万次正则匹配和对象分配。
// 这里把解析结果缓存住，只有设置真的变了（见 refreshRoster / switchMode）才重算。
// 缓存的数组是共享的，调用方只读不改（getRandomItem 取下标、currentAdminItems 遍历）。
let funListCache = null;
let studentRosterCache = null;

function invalidateRosterCache() {
  funListCache = null;
  studentRosterCache = null;
}

// 趣味模式：纯名字列表
function getFunList() {
  if (funListCache) return funListCache;
  const src = (settings.funNames || "").trim()
    ? settings.funNames.split(/\r?\n/)
    : (defaultNames.length ? defaultNames : names);
  const out = [];
  src.forEach((line) => {
    const t = String(line || "").trim();
    if (t) out.push(t);
  });
  funListCache = [...new Set(out)];
  return funListCache;
}

// 学号+名字模式：id + name
function getStudentRoster() {
  if (studentRosterCache) return studentRosterCache;
  const st = settings.student || {};
  let counter = (typeof st.start === "number" && Number.isFinite(st.start)) ? st.start : 1;
  const pad = parseInt(st.pad, 10);
  const src = (settings.studentNames || "").trim()
    ? settings.studentNames.split(/\r?\n/)
    : (defaultNames.length ? defaultNames : names);
  const list = [];
  src.forEach((line) => {
    const p = parseRosterLine(line);
    if (!p) return;
    let id = p.id;
    if (id == null) {
      let num = String(counter);
      if (pad > 0) num = num.padStart(pad, "0");
      id = (st.prefix || "") + num + (st.suffix || "");
    }
    list.push({ id: String(id), name: p.name });
    counter += 1;
  });
  studentRosterCache = list;
  return studentRosterCache;
}

function currentAdminItems() {
  if (isStudentMode()) {
    return getStudentRoster().map((r) => (r.name ? (r.id + "  " + r.name) : r.id));
  }
  return getFunList();
}

function getRandomItem() {
  if (isStudentMode()) {
    const roster = getStudentRoster();
    if (!roster.length) return "请先设置名单";
    const e = roster[Math.floor(Math.random() * roster.length)];
    return e.name ? (e.id + "  " + e.name) : e.id;
  }
  const list = getFunList();
  if (!list.length) return "名单为空";
  return list[Math.floor(Math.random() * list.length)];
}

function itemEffectKey(text) {
  if (!isStudentMode()) return text;
  const parts = String(text).split(/\s+/);
  return parts.length >= 2 ? parts.slice(1).join(" ") : text;
}

// 主站的核心输出是 #nameDisplay，但滚动时它每秒要变上百次，直接给它加
// aria-live 会把屏幕阅读器刷爆。所以只在出结果时往这个独立区域写一次。
function announceResult(text) {
  const el = document.getElementById("srAnnounce");
  if (!el) return;
  const msg = String(text || "");
  if (el.textContent === msg) {
    // 连着抽到同一个人时，文本没变化不会触发播报，先清空再写
    el.textContent = "";
    setTimeout(() => { el.textContent = msg; }, 30);
  } else {
    el.textContent = msg;
  }
}

let speechVoices = [];
let activeUtterance = null;
let speechQueueTimer = null;

function refreshSpeechVoices() {
  if (!('speechSynthesis' in window)) return;
  speechVoices = window.speechSynthesis.getVoices().filter(Boolean);
}

function pickChineseVoice() {
  const zh = speechVoices.filter((v) => v.lang && v.lang.toLowerCase().indexOf('zh') === 0);
  return zh.find((v) => v.localService !== false) || zh[0] || null;
}

function speakName(text) {
  if (!settings.announce) return;
  try {
    if (!("speechSynthesis" in window)) return;
    const name = itemEffectKey(String(text || ""));
    if (!name) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    if (speechQueueTimer) clearTimeout(speechQueueTimer);
    speechQueueTimer = setTimeout(() => {
      refreshSpeechVoices();
      const u = new SpeechSynthesisUtterance(name);
      u.lang = "zh-CN";
      const zh = pickChineseVoice();
      if (zh) u.voice = zh;
      u.rate = 0.95;
      u.volume = 1;
      u.pitch = 1;
      activeUtterance = u;
      u.onend = u.onerror = () => {
        if (activeUtterance === u) activeUtterance = null;
      };
      synth.cancel();
      synth.speak(u);
    }, (synth.speaking || synth.pending) ? 120 : 0);
  } catch (e) {
    console.warn("speak failed", e);
  }
}

// ========== 设置持久化 ==========

async function loadSettings() {
  try {
    if (window.desktopBall && window.desktopBall.settings && window.desktopBall.settings.load) {
      const s = await window.desktopBall.settings.load();
      if (s && typeof s === "object") return s;
    }
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn("load settings failed", e);
  }
  return null;
}

async function saveSettings() {
  const data = JSON.parse(JSON.stringify(settings));
  try {
    if (window.desktopBall && window.desktopBall.settings && window.desktopBall.settings.save) {
      await window.desktopBall.settings.save(data);
      return;
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("save settings failed", e);
  }
}

// ========== 设置面板 ==========

// aria-modal="true" 只是「声明」弹层之外不可交互 —— 浏览器不会替我们实现它。
// 实测（弹层开着连按 25 次 Tab）有 8 次焦点跑到了弹层背后：modeBadge、speedControl、
// startBtn、csToggle、musicControl、adminToggle、settingsToggle、effectsToggle。
// 也就是说键盘用户能在设置面板开着的时候按回车把签抽了，甚至跳走到 CS 点名页。
//
// 所以打开弹层时把其它顶层节点设为 inert：Chromium 原生支持，一次同时挡掉
// 焦点遍历、指针事件与无障碍树 —— 正好是 aria-modal="true" 承诺的那三件事。
//
// 用显式的 activeModal 记录当前弹层，而不是从 .show class 反推「最上面那个」：
// 后者在两个弹层同时开着时会选错（按 DOM 顺序取最后一个），反而把真正在用的
// 那个弹层变成 inert。UI 上虽然点不出「两个同时开」，但不值得留这个隐患。
let activeModal = null;

function syncModalInert() {
  const children = document.body.children;
  for (let i = 0; i < children.length; i++) {
    children[i].inert = Boolean(activeModal) && children[i] !== activeModal;
  }
}

function openSettings() {
  settingsFunNames.value = (settings.funNames || "").trim()
    ? settings.funNames
    : (defaultNames.length ? defaultNames.join("\n") : names.join("\n"));
  settingsStudentNames.value = (settings.studentNames || "").trim()
    ? settings.studentNames
    : (defaultNames.length ? defaultNames.join("\n") : names.join("\n"));
  const st = settings.student;
  studentStart.value = (typeof st.start === "number") ? st.start : 1;
  studentPad.value = st.pad || "";
  studentPrefix.value = st.prefix || "";
  studentSuffix.value = st.suffix || "";
  announceToggle.checked = !!settings.announce;
  updateCounts();
  settingsOverlay.classList.add("show");
  // 顺序很重要：先把背景设为 inert（这会让当前焦点失效），再把焦点移进弹层
  activeModal = settingsOverlay;
  syncModalInert();
  if (settingsClose) settingsClose.focus();
}

function closeSettings() {
  settingsOverlay.classList.remove("show");
  if (activeModal === settingsOverlay) activeModal = null;
  syncModalInert();
  if (settingsToggle) settingsToggle.focus();
}

function updateCounts() {
  if (funCount) {
    funCount.textContent = (settingsFunNames.value || "").split(/\r?\n/).filter((l) => l.trim()).length + " 项";
  }
  if (studentListCount) {
    studentListCount.textContent = (settingsStudentNames.value || "").split(/\r?\n/).filter((l) => l.trim()).length + " 项";
  }
  if (studentCount) {
    if (!isStudentMode()) {
      studentCount.textContent = "趣味模式生效中";
    } else {
      const n = (settingsStudentNames.value || "").split(/\r?\n/).filter((l) => l.trim()).length;
      studentCount.textContent = n ? (n + " 个学号") : "暂无名单";
    }
  }
}

function updateModeUI() {
  if (!modeBadge) return;
  modeBadge.textContent = isStudentMode() ? "学号+名字模式" : "趣味模式";
  modeBadge.classList.toggle("student", isStudentMode());
}

function refreshRoster() {
  // 设置/名单变了，缓存的解析结果作废
  invalidateRosterCache();
  refreshAdminNameOptions();
  updateModeUI();
  updateCounts();
}

// ========== 特效管理 ==========

const THEME_OPTIONS = [
  { value: "", label: "无主题" },
  { value: "black-bg", label: "黑底" },
  { value: "color-bg", label: "彩底" },
  { value: "grape-bg", label: "葡萄" },
  { value: "li-bg", label: "白底" }
];

function getActiveEffects() {
  const se = settings.effects;
  if (se && typeof se === "object" && Object.keys(se).length > 0) return se;
  return defaultEffects;
}

function makeEffectRow(name, eff) {
  const data = eff || {};
  const row = document.createElement("div");
  row.className = "effect-row";

  const head = document.createElement("div");
  head.className = "effect-row-head";

  // 这些控件是动态生成的，没有 <label> 可关联，placeholder 也不能当无障碍名字用，
  // 所以每个都显式给 aria-label
  const nameInput = document.createElement("input");
  nameInput.className = "eff-name";
  nameInput.placeholder = "特效名（对应抽中的名字）";
  nameInput.value = name;
  nameInput.setAttribute("aria-label", "特效名（对应抽中的名字）");

  const themeSel = document.createElement("select");
  themeSel.className = "eff-theme";
  themeSel.setAttribute("aria-label", "主题");
  THEME_OPTIONS.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    themeSel.appendChild(opt);
  });
  themeSel.value = data.themeClass || "";

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "eff-del";
  delBtn.textContent = "✕";
  delBtn.title = "删除";
  delBtn.setAttribute("aria-label", "删除这个特效");
  delBtn.addEventListener("click", () => row.remove());

  head.appendChild(nameInput);
  head.appendChild(themeSel);
  head.appendChild(delBtn);

  const mk = (cls, ph, val, label) => {
    const i = document.createElement("input");
    i.className = cls;
    i.placeholder = ph;
    i.value = val || "";
    i.setAttribute("aria-label", label);
    return i;
  };
  const fields = document.createElement("div");
  fields.className = "effect-fields";
  const bgInput = mk("eff-bg", "背景图路径，如 assets/img/01.png", data.backgroundImage, "背景图路径");
  const audioInput = mk("eff-audio", "音频路径，如 assets/audio/xn.mp3", data.audioSrc, "音频路径");
  const atextInput = mk("eff-atext", "提示文字，如 正在播放:", data.audioText, "播放时的提示文字");
  const loopLabel = document.createElement("label");
  const loopInput = document.createElement("input");
  loopInput.type = "checkbox";
  loopInput.className = "eff-loop";
  loopInput.checked = !!data.audioLoop;
  loopLabel.appendChild(loopInput);
  loopLabel.appendChild(document.createTextNode(" 循环"));
  fields.appendChild(bgInput);
  fields.appendChild(audioInput);
  fields.appendChild(atextInput);
  fields.appendChild(loopLabel);

  row.appendChild(head);
  row.appendChild(fields);

  // 自定义背景色（纯色 / 渐变）
  const colorToggle = document.createElement("label");
  colorToggle.className = "effect-color-toggle";
  const customInput = document.createElement("input");
  customInput.type = "checkbox";
  customInput.className = "eff-custom";
  customInput.checked = !!data.bgColor || !!data.bgColor2;
  colorToggle.appendChild(customInput);
  colorToggle.appendChild(document.createTextNode(" 自定义背景色"));

  const colorBox = document.createElement("div");
  colorBox.className = "effect-colors";
  const c1 = document.createElement("input");
  c1.type = "color";
  c1.className = "eff-bgcolor";
  c1.value = data.bgColor || "#ef476f";
  c1.setAttribute("aria-label", "背景色");
  const c2 = document.createElement("input");
  c2.type = "color";
  c2.className = "eff-bgcolor2";
  c2.value = data.bgColor2 || "#ffd166";
  c2.setAttribute("aria-label", "渐变第二色");
  const gradToggle = document.createElement("label");
  gradToggle.className = "effect-grad-toggle";
  const gradInput = document.createElement("input");
  gradInput.type = "checkbox";
  gradInput.className = "eff-gradient";
  gradInput.checked = !!data.bgColor2;
  gradToggle.appendChild(gradInput);
  gradToggle.appendChild(document.createTextNode(" 渐变"));

  const c1Label = document.createElement("span");
  c1Label.textContent = "背景色 ";
  c1Label.appendChild(c1);
  const c2Label = document.createElement("span");
  c2Label.textContent = "渐变第二色 ";
  c2Label.appendChild(c2);
  colorBox.appendChild(c1Label);
  colorBox.appendChild(c2Label);
  colorBox.appendChild(gradToggle);

  const syncColors = () => {
    colorBox.style.display = customInput.checked ? "flex" : "none";
  };
  customInput.addEventListener("change", syncColors);
  syncColors();

  row.appendChild(colorToggle);
  row.appendChild(colorBox);
  return row;
}

function renderEffects() {
  effectsList.innerHTML = "";
  const map = getActiveEffects();
  let any = false;
  Object.keys(map).forEach((name) => {
    effectsList.appendChild(makeEffectRow(name, map[name]));
    any = true;
  });
  if (!any) {
    const empty = document.createElement("p");
    empty.className = "settings-hint";
    empty.textContent = "暂无自定义特效，点击「新增特效」添加。";
    effectsList.appendChild(empty);
  }
}

function collectEffects() {
  const map = {};
  effectsList.querySelectorAll(".effect-row").forEach((row) => {
    const name = row.querySelector(".eff-name").value.trim();
    if (!name) return;
    const theme = row.querySelector(".eff-theme").value;
    const bg = row.querySelector(".eff-bg").value.trim();
    const audio = row.querySelector(".eff-audio").value.trim();
    const atext = row.querySelector(".eff-atext").value.trim();
    const loop = row.querySelector(".eff-loop").checked;
    const eff = {};
    if (theme) eff.themeClass = theme;
    if (bg) eff.backgroundImage = bg;
    if (audio) eff.audioSrc = audio;
    if (atext) eff.audioText = atext;
    if (loop) eff.audioLoop = true;
    if (row.querySelector(".eff-custom").checked) {
      eff.bgColor = row.querySelector(".eff-bgcolor").value;
      if (row.querySelector(".eff-gradient").checked) {
        eff.bgColor2 = row.querySelector(".eff-bgcolor2").value;
      }
    }
    map[name] = eff;
  });
  return map;
}

function openEffects() {
  renderEffects();
  effectsOverlay.classList.add("show");
  activeModal = effectsOverlay;
  syncModalInert();
  if (effectsClose) effectsClose.focus();
}

function closeEffects() {
  effectsOverlay.classList.remove("show");
  if (activeModal === effectsOverlay) activeModal = null;
  syncModalInert();
  if (effectsToggle) effectsToggle.focus();
}

effectsToggle.addEventListener("click", openEffects);
effectsClose.addEventListener("click", closeEffects);
effectsOverlay.addEventListener("click", (e) => {
  if (e.target === effectsOverlay) closeEffects();
});
effectsAdd.addEventListener("click", () => {
  effectsList.appendChild(makeEffectRow("", {}));
});
effectsReset.addEventListener("click", async () => {
  settings.effects = {};
  effectsByName = { ...defaultEffects };
  await saveSettings();
  renderEffects();
});
effectsSave.addEventListener("click", async () => {
  const map = collectEffects();
  settings.effects = map;
  effectsByName = { ...map };
  await saveSettings();
  renderEffects();
  closeEffects();
});

// ========== 数据加载 ==========

async function loadNames() {
  try {
    const response = await fetch("data/names.json", { cache: "no-store" });
    if (!response.ok) throw new Error("名单文件读取失败");
    const data = await response.json();
    const loadedNames = normalizeNames(data);
    if (loadedNames.length) {
      names = loadedNames;
    }
  } catch (e) {
    console.warn("fetch 名单失败，使用 script 加载的数据", e.message);
  }
}

async function loadEffects() {
  try {
    const response = await fetch("data/effects.json", { cache: "no-store" });
    if (!response.ok) throw new Error("特效文件读取失败");
    const data = await response.json();
    if (data && typeof data === "object" && !Array.isArray(data)) {
      effectsByName = data;
    }
  } catch (e) {
    console.warn("fetch 特效失败，使用 script 加载的数据", e.message);
  }
}

// ========== UI 控制 ==========

function showIndicator(text) {
  if (!text) {
    audioIndicator.style.display = "none";
    audioIndicator.textContent = "";
    return;
  }
  audioIndicator.textContent = text;
  audioIndicator.style.display = "block";
}

function refreshAdminNameOptions() {
  const current = adminNameSelect.value;
  adminNameSelect.innerHTML = "";
  const items = currentAdminItems();
  items.forEach((it) => {
    const option = document.createElement("option");
    option.value = it;
    option.textContent = it;
    adminNameSelect.appendChild(option);
  });
  if (current && items.includes(current)) {
    adminNameSelect.value = current;
  }
}

// 管理员面板是**非模态**下拉面板（没有遮罩），所以不用 inert / 焦点陷阱，
// 但四件事必须做齐，否则键盘用户基本用不了：
//   1) 按钮上同步 aria-expanded（否则屏幕阅读器不知道面板开没开）
//   2) 打开时把焦点移进面板 —— 面板在 DOM 里排在两个 toggle 之后，
//      不移焦点的话键盘用户要 Tab 3 次才进得去
//   3) Escape 能关
//   4) 点面板外面能关（否则只能再点一次那个小按钮）
function openAdminMode() {
  isAdmin = true;
  adminToggle.textContent = "退";
  adminToggle.title = "退出管理员";
  adminToggle.setAttribute("aria-expanded", "true");
  adminPanel.classList.add("show");
  refreshAdminNameOptions();
  if (adminNameSelect) adminNameSelect.focus();
}

// restoreFocus：只有键盘触发的关闭才把焦点还给按钮。
// 鼠标点到别处时抢焦点会让人莫名其妙（焦点突然跳到一个没碰过的按钮上）。
function exitAdminMode(restoreFocus) {
  if (!isAdmin) return;
  isAdmin = false;
  adminPanel.classList.remove("show");
  adminToggle.textContent = "管";
  adminToggle.title = "管理员模式";
  adminToggle.setAttribute("aria-expanded", "false");
  if (restoreFocus && adminToggle) adminToggle.focus();
}

function stopAllAudio() {
  effectAudio.pause();
  effectAudio.currentTime = 0;
}

function clearScene() {
  body.classList.remove(...bodyClasses);
  body.style.removeProperty("background-image");
  body.style.removeProperty("background");
  body.style.removeProperty("background-color");
  showIndicator("");
  stopAllAudio();
}

// ========== 核心逻辑 ==========

function applyEffect(name) {
  const effect = effectsByName[name];
  if (!effect) return;

  if (effect.bgColor) {
    if (effect.bgColor2) {
      body.style.background = `linear-gradient(160deg, ${effect.bgColor}, ${effect.bgColor2})`;
    } else {
      body.style.background = effect.bgColor;
    }
  } else if (effect.backgroundImage) {
    body.classList.add("media-bg");
    body.style.backgroundImage = `url("${effect.backgroundImage}")`;
  } else if (effect.themeClass) {
    body.classList.add(effect.themeClass);
  }

  if (!muted && effect.audioSrc) {
    effectAudio.loop = Boolean(effect.audioLoop);
    effectAudio.src = effect.audioSrc;
    effectAudio.play().catch(() => {});
    showIndicator(effect.audioText || `正在播放: ${name}`);
  }
}

function startRolling() {
  clearScene();
  nameDisplay.classList.remove("selected");
  timer = setInterval(() => {
    nameDisplay.textContent = getRandomItem();
  }, intervalMs);
}

function stopRolling() {
  clearInterval(timer);
  timer = null;
  nameDisplay.classList.add("selected");
  applyEffect(itemEffectKey(nameDisplay.textContent));
  speakName(nameDisplay.textContent);
  announceResult(nameDisplay.textContent);
}

function showSpecificName(name) {
  if (!name) return;
  if (running) {
    clearInterval(timer);
    timer = null;
    running = false;
    startBtn.textContent = "开始抽签";
  }
  clearScene();
  nameDisplay.classList.add("selected");
  nameDisplay.textContent = name;
  applyEffect(itemEffectKey(name));
  speakName(name);
  announceResult(name);
}

function syncMusicButton() {
  musicControl.classList.toggle("muted", muted);
  musicControl.innerHTML = muted ? mutedSvg : speakerSvg;
  // 这是个切换按钮，但它的状态原来**只通过视觉暴露**（.muted 改透明度 + 换图标），
  // 读屏用户听到的永远是「静音控制，按钮」，不知道现在是静音还是没静音。
  // aria-pressed 才是切换按钮表达「按下/未按下」的标准做法。
  // 同页的 #modeBadge 靠文字变化、CS 页的 soundBtn 靠「音效 开/关」都暴露了状态，
  // 只有这个按钮漏了。
  musicControl.setAttribute("aria-pressed", muted ? "true" : "false");
}

// ========== 事件绑定 ==========

startBtn.addEventListener("click", () => {
  if (running) {
    stopRolling();
    startBtn.textContent = "开始抽签";
  } else {
    startRolling();
    startBtn.textContent = "停止";
  }
  running = !running;
});

speedControl.addEventListener("input", () => {
  intervalMs = sliderToInterval(speedControl.value);
  if (running && timer) {
    clearInterval(timer);
    timer = setInterval(() => {
      nameDisplay.textContent = getRandomItem();
    }, intervalMs);
  }
});

musicControl.addEventListener("click", () => {
  muted = !muted;
  syncMusicButton();
  if (muted) {
    stopAllAudio();
    showIndicator("");
    return;
  }
  applyEffect(itemEffectKey(nameDisplay.textContent));
});

adminToggle.addEventListener("click", () => {
  if (isAdmin) {
    // 焦点本来就在这个按钮上（鼠标点击也会让 button 获得焦点），不用再还一次
    exitAdminMode(false);
    return;
  }
  openAdminMode();
});

adminApplyBtn.addEventListener("click", () => {
  if (!isAdmin) return;
  showSpecificName(adminNameSelect.value);
});

adminExitBtn.addEventListener("click", () => {
  exitAdminMode(true);   // 键盘按到「退出」时焦点该回到「管」按钮上
});

// 点面板外面就关掉。注意 adminToggle 自己的 click 会先跑完（开/关面板），
// 这里必须把按钮本身排除掉，否则刚打开就被这一下关回去。
document.addEventListener("click", (e) => {
  if (!isAdmin) return;
  if (adminPanel.contains(e.target) || adminToggle.contains(e.target)) return;
  exitAdminMode(false);
});

// ---------- 设置面板事件 ----------

settingsToggle.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

funSave.addEventListener("click", async () => {
  settings.funNames = settingsFunNames.value;
  await saveSettings();
  refreshRoster();
});
funReset.addEventListener("click", async () => {
  settings.funNames = "";
  settingsFunNames.value = (defaultNames.length ? defaultNames.join("\n") : names.join("\n"));
  updateCounts();
  await saveSettings();
  refreshRoster();
});

studentNamesSave.addEventListener("click", async () => {
  settings.studentNames = settingsStudentNames.value;
  await saveSettings();
  refreshRoster();
});
studentNamesReset.addEventListener("click", async () => {
  settings.studentNames = "";
  settingsStudentNames.value = (defaultNames.length ? defaultNames.join("\n") : names.join("\n"));
  updateCounts();
  await saveSettings();
  refreshRoster();
});

settingsSave.addEventListener("click", async () => {
  settings.funNames = settingsFunNames.value;
  settings.studentNames = settingsStudentNames.value;
  const st = settings.student;
  st.start = (parseInt(studentStart.value, 10) || 1);
  st.pad = String(studentPad.value || "").trim();
  st.prefix = String(studentPrefix.value || "").trim();
  st.suffix = String(studentSuffix.value || "").trim();
  await saveSettings();
  refreshRoster();
  closeSettings();
});

async function switchMode() {
  const target = isStudentMode() ? "fun" : "student";
  if (target === settings.mode) return;
  settings.mode = target;
  if (running) {
    clearInterval(timer);
    timer = null;
    running = false;
    startBtn.textContent = "开始抽签";
  }
  clearScene();
  nameDisplay.classList.remove("selected");
  nameDisplay.textContent = "点击开始";
  updateModeUI();
  updateCounts();
  invalidateRosterCache();
  refreshAdminNameOptions();
  await saveSettings();
}

modeBadge.addEventListener("click", switchMode);

[settingsFunNames, settingsStudentNames].forEach((el) => el.addEventListener("input", updateCounts));
[studentStart, studentPad, studentPrefix, studentSuffix].forEach((el) => el.addEventListener("input", updateCounts));
announceToggle.addEventListener("change", async () => {
  settings.announce = announceToggle.checked;
  await saveSettings();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // 只关真正打开的那个。原来两个 close 都是无条件调用，于是即使关的是设置面板，
  // 后执行的 closeEffects() 也会把焦点抢到「特效管理」按钮上 —— 焦点归位的对象错了。
  // 弹层优先：弹层开着时它背后的东西都是 inert 的，不该被同一次 Escape 一起关掉。
  if (settingsOverlay.classList.contains("show")) { closeSettings(); return; }
  if (effectsOverlay.classList.contains("show")) { closeEffects(); return; }
  if (isAdmin) exitAdminMode(true);
});

// ========== 初始化 ==========

if ('speechSynthesis' in window) {
  refreshSpeechVoices();
  window.speechSynthesis.onvoiceschanged = refreshSpeechVoices;
}

Promise.all([loadNames(), loadEffects()]).then(async () => {
  defaultNames = [...names];
  defaultEffects = { ...effectsByName };
  const saved = await loadSettings();
  if (saved && typeof saved === "object") {
    if (typeof saved.mode === "string") settings.mode = saved.mode;
    else if (saved.student && saved.student.enabled) settings.mode = "student"; // 兼容旧数据
    if (typeof saved.funNames === "string") settings.funNames = saved.funNames;
    if (typeof saved.studentNames === "string") settings.studentNames = saved.studentNames;
    if (typeof saved.namesText === "string") settings.funNames = saved.namesText; // 兼容旧数据
    // 语音播报开关。这一行原来是漏掉的：用户在设置里关掉播报后确实写进了存储，
    // 但刷新页面时没人把它读回来，于是又变回「开」—— 设置看着是保存了，其实每次
    // 重新打开都失效。CS 页一直是有这一行的，主站没有。
    if (typeof saved.announce === "boolean") settings.announce = saved.announce;
    if (saved.effects && typeof saved.effects === "object") settings.effects = saved.effects;
    if (saved.student && typeof saved.student === "object") {
      settings.student = Object.assign({}, settings.student, saved.student);
    }
  }
  effectsByName = (settings.effects && Object.keys(settings.effects).length > 0)
    ? { ...settings.effects }
    : { ...defaultEffects };
  syncMusicButton();
  refreshRoster();
});
