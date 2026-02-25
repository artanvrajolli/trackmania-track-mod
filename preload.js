const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    openTrackmania: (mapId) => ipcRenderer.invoke('open-trackmania', mapId),
    openMapDirect: (mapId) => ipcRenderer.invoke('open-map-direct', mapId),
    isMapCached: (mapId) => ipcRenderer.invoke('is-map-cached', mapId),
    onDownloadProgress: (callback) => {
        ipcRenderer.on('download-progress', (event, data) => callback(data));
    }
});
