const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBall', {
  // 悬浮球页面使用
  // 拖动必须带上指针的屏幕坐标：触屏时鼠标指针不会跟着手指走，
  // 主进程若自己去读 screen.getCursorScreenPoint() 会永远得到零位移。
  dragTo: (x, y) => ipcRenderer.send('ball:move', x, y),
  dragStart: (x, y, pointerType) => ipcRenderer.send('ball:drag-start', x, y, pointerType),
  dragMove: (x, y, pointerType) => ipcRenderer.send('ball:drag-move', x, y, pointerType),
  dragEnd: () => ipcRenderer.send('ball:drag-end'),
  open: () => ipcRenderer.send('ball:open'),

  // 主界面使用：回到悬浮球
  returnToBall: () => ipcRenderer.send('main:return'),

  // 设置持久化（用户名单 / 学号模式）
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (data) => ipcRenderer.invoke('settings:save', data)
  }
});
