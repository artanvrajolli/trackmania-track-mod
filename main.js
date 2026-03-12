const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

let config = {};
const configPath = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (e) {
        config = {};
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) {
        log(`Error saving config: ${e.message}`);
    }
}

let mainWindow;
const logFile = path.join(os.tmpdir(), 'trackmania-viewer.log');

function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(logFile, logMessage);
    console.log(logMessage);
}

function cleanupFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        log(`Error cleaning up file ${filePath}: ${error.message}`);
    }
}

function isLikelyHtmlResponse(contentType, initialChunk) {
    const normalizedContentType = (contentType || '').toLowerCase();
    const normalizedChunk = (initialChunk || '').toString('utf8', 0, Math.min(initialChunk.length || 0, 512)).trimStart().toLowerCase();

    if (normalizedContentType.includes('text/html') || normalizedContentType.includes('application/xhtml')) {
        return true;
    }

    return normalizedChunk.startsWith('<!doctype html') || normalizedChunk.startsWith('<html');
}

function downloadMapFile(url, mapPath, event, mapId, retries = 3) {
    const https = require('https');

    return new Promise((resolve, reject) => {
        log(`[Download] Starting download from: ${url}`);
        const request = https.get(url, (response) => {
            log(`[Download] Response status: ${response.statusCode} for URL: ${url}`);
            event.sender.send('download-progress', { mapId, status: 'downloading', progress: 10 });

            if (response.statusCode === 301 || response.statusCode === 302) {
                const redirectUrl = response.headers.location;
                log(`[Download] Redirect from ${url} to: ${redirectUrl}`);
                response.resume();

                if (!redirectUrl) {
                    reject(new Error('TMX returned a redirect without a location header'));
                    return;
                }

                downloadMapFile(redirectUrl, mapPath, event, mapId, retries)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                response.resume();
                if (retries > 0 && (response.statusCode === 500 || response.statusCode === 503 || response.statusCode === 502)) {
                    log(`Server error ${response.statusCode}, retrying... (${retries} left)`);
                    event.sender.send('download-progress', { 
                        mapId, 
                        status: 'retry', 
                        progress: 5,
                        retryAttempt: 4 - retries,
                        maxRetries: 3,
                        error: `Server error ${response.statusCode}, retrying...`
                    });
                    setTimeout(() => {
                        downloadMapFile(url, mapPath, event, mapId, retries - 1)
                            .then(resolve)
                            .catch(reject);
                    }, 2000);
                    return;
                }
                reject(new Error(`TMX download failed with status ${response.statusCode}`));
                return;
            }

            const contentType = response.headers['content-type'];
            const totalSize = parseInt(response.headers['content-length'], 10);
            let downloaded = 0;
            let validated = false;
            let file = null;

            const handleFailure = (error) => {
                if (file) {
                    file.destroy();
                }
                response.destroy();
                cleanupFile(mapPath);
                reject(error);
            };

            response.on('data', (chunk) => {
                if (!validated) {
                    validated = true;

                    if (isLikelyHtmlResponse(contentType, chunk)) {
                        handleFailure(new Error('TMX returned an error page instead of a map file'));
                        return;
                    }

                    file = fs.createWriteStream(mapPath);
                    file.on('error', (error) => {
                        handleFailure(error);
                    });
                    file.write(chunk);
                } else if (file) {
                    file.write(chunk);
                }

                downloaded += chunk.length;
                const progress = totalSize ? Math.round((downloaded / totalSize) * 50) + 10 : 50;
                event.sender.send('download-progress', { mapId, status: 'downloading', progress });
            });

            response.on('end', () => {
                if (!validated) {
                    reject(new Error('TMX returned an empty response while downloading the map'));
                    return;
                }

                if (!file) {
                    reject(new Error('Unable to create map file for download'));
                    return;
                }

                file.end(() => {
                    log(`[Download] Complete: ${mapPath} (${downloaded} bytes)`);
                    resolve();
                });
            });

            response.on('error', (error) => {
                handleFailure(error);
            });
        });

        request.on('error', (error) => {
            cleanupFile(mapPath);
            log(`Download error: ${error.message}`);
            reject(error);
        });
    });
}

log('Application started');

loadConfig();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'icon.png')
    });

    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

