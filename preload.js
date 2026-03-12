const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    openTrackmania: (mapId) => ipcRenderer.invoke('open-trackmania', mapId),
    openMapDirect: (mapId) => ipcRenderer.invoke('open-map-direct', mapId),
    isMapCached: (mapId) => ipcRenderer.invoke('is-map-cached', mapId),
    saveFilterState: (state) => ipcRenderer.invoke('save-filter-state', state),
    loadFilterState: () => ipcRenderer.invoke('load-filter-state'),
    getTrackmaniaPath: () => ipcRenderer.invoke('get-trackmania-path'),
    selectTrackmaniaPath: () => ipcRenderer.invoke('select-trackmania-path'),
    checkCleanMarker: () => ipcRenderer.invoke('check-clean-marker'),
    log: (message) => ipcRenderer.invoke('log', message),
    onDownloadProgress: (callback) => {
        ipcRenderer.on('download-progress', (event, data) => callback(data));
    }
});
