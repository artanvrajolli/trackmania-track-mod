const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    openTrackmania: (mapId) => ipcRenderer.invoke('open-trackmania', mapId),
    openMapDirect: (mapId) => ipcRenderer.invoke('open-map-direct', mapId),
    isMapCached: (mapId) => ipcRenderer.invoke('is-map-cached', mapId),
    clearCachedMaps: () => ipcRenderer.invoke('clear-cached-maps'),
    saveFilterState: (state) => ipcRenderer.invoke('save-filter-state', state),
    loadFilterState: () => ipcRenderer.invoke('load-filter-state'),
    getTrackmaniaPath: () => ipcRenderer.invoke('get-trackmania-path'),
    selectTrackmaniaPath: () => ipcRenderer.invoke('select-trackmania-path'),
    getTmxUser: () => ipcRenderer.invoke('get-tmx-user'),
    saveTmxUser: (payload) => ipcRenderer.invoke('save-tmx-user', payload),
    getLocalPbs: () => ipcRenderer.invoke('get-local-pbs'),
    checkCleanMarker: () => ipcRenderer.invoke('check-clean-marker'),
    cancelDownload: (mapId) => ipcRenderer.invoke('cancel-download', mapId),
    log: (message) => ipcRenderer.invoke('log', message),
    onDownloadProgress: (callback) => {
        ipcRenderer.on('download-progress', (event, data) => callback(data));
    }
});
