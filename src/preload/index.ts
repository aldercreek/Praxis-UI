import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI, PraxisEvent, ConnectionStatus } from '../shared/protocol'

const api: DesktopAPI = {
  getInfo: () => ipcRenderer.invoke('praxis:info'),
  request: (method, params) => ipcRenderer.invoke('praxis:request', method, params),
  onEvent(listener) {
    const handler = (_: Electron.IpcRendererEvent, event: PraxisEvent): void => listener(event)
    ipcRenderer.on('praxis:event', handler)
    return () => ipcRenderer.removeListener('praxis:event', handler)
  },
  onConnection(listener) {
    const handler = (_: Electron.IpcRendererEvent, status: ConnectionStatus): void => listener(status)
    ipcRenderer.on('praxis:connection', handler)
    return () => ipcRenderer.removeListener('praxis:connection', handler)
  },
  updateSettings: settings => ipcRenderer.invoke('praxis:settings', settings),
  chooseDirectory: kind => ipcRenderer.invoke('praxis:choose-directory', kind),
  choosePython: () => ipcRenderer.invoke('praxis:choose-python'),
  openExternal: url => ipcRenderer.invoke('praxis:open-external', url),
  openWorkspace: () => ipcRenderer.invoke('praxis:open-workspace'),
  restart: () => ipcRenderer.invoke('praxis:restart'),
  windowAction: action => ipcRenderer.send('praxis:window', action)
}

contextBridge.exposeInMainWorld('praxis', api)
