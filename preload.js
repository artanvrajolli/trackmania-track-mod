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
    nadeoLoginUbisoft: (payload) => ipcRenderer.invoke('nadeo-login-ubisoft', payload),
    nadeoLoginOAuth: (payload) => ipcRenderer.invoke('nadeo-login-oauth', payload),
    nadeoLogout: () => ipcRenderer.invoke('nadeo-logout'),
    nadeoStatus: () => ipcRenderer.invoke('nadeo-status'),
    nadeoGetPbs: (payload) => ipcRenderer.invoke('nadeo-get-pbs', payload),
    nadeoRestoreSession: () => ipcRenderer.invoke('nadeo-restore-session'),
    tmioGetAuthToken: () => ipcRenderer.invoke('tmio-get-auth-token'),
    tmioSaveAuthToken: (token) => ipcRenderer.invoke('tmio-save-auth-token', token),
    tmioGetPbs: (payload) => ipcRenderer.invoke('tmio-get-pbs', payload),
    tmioGetPbSingle: (payload) => ipcRenderer.invoke('tmio-get-pb-single', payload),
    tmioLogin: () => ipcRenderer.invoke('tmio-login'),
    onDownloadProgress: (callback) => {
        ipcRenderer.on('download-progress', (event, data) => callback(data));
    }
});