ipcMain.handle('open-trackmania', async (event, mapId) => {
    log(`open-trackmania called with mapId: ${mapId}`);
    
    let exePath = config.trackmaniaPath;
    
    if (!exePath || !fs.existsSync(exePath)) {
        const possiblePaths = [
            'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Trackmania\\Trackmania.exe',
            'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Trackmania\\Trackmania.exe',
            'C:\\Program Files\\Ubisoft\\Ubisoft Game Launcher\\games\\Trackmania\\Trackmania.exe',
            'C:\\Program Files\\Epic Games\\Trackmania\\Trackmania.exe',
            'C:\\Program Files (x86)\\Epic Games\\Trackmania\\Trackmania.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'trackmania', 'Trackmania.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Ubisoft Game Launcher', 'games', 'Trackmania', 'Trackmania.exe'),
            'D:\\Games\\Trackmania\\Trackmania.exe',
            'D:\\Games\\Steam\\steamapps\\common\\Trackmania\\Trackmania.exe',
            'E:\\Games\\Trackmania\\Trackmania.exe',
        ];
        
        // Find the first existing executable
        exePath = null;
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                exePath = p;
                break;
            }
        }
        
        // Save the found path to config to avoid searching again
        if (exePath) {
            config.trackmaniaPath = exePath;
            saveConfig();
        }
    }
    
    const downloadUrl = `https://trackmania.exchange/mapgbx/${mapId}`;
    const tempDir = path.join(os.tmpdir(), 'trackmania-maps');
    const mapPath = path.join(tempDir, `${mapId}.Map.Gbx`);
    
    log(`Download URL: ${downloadUrl}`);
    log(`Temp dir: ${tempDir}`);
    log(`Map path: ${mapPath}`);
    log(`Exe exists: ${fs.existsSync(exePath)}`);
    
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
        log(`Created temp dir: ${tempDir}`);
    }
    
    const checkTrackmaniaRunning = () => {
        try {
            const result = require('child_process').execSync('tasklist /FI "IMAGENAME eq Trackmania.exe" /NH', { encoding: 'utf8' });
            return result.includes('Trackmania.exe');
        } catch (e) {
            return false;
        }
    };
    
    let isRunning = checkTrackmaniaRunning();
    log(`Trackmania running: ${isRunning}`);
    
    try {
        if (fs.existsSync(mapPath)) {
            log(`Map already cached at: ${mapPath}`);
            const stats = fs.statSync(mapPath);
            log(`Cached map file size: ${stats.size} bytes`);
            event.sender.send('download-progress', { mapId, status: 'cached', progress: 100 });
        } else {
            log('Starting download...');
            event.sender.send('download-progress', { mapId, status: 'starting', progress: 0 });
            await downloadMapFile(downloadUrl, mapPath, event, mapId);
        }
        
        log(`Map file exists: ${fs.existsSync(mapPath)}`);
        if (fs.existsSync(mapPath)) {
            const stats = fs.statSync(mapPath);
            log(`Map file size: ${stats.size} bytes`);
        }
        
        if (exePath) {
            log(`Found Trackmania at: ${exePath}`);
            if (!isRunning) {
                log('Trackmania not running, launching first...');
                spawn(`"${exePath}"`, [], { 
                    detached: true, 
                    stdio: 'ignore', 
                    shell: true 
                });
                
                event.sender.send('download-progress', { mapId, status: 'waiting', progress: 60 });
                log('Waiting for Trackmania to start (polling every 2s)...');
                
                let attempts = 0;
                const maxAttempts = 60;
                let processStarted = false;
                
                while (attempts < maxAttempts && !processStarted) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    attempts++;
                    
                    processStarted = checkTrackmaniaRunning();
                    if (processStarted) {
                        log('Trackmania process detected');
                    }
                    
                    const progress = 60 + Math.min(attempts, 35);
                    event.sender.send('download-progress', { mapId, status: 'waiting', progress, attempts });
                }
                
                if (processStarted) {
                    log('Waiting 15s for login...');
                    event.sender.send('download-progress', { mapId, status: 'login', progress: 95 });
                    await new Promise(resolve => setTimeout(resolve, 15000));
                    log('Login wait complete');
                } else {
                    log('Timeout waiting for Trackmania to start');
                }
            } else {
                event.sender.send('download-progress', { mapId, status: 'launching', progress: 90 });
            }
            
            log(`Opening map: ${mapPath}`);
            await shell.openPath(mapPath);
            log('shell.openPath called');
            event.sender.send('download-progress', { mapId, status: 'complete', progress: 100 });
            return { success: true, method: 'shell-openPath' };
        } else {
            log(`Exe not found, trying shell.openPath`);
            await shell.openPath(mapPath);
            event.sender.send('download-progress', { mapId, status: 'complete', progress: 100 });
            return { success: true, method: 'shell-open' };
        }
    } catch (error) {
        cleanupFile(mapPath);
        log(`Error: ${error.message}`);
        log(`Stack: ${error.stack}`);
        event.sender.send('download-progress', { mapId, status: 'error', error: error.message });
        return { success: false, error: error.message };
    }
});

