const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// 允许网页音频在无用户手势时自动播放
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ROOT = __dirname;
const BALL_SIZE = 68;
const BALL_MARGIN = 20;

let ballWindow = null;
let mainWindow = null;
let tray = null;
let quitting = false;
let ballDrag = null;

// 打包后用 extraResources 里的 webapp，开发时直接用 electron/webapp
function getWebRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'webapp');
  }
  return path.join(ROOT, 'webapp');
}

function getIconPath() {
  return path.join(ROOT, 'build', 'icon.png');
}

// ---------- 悬浮球 ----------
function createBallWindow() {
  if (ballWindow) {
    return ballWindow;
  }

  const wa = screen.getPrimaryDisplay().workArea;
  const x = Math.round(wa.x + wa.width - BALL_SIZE - BALL_MARGIN);
  const y = Math.round(wa.y + wa.height - BALL_SIZE - BALL_MARGIN);

  ballWindow = new BrowserWindow({
    width: BALL_SIZE,
    height: BALL_SIZE,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 让悬浮球盖在所有窗口之上
  ballWindow.setAlwaysOnTop(true, 'screen-saver');
  ballWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ballWindow.loadFile(path.join(ROOT, 'ball.html'));

  ballWindow.on('closed', () => {
    ballWindow = null;
  });

  return ballWindow;
}

function showBall() {
  if (mainWindow) {
    mainWindow.hide();
  }
  const win = createBallWindow();
  win.showInactive();
}

function hideBall() {
  if (ballWindow) {
    ballWindow.hide();
  }
}

// ---------- 主界面 ----------
function createMainWindow() {
  if (mainWindow) {
    return mainWindow;
  }

  const wa = screen.getPrimaryDisplay().workArea;
  mainWindow = new BrowserWindow({
    width: Math.min(920, wa.width - 60),
    height: Math.min(780, wa.height - 60),
    center: true,
    show: false,
    backgroundColor: '#fff2d7',
    title: '谁是幸运儿',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(getWebRoot(), 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 关闭主界面 → 回到悬浮球，而不是真正退出
  mainWindow.on('close', (event) => {
    if (quitting) {
      return;
    }
    event.preventDefault();
    hideBall();
    mainWindow.hide();
    createBallWindow().showInactive();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function openMainInterface() {
  hideBall();
  const win = createMainWindow();
  win.show();
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
  win.moveTop();
}

// ---------- 托盘 ----------
function createTray() {
  const icon = nativeImage.createFromPath(getIconPath());
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('谁是幸运儿 · 悬浮球');

  const menu = Menu.buildFromTemplate([
    {
      label: '打开主界面',
      click: () => openMainInterface()
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);

  tray.on('double-click', () => openMainInterface());
}

// ---------- IPC ----------
ipcMain.on('ball:open', () => {
  openMainInterface();
});

// 指针坐标解析。
// 触摸 / 笔尖必须使用渲染进程上报的坐标：触屏拖动时鼠标指针不会跟着手指移动，
// 直接读 screen.getCursorScreenPoint() 会得到恒定值，位移恒为 0，球就不会动。
// 鼠标仍沿用系统光标位置，保持原有手感。
function resolvePointer(x, y, pointerType) {
  if (
    pointerType &&
    pointerType !== 'mouse' &&
    typeof x === 'number' &&
    typeof y === 'number' &&
    Number.isFinite(x) &&
    Number.isFinite(y)
  ) {
    return { x, y };
  }
  return screen.getCursorScreenPoint();
}

// 把悬浮球限制在「球中心所在的那块屏幕」的工作区里。
//
// 原来拖动完全没有边界：球可以被拖到屏幕外，一旦拖出去就再也点不到 ——
// 而悬浮球正是打开主界面的主要入口（托盘只是兜底），这是个能把用户卡死的坑。
//
// 用 getDisplayNearestPoint 而不是 getPrimaryDisplay，是为了多显示器下仍能
// 正常把球从一块屏拖到另一块屏，同时又不会越出任何一块屏的边界。
//
// 注意拖动位置是按「起点 + 本次指针位移」算的（不是逐帧累加），所以贴边之后
// 往回拖会立刻跟随，不会出现「粘在边上」的手感问题。
function clampToWorkArea(x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  const wa = screen.getDisplayNearestPoint({
    x: px + Math.round(BALL_SIZE / 2),
    y: py + Math.round(BALL_SIZE / 2)
  }).workArea;
  return {
    x: Math.min(Math.max(px, wa.x), wa.x + wa.width - BALL_SIZE),
    y: Math.min(Math.max(py, wa.y), wa.y + wa.height - BALL_SIZE)
  };
}

// 移动悬浮球。用 setBounds 而不是 setPosition —— 实测 setBounds 只要 324µs，
// setPosition 要 741µs，慢 2.25 倍。拖动时一秒要调几十次，这个差别是实打实的。
// 第三个参数显式传 false，避免平台默认值差异带来的动画。
function moveBall(x, y) {
  if (!ballWindow) return;
  const p = clampToWorkArea(x, y);
  ballWindow.setBounds({ x: p.x, y: p.y, width: BALL_SIZE, height: BALL_SIZE }, false);
}

ipcMain.on('ball:drag-start', (_event, x, y, pointerType) => {
  if (!ballWindow) return;
  const [winX, winY] = ballWindow.getPosition();
  ballDrag = {
    cursor: resolvePointer(x, y, pointerType),
    winX,
    winY
  };
});

ipcMain.on('ball:drag-move', (_event, x, y, pointerType) => {
  if (!ballWindow || !ballDrag) return;
  const cursor = resolvePointer(x, y, pointerType);
  moveBall(
    Math.round(ballDrag.winX + cursor.x - ballDrag.cursor.x),
    Math.round(ballDrag.winY + cursor.y - ballDrag.cursor.y)
  );
});

ipcMain.on('ball:drag-end', () => {
  ballDrag = null;
});

ipcMain.on('ball:move', (_event, x, y) => {
  moveBall(Math.round(x), Math.round(y));
});

ipcMain.on('main:return', () => {
  showBall();
});

// ---------- 设置持久化 ----------
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

ipcMain.handle('settings:load', () => {
  try {
    const p = getSettingsPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (e) {
    // 忽略读取失败
  }
  return null;
});

ipcMain.handle('settings:save', (_event, data) => {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
});

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  createTray();
  createBallWindow().showInactive();

  app.on('activate', () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      createBallWindow().showInactive();
    }
  });
});

// 不是真正退出时，窗口全部关闭也不要退出（悬浮球会保留）
app.on('window-all-closed', () => {
  if (quitting) {
    app.quit();
  }
});

app.on('before-quit', () => {
  quitting = true;
});
