import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("opencodeMemDesktop", {
  service: {
    query: () => ipcRenderer.invoke("service:action", "query"),
    start: () => ipcRenderer.invoke("service:action", "start"),
    stop: () => ipcRenderer.invoke("service:action", "stop"),
    restart: () => ipcRenderer.invoke("service:action", "restart"),
  },
  getServiceUrl: () => ipcRenderer.invoke("service:url"),
  openBrowser: () => ipcRenderer.invoke("service:open-browser"),
});