ipcMain.handle('is-map-cached', async (event, mapId) => {
    const tempDir = path.join(os.tmpdir(), 'trackmania-maps');
    const mapPath = path.join(tempDir, `${mapId}.Map.Gbx`);
    return fs.existsSync(mapPath);
});

ipcMain.handle('open-map-direct', async (event, mapId) => {
    const commonPaths = [
        'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Trackmania\\Trackmania.exe',
        'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Trackmania\\Trackmania.exe',
        'C:\\Program Files\\Ubisoft\\Ubisoft Game Launcher\\games\\Trackmania\\Trackmania.exe',
        'C:\\Program Files\\Epic Games\\Trackmania\\Trackmania.exe',
        'C:\\Program Files (x86)\\Epic Games\\Trackmania\\Trackmania.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'trackmania', 'Trackmania.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Ubisoft Game Launcher', 'games', 'Trackmania', 'Trackmania.exe'),
        path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Ubisoft Game Launcher', 'games', 'Trackmania', 'Trackmania.exe'),
        'D:\\Games\\Trackmania\\Trackmania.exe',
        'D:\\Games\\Steam\\steamapps\\common\\Trackmania\\Trackmania.exe',
        'D:\\Program Files\\Trackmania\\Trackmania.exe',
        'E:\\Games\\Trackmania\\Trackmania.exe',
        'E:\\Games\\Steam\\steamapps\\common\\Trackmania\\Trackmania.exe',
    ];

    for (const exePath of commonPaths) {
        try {
            log(`[Open] Trying exe: ${exePath}`);
            spawn(exePath, [`/joinmap=${mapId}`], { detached: true });
            log(`[Open] Launched: ${exePath} with /joinmap=${mapId}`);
            return { success: true, path: exePath };
        } catch (e) {
            continue;
        }
    }

    const protocolUrl = `trackmania://joinmap/${mapId}`;
    log(`[Open] Trying protocol: ${protocolUrl}`);
    await shell.openExternal(protocolUrl);
    log(`[Open] Opened protocol URL: ${protocolUrl}`);
    return { success: true, method: 'protocol' };
});

ipcMain.handle('get-trackmania-path', async () => {
    return config.trackmaniaPath || null;
});

ipcMain.handle('select-trackmania-path', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Trackmania.exe',
        filters: [{ name: 'Executables', extensions: ['exe'] }],
        properties: ['openFile']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        if (selectedPath.toLowerCase().endsWith('trackmania.exe')) {
            config.trackmaniaPath = selectedPath;
            saveConfig();
            return { success: true, path: selectedPath };
        } else {
            return { success: false, error: 'Please select a file named Trackmania.exe' };
        }
    }
    return { success: false, canceled: true };
});

ipcMain.handle('save-filter-state', async (event, state) => {
    try {
        config.filterState = state;
        saveConfig();
        return { success: true };
    } catch (error) {
        log(`Error saving filter state: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('load-filter-state', async () => {
    try {
        return config.filterState || null;
    } catch (error) {
        log(`Error loading filter state: ${error.message}`);
        return null;
    }
});

ipcMain.handle('check-clean-marker', async () => {
    const markerPath = path.join(os.tmpdir(), 'trackmania-clean-marker');
    try {
        if (fs.existsSync(markerPath)) {
            fs.unlinkSync(markerPath);
            log('Clean marker found and removed');
            return true;
        }
    } catch (error) {
        log(`Error checking clean marker: ${error.message}`);
    }
    return false;
});

ipcMain.handle('log', async (event, message) => {
    log(`[Renderer] ${message}`);
});
