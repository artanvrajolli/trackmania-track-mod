const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

let mainWindow;
const logFile = path.join(os.tmpdir(), 'trackmania-viewer.log');

function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(logFile, logMessage);
    console.log(logMessage);
}

log('Application started');

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
    
    const exePath = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Trackmania\\Trackmania.exe';
    const https = require('https');
    
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
        log('Starting download...');
        event.sender.send('download-progress', { mapId, status: 'starting', progress: 0 });
        
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(mapPath);
            https.get(downloadUrl, (response) => {
                log(`Download response status: ${response.statusCode}`);
                event.sender.send('download-progress', { mapId, status: 'downloading', progress: 10 });
                
                if (response.statusCode === 302 || response.statusCode === 301) {
                    log(`Redirect to: ${response.headers.location}`);
                    https.get(response.headers.location, (redirectResp) => {
                        const totalSize = parseInt(redirectResp.headers['content-length'], 10);
                        let downloaded = 0;
                        
                        redirectResp.on('data', (chunk) => {
                            downloaded += chunk.length;
                            const progress = totalSize ? Math.round((downloaded / totalSize) * 50) + 10 : 50;
                            event.sender.send('download-progress', { mapId, status: 'downloading', progress });
                        });
                        
                        redirectResp.pipe(file);
                        file.on('finish', () => {
                            file.close();
                            log('Download complete (redirect)');
                            resolve();
                        });
                    }).on('error', (err) => {
                        log(`Redirect error: ${err.message}`);
                        reject(err);
                    });
                } else {
                    const totalSize = parseInt(response.headers['content-length'], 10);
                    let downloaded = 0;
                    
                    response.on('data', (chunk) => {
                        downloaded += chunk.length;
                        const progress = totalSize ? Math.round((downloaded / totalSize) * 50) + 10 : 50;
                        event.sender.send('download-progress', { mapId, status: 'downloading', progress });
                    });
                    
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        log('Download complete');
                        resolve();
                    });
                }
            }).on('error', (err) => {
                log(`Download error: ${err.message}`);
                reject(err);
            });
        });
        
        log(`Map file exists: ${fs.existsSync(mapPath)}`);
        if (fs.existsSync(mapPath)) {
            const stats = fs.statSync(mapPath);
            log(`Map file size: ${stats.size} bytes`);
        }
        
        if (fs.existsSync(exePath)) {
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
        log(`Error: ${error.message}`);
        log(`Stack: ${error.stack}`);
        event.sender.send('download-progress', { mapId, status: 'error', error: error.message });
        return { success: false, error: error.message };
    }
});

ipcMain.handle('open-map-direct', async (event, mapId) => {
    const commonPaths = [
        'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Trackmania\\Trackmania.exe',
        'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Trackmania\\Trackmania.exe',
        'C:\\Program Files\\Ubisoft\\Ubisoft Game Launcher\\games\\Trackmania\\Trackmania.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'trackmania', 'Trackmania.exe'),
        'D:\\Games\\Trackmania\\Trackmania.exe',
        'E:\\Games\\Trackmania\\Trackmania.exe'
    ];

    for (const exePath of commonPaths) {
        try {
            spawn(exePath, [`/joinmap=${mapId}`], { detached: true });
            return { success: true, path: exePath };
        } catch (e) {
            continue;
        }
    }

    await shell.openExternal(`trackmania://joinmap/${mapId}`);
    return { success: true, method: 'protocol' };
});
