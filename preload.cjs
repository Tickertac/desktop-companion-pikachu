// Bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  loadConfig: () => ipcRenderer.invoke("load-config"),
  saveVrm: (fileName, bytes) => ipcRenderer.invoke("save-vrm", { fileName, bytes }),
  transcribe: (bytes) => ipcRenderer.invoke("transcribe", bytes),
  chat: (text) => ipcRenderer.invoke("chat", text),
  resetChat: () => ipcRenderer.invoke("reset-chat"),
  speak: (text) => ipcRenderer.invoke("speak", text),
  walk: (dx) => ipcRenderer.invoke("walk", dx),
  mouseThrough: (on) => ipcRenderer.send("mouse-through", on),
  log: (msg) => ipcRenderer.send("log", msg),
  quit: () => ipcRenderer.send("quit"),
  onChatDelta: (fn) => ipcRenderer.on("chat-delta", (_e, t) => fn(t)),
  onCursor: (fn) => ipcRenderer.on("cursor", (_e, p) => fn(p)),
  onToggleListen: (fn) => ipcRenderer.on("toggle-listen", () => fn()),
  onStatus: (fn) => ipcRenderer.on("status", (_e, t) => fn(t)),
  onMood: (fn) => ipcRenderer.on("mood", (_e, m) => fn(m)),
  onMusic: (fn) => ipcRenderer.on("music", (_e, m) => fn(m)),
  onReminder: (fn) => ipcRenderer.on("reminder", (_e, t) => fn(t)),
  onTtsReady: (fn) => ipcRenderer.on("tts-ready", () => fn()),
});
