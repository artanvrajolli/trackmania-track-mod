const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const gbxremote = require('gbxremote');

let config = {};
let cancelDownloadId = null;
let activeDownloadId = null;
const configPath = path.join(app.getPath('userData'), 'config.json');

function getTrackmaniaProcessIds() {
    try {
        const output = execSync('tasklist /FI "IMAGENAME eq Trackmania.exe" /FO CSV /NH', { encoding: 'utf8' });
        const lines = output
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('INFO:'));

        const processIds = [];
        for (const line of lines) {
            const normalized = line.replace(/^"|"$/g, '');
            const parts = normalized.split('","');
            if (parts.length < 2) {
                continue;
            }

            const pid = parseInt(parts[1], 10);
            if (!Number.isNaN(pid)) {
                processIds.push(pid);
            }
        }

        return processIds;
    } catch (error) {
        return [];
    }
}

function checkTrackmaniaRunning() {
    return getTrackmaniaProcessIds().length > 0;
}

function probeTrackmaniaSessionReady(timeoutMs = 4000) {
    return new Promise((resolve) => {
        let settled = false;
        let client = null;
        let lastClientError = null;

        const finish = (ready, reason = '') => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeoutHandle);
            try {
                if (client) {
                    client.terminate();
                }
            } catch (error) {
            }
            resolve({ ready, reason });
        };

        const timeoutHandle = setTimeout(() => {
            finish(false, 'gbx-timeout');
        }, timeoutMs);

        (async () => {
            try {
                client = new gbxremote.Client(5000, '127.0.0.1');
                client.on('error', (error) => {
                    lastClientError = error;
                });

                await client.connect(2000);

                const mainPlayer = await client.query('GetMainServerPlayerInfo', []);
                if (!mainPlayer || !mainPlayer.Login || !mainPlayer.NickName) {
                    finish(false, 'missing-main-player');
                    return;
                }

                const detailedPlayer = await client.query('GetDetailedPlayerInfo', [mainPlayer.Login]);
                const systemInfo = await client.query('GetSystemInfo', []);

                const playerLogin = String(mainPlayer.Login || '').trim();
                const serverLogin = String(systemInfo?.ServerLogin || '').trim();
                const hoursSinceZoneInscription = Number(detailedPlayer?.HoursSinceZoneInscription);
                const playerRankings = detailedPlayer?.LadderStats?.PlayerRankings;
                const playerPath = String(detailedPlayer?.Path || '');

                // Trackmania 2020 online account keys are 22-character Base64Url strings (e.g. HSnSHgS2RsuSWjSccf0HHg)
                // When still loading/offline, it uses a 36-character UUID with hyphens (e.g. bc14c157-f5b3-47bd-9085-2e8d7166adb0)
                const isOnlineAccount = playerLogin.length > 0 && playerLogin.length < 36 && !playerLogin.includes('-');
                
                // When fully authenticated, Path usually resolves to something like "World|Europe|Albania"
                // rather than just "World" 
                const hasDetailedPath = playerPath.includes('|');

                // Dump pure telemetry so we can debug exactly what Trackmania reports
                log(`[GBX Telemetry] Login: ${playerLogin} (${playerLogin.length}), Path: ${playerPath}`);

                const ready = Boolean(
                    detailedPlayer &&
                    detailedPlayer.Login &&
                    detailedPlayer.NickName &&
                    detailedPlayer.ClientVersion &&
                    isOnlineAccount && 
                    hasDetailedPath
                );

                const reason = ready
                    ? 'gbx-player-ready'
                    : `gbx-not-authenticated:loginMatch=${playerLogin === serverLogin};hours=${hoursSinceZoneInscription};hasRanking=${hasRankingData}`;

                finish(ready, reason);
            } catch (error) {
                const message = error?.message || lastClientError?.message || 'unknown';
                finish(false, `gbx-error:${message}`);
            }
        })();
    });
}

async function waitForTrackmaniaLogin(event, mapId, timeoutMs = 180000) {
    const pollIntervalMs = 2000;
    const requiredStableChecks = 3;
    const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);
    let stableChecks = 0;

    event.sender.send('download-progress', {
        mapId,
        status: 'login-detecting',
        progress: 95,
        attempt: 0,
        maxAttempts
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (cancelDownloadId !== mapId) {
            throw new Error('Download cancelled');
        }

        const probe = await probeTrackmaniaSessionReady();
        if (probe.ready) {
            stableChecks += 1;
            if (stableChecks >= requiredStableChecks) {
                log(`Automatic login detection succeeded after ${attempt} checks for map ${mapId}`);
                return;
            }
        } else {
            log(`Login probe check ${attempt}/${maxAttempts} for map ${mapId}: ${probe.reason}`);
            stableChecks = 0;
        }

        event.sender.send('download-progress', {
            mapId,
            status: 'login-detecting',
            progress: 95,
            attempt,
            maxAttempts
        });

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error('Could not confirm Trackmania login in time. Please log in and retry.');
}

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
let localPbCache = null;
let localPbCacheAt = 0;
const LOCAL_PB_CACHE_TTL_MS = 60 * 1000;

const UBISOFT_APP_ID = '86263886-327a-4328-ac69-527f0d20a237';
const UBISERVICES_SESSION_URL = 'https://public-ubiservices.ubi.com/v3/profiles/sessions';
const NADEO_AUTH_URL = 'https://prod.trackmania.core.nadeo.online/v2/authentication/token/ubiservices';
const NADEO_AUTH_BASIC_URL = 'https://prod.trackmania.core.nadeo.online/v2/authentication/token/basic';
const NADEO_RECORDS_URL = 'https://prod.trackmania.core.nadeo.online/v2/accounts';
const NADEO_MAPS_BY_UID_URL = 'https://prod.trackmania.core.nadeo.online/maps';
const TM_OAUTH_AUTHORIZE = 'https://api.trackmania.com/oauth/authorize';
const TM_OAUTH_TOKEN = 'https://api.trackmania.com/api/access_token';

let nadeoTokens = { accessToken: null, refreshToken: null };
let nadeoAccountId = null;
let nadeoPbCache = null;
let nadeoPbCacheAt = 0;
const NADEO_PB_CACHE_TTL_MS = 60 * 1000;
let oauthServer = null;

let tmioPbCache = null;
let tmioPbCacheAt = 0;
const TMIO_PB_CACHE_TTL_MS = 60 * 1000;
const TMIO_API_BASE = 'https://trackmania.io/api';
const TMIO_RATE_LIMIT_MS = 1600; // ~40 requests per minute

function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(logFile, logMessage);
    console.log(logMessage);
}

async function loadLocalPersonalBests() {
    const now = Date.now();
    if (localPbCache && now - localPbCacheAt < LOCAL_PB_CACHE_TTL_MS) {
        return localPbCache;
    }

    const docsDir = app.getPath('documents');
    const replaysDir = path.join(docsDir, 'Trackmania', 'Replays', 'Autosaves');

    if (!fs.existsSync(replaysDir)) {
        localPbCache = {};
        localPbCacheAt = now;
        return localPbCache;
    }

    let entries = [];
    try {
        entries = await fs.promises.readdir(replaysDir, { withFileTypes: true });
    } catch (error) {
        log(`Failed to read replays directory: ${error.message}`);
        localPbCache = {};
        localPbCacheAt = now;
        return localPbCache;
    }

    const pbFiles = entries
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .filter(name => name.toLowerCase().endsWith('.replay.gbx') && name.toLowerCase().includes('personalbest'));

    if (!pbFiles.length) {
        localPbCache = {};
        localPbCacheAt = now;
        return localPbCache;
    }

    let GBX = null;
    try {
        ({ GBX } = await import('gbx'));
    } catch (error) {
        log(`Failed to load gbx parser: ${error.message}`);
        localPbCache = {};
        localPbCacheAt = now;
        return localPbCache;
    }

    const results = {};
    for (const name of pbFiles) {
        const filePath = path.join(replaysDir, name);
        try {
            const data = await fs.promises.readFile(filePath);
            const gbx = new GBX(data);
            const replay = await gbx.parseHeaders();
            const uid = replay?.mapInfo?.id;
            const time = replay?.time;
            if (!uid || typeof time !== 'number' || time <= 0) {
                continue;
            }
            if (!results[uid] || time < results[uid]) {
                results[uid] = time;
            }
        } catch (error) {
            log(`Failed to parse replay ${name}: ${error.message}`);
        }
    }

    localPbCache = results;
    localPbCacheAt = now;
    return localPbCache;
}

function httpsRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || 'GET',
            headers: options.headers || {},
        };

        const req = protocol.request(reqOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({ status: res.statusCode, headers: res.headers, body: data });
            });
        });

        req.on('error', reject);

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

async function getUbisoftTicket(email, password) {
    const credentials = Buffer.from(`${email}:${password}`).toString('base64');
    const response = await httpsRequest(UBISERVICES_SESSION_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Ubi-AppId': UBISOFT_APP_ID,
            'Authorization': `Basic ${credentials}`,
            'User-Agent': 'TrackmaniaMapViewer/1.0',
        },
        body: JSON.stringify({}),
    });

    if (response.status !== 200) {
        let errorMsg = `Ubisoft auth failed (${response.status})`;
        try {
            const parsed = JSON.parse(response.body);
            if (parsed.message) errorMsg = parsed.message;
        } catch {}
        throw new Error(errorMsg);
    }

    const data = JSON.parse(response.body);
    return { ticket: data.ticket, accountId: data.userId };
}

async function getNadeoToken(ticket, audience = 'NadeoServices') {
    const response = await httpsRequest(NADEO_AUTH_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `ubi_v1 t=${ticket}`,
            'User-Agent': 'TrackmaniaMapViewer/1.0',
        },
        body: JSON.stringify({ audience }),
    });

    if (response.status !== 200) {
        throw new Error(`Nadeo token exchange failed (${response.status})`);
    }

    const data = JSON.parse(response.body);
    return { accessToken: data.accessToken, refreshToken: data.refreshToken };
}

async function refreshNadeoToken(audience = 'NadeoServices') {
    if (!nadeoTokens.refreshToken) {
        throw new Error('No refresh token available');
    }

    const response = await httpsRequest(NADEO_AUTH_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `nadeo_v1 t=${nadeoTokens.refreshToken}`,
            'User-Agent': 'TrackmaniaMapViewer/1.0',
        },
        body: JSON.stringify({ audience }),
    });

    if (response.status !== 200) {
        throw new Error(`Nadeo token refresh failed (${response.status})`);
    }

    const data = JSON.parse(response.body);
    nadeoTokens.accessToken = data.accessToken;
    nadeoTokens.refreshToken = data.refreshToken;
    config.nadeoTokens = nadeoTokens;
    saveConfig();
    return nadeoTokens.accessToken;
}

async function nadeoApiRequest(url, retries = 1) {
    if (!nadeoTokens.accessToken) {
        throw new Error('Not authenticated with Nadeo');
    }

    const response = await httpsRequest(url, {
        headers: {
            'Authorization': `nadeo_v1 t=${nadeoTokens.accessToken}`,
            'User-Agent': 'TrackmaniaMapViewer/1.0',
        },
    });

    if (response.status === 401 && retries > 0) {
        await refreshNadeoToken();
        return nadeoApiRequest(url, retries - 1);
    }

    if (response.status !== 200) {
        throw new Error(`Nadeo API error (${response.status}): ${response.body}`);
    }

    return JSON.parse(response.body);
}

async function translateMapUids(mapUids) {
    if (!mapUids.length) return {};

    const results = {};
    const batchSize = 100;
    for (let i = 0; i < mapUids.length; i += batchSize) {
        const batch = mapUids.slice(i, i + batchSize);
        const uidList = batch.join(',');
        try {
            const data = await nadeoApiRequest(
                `${NADEO_MAPS_BY_UID_URL}?mapUidList=${encodeURIComponent(uidList)}`
            );
            for (const map of data) {
                if (map.mapUid && map.mapId) {
                    results[map.mapUid] = map.mapId;
                }
            }
        } catch (error) {
            log(`Map UID translation batch failed: ${error.message}`);
        }
    }
    return results;
}

async function fetchNadeoPbs(mapUids) {
    const now = Date.now();
    if (nadeoPbCache && now - nadeoPbCacheAt < NADEO_PB_CACHE_TTL_MS) {
        return nadeoPbCache;
    }

    if (!nadeoTokens.accessToken || !nadeoAccountId) {
        return {};
    }

    try {
        const uidToId = await translateMapUids(mapUids);
        const mapIds = Object.values(uidToId);
        if (!mapIds.length) {
            nadeoPbCache = {};
            nadeoPbCacheAt = now;
            return nadeoPbCache;
        }

        const idToUid = {};
        for (const [uid, id] of Object.entries(uidToId)) {
            idToUid[id] = uid;
        }

        const results = {};
        const batchSize = 50;
        for (let i = 0; i < mapIds.length; i += batchSize) {
            const batch = mapIds.slice(i, i + batchSize);
            const idList = batch.join(',');
            try {
                const records = await nadeoApiRequest(
                    `${NADEO_RECORDS_URL}/${nadeoAccountId}/mapRecords?mapIdList=${idList}`
                );
                for (const record of records) {
                    const uid = idToUid[record.mapId];
                    if (uid && record.recordScore && typeof record.recordScore.time === 'number') {
                        results[uid] = {
                            time: record.recordScore.time,
                            medal: record.medal,
                            timestamp: record.timestamp,
                        };
                    }
                }
            } catch (error) {
                log(`Nadeo PB batch fetch failed: ${error.message}`);
            }
        }

        nadeoPbCache = results;
        nadeoPbCacheAt = now;
        log(`Fetched ${Object.keys(results).length} Nadeo PBs`);
        return results;
    } catch (error) {
        log(`Error fetching Nadeo PBs: ${error.message}`);
        return {};
    }
}

async function tmioApiRequest(url, authToken) {
    const headers = {
        'Authorization': authToken,
        'User-Agent': 'TrackHunter/1.0',
    };
    const response = await httpsRequest(url, { headers });
    if (response.status === 429) {
        throw new Error('Rate limited by trackmania.io');
    }
    if (response.status !== 200) {
        throw new Error(`trackmania.io API error (${response.status})`);
    }
    return JSON.parse(response.body);
}

let tmioFetchInProgress = false;

async function fetchTmioPbs(mapUids) {
    const now = Date.now();
    if (tmioPbCache && now - tmioPbCacheAt < TMIO_PB_CACHE_TTL_MS) {
        return tmioPbCache;
    }

    if (tmioFetchInProgress) {
        log('TMIO fetch already in progress, skipping');
        return tmioPbCache || {};
    }

    const authToken = config.tmioAuthToken;
    if (!authToken) {
        return {};
    }

    tmioFetchInProgress = true;

    const results = {};
    const CONCURRENCY = 3;
    const DELAY_BETWEEN_BATCHES_MS = 2000;
    let rateLimited = false;

    for (let i = 0; i < mapUids.length; i += CONCURRENCY) {
        if (rateLimited) break;

        const batch = mapUids.slice(i, i + CONCURRENCY);
        const promises = batch.map(uid =>
            tmioApiRequest(
                `${TMIO_API_BASE}/leaderboard/personal/map/${uid}`,
                authToken
            ).then(data => ({ uid, data, error: null }))
             .catch(error => ({ uid, data: null, error }))
        );

        const settled = await Promise.all(promises);

        for (const { uid, data, error } of settled) {
            if (error) {
                if (error.message.includes('Rate limited')) {
                    log(`TMIO rate limited, stopping PB fetch at map ${uid}`);
                    rateLimited = true;
                    break;
                }
                log(`TMIO PB fetch failed for map ${uid}: ${error.message}`);
                continue;
            }
            if (data && typeof data.time === 'number' && data.time > 0) {
                results[uid] = {
                    time: data.time,
                    medal: data.medal !== undefined ? data.medal : null,
                    timestamp: data.timestamp || null,
                };
            }
        }

        if (i + CONCURRENCY < mapUids.length && !rateLimited) {
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
        }
    }

    tmioPbCache = results;
    tmioPbCacheAt = now;
    tmioFetchInProgress = false;
    log(`Fetched ${Object.keys(results).length} trackmania.io PBs from ${mapUids.length} maps`);
    return results;
}

function stopOAuthServer() {
    if (oauthServer) {
        try { oauthServer.close(); } catch {}
        oauthServer = null;
    }
}

function generateRandomState() {
    return require('crypto').randomBytes(16).toString('hex');
}

async function exchangeOAuthCode(code, clientId, clientSecret, redirectUri) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        redirect_uri: redirectUri,
    }).toString();

    const response = await httpsRequest(TM_OAUTH_TOKEN, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'TrackmaniaMapViewer/1.0',
        },
        body,
    });

    if (response.status !== 200) {
        throw new Error(`OAuth token exchange failed (${response.status}): ${response.body}`);
    }

    return JSON.parse(response.body);
}

async function loginWithUbisoft(email, password) {
    const { ticket, accountId } = await getUbisoftTicket(email, password);
    log(`Ubisoft auth successful, accountId: ${accountId}`);

    const token = await getNadeoToken(ticket, 'NadeoServices');
    nadeoTokens = token;
    nadeoAccountId = accountId;

    config.nadeoTokens = nadeoTokens;
    config.nadeoAccountId = accountId;
    config.nadeoAuthMethod = 'ubisoft';
    config.nadeoEmail = email;
    saveConfig();

    nadeoPbCache = null;
    nadeoPbCacheAt = 0;

    return { success: true, accountId };
}

async function loginWithOAuth(clientId, clientSecret) {
    const state = generateRandomState();
    let port = 0;

    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            clearTimeout(timeout);
            const url = new URL(req.url, `http://127.0.0.1`);
            const code = url.searchParams.get('code');
            const returnedState = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            if (error) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>Authorization failed</h2><p>You can close this window.</p></body></html>');
                server.close();
                oauthServer = null;
                reject(new Error(`OAuth error: ${error}`));
                return;
            }

            if (returnedState !== state) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>State mismatch - possible CSRF</h2></body></html>');
                server.close();
                oauthServer = null;
                reject(new Error('OAuth state mismatch'));
                return;
            }

            if (code) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>Authorization successful!</h2><p>You can close this window.</p></body></html>');
                server.close();
                oauthServer = null;

                try {
                    const redirectUri = `http://127.0.0.1:${port}/callback`;
                    const tokens = await exchangeOAuthCode(code, clientId, clientSecret, redirectUri);
                    config.nadeoOAuthTokens = tokens;
                    config.nadeoOAuthClientId = clientId;
                    config.nadeoOAuthClientSecret = clientSecret;
                    config.nadeoAuthMethod = 'oauth';
                    saveConfig();
                    resolve({ success: true });
                } catch (err) {
                    reject(err);
                }
            } else {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>No code received</h2></body></html>');
                server.close();
                oauthServer = null;
                reject(new Error('No authorization code received'));
            }
        });

        server.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            log(`OAuth callback server listening on port ${port}`);
            oauthServer = server;

            const redirectUri = `http://127.0.0.1:${port}/callback`;
            const authUrl = new URL(TM_OAUTH_AUTHORIZE);
            authUrl.searchParams.set('response_type', 'code');
            authUrl.searchParams.set('client_id', clientId);
            authUrl.searchParams.set('scope', '');
            authUrl.searchParams.set('redirect_uri', redirectUri);
            authUrl.searchParams.set('state', state);

            shell.openExternal(authUrl.toString());
            log(`Opened OAuth URL: ${authUrl.toString()}`);
        });

        const timeout = setTimeout(() => {
            server.close();
            oauthServer = null;
            reject(new Error('OAuth login timed out (5 minutes)'));
        }, 5 * 60 * 1000);

        server.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

async function restoreNadeoSession() {
    if (config.nadeoAuthMethod === 'ubisoft' && config.nadeoTokens) {
        nadeoTokens = config.nadeoTokens;
        nadeoAccountId = config.nadeoAccountId;
        if (nadeoTokens.refreshToken) {
            try {
                await refreshNadeoToken();
                log('Nadeo session restored via refresh token');
                return true;
            } catch (error) {
                log(`Failed to restore Nadeo session: ${error.message}`);
            }
        }
    }
    return false;
}

function logoutNadeo() {
    nadeoTokens = { accessToken: null, refreshToken: null };
    nadeoAccountId = null;
    nadeoPbCache = null;
    nadeoPbCacheAt = 0;
    stopOAuthServer();
    delete config.nadeoTokens;
    delete config.nadeoAccountId;
    delete config.nadeoAuthMethod;
    delete config.nadeoEmail;
    delete config.nadeoOAuthTokens;
    delete config.nadeoOAuthClientId;
    delete config.nadeoOAuthClientSecret;
    saveConfig();
}

function isNadeoAuthenticated() {
    return Boolean(nadeoTokens.accessToken);
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
        if (cancelDownloadId !== mapId) {
            log(`[Download] Download cancelled or changed for map: ${mapId}`);
            reject(new Error('Download cancelled'));
            return;
        }
        
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
                    if (cancelDownloadId !== mapId) {
                        reject(new Error('Download cancelled'));
                        return;
                    }
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

restoreNadeoSession().catch((err) => {
    log(`Startup Nadeo session restore failed: ${err.message}`);
});

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
    
    if (activeDownloadId === mapId) {
        log(`Download already in progress for map: ${mapId}`);
        return { success: false, error: 'Download already in progress' };
    }
    
    activeDownloadId = mapId;
    cancelDownloadId = mapId;
    
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

                if (!processStarted) {
                    throw new Error('Timeout waiting for Trackmania to start');
                }
            }

            await waitForTrackmaniaLogin(event, mapId);
            event.sender.send('download-progress', { mapId, status: 'launching', progress: 90 });
            
            log(`Opening map: ${mapPath}`);
            await shell.openPath(mapPath);
            log('shell.openPath called');
            event.sender.send('download-progress', { mapId, status: 'complete', progress: 100 });
            cancelDownloadId = null;
            activeDownloadId = null;
            return { success: true, method: 'shell-openPath' };
        } else {
            log(`Exe not found, trying shell.openPath`);
            await shell.openPath(mapPath);
            event.sender.send('download-progress', { mapId, status: 'complete', progress: 100 });
            cancelDownloadId = null;
            activeDownloadId = null;
            return { success: true, method: 'shell-open' };
        }
    } catch (error) {
        cancelDownloadId = null;
        activeDownloadId = null;
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

ipcMain.handle('clear-cached-maps', async () => {
    try {
        const tempDir = path.join(os.tmpdir(), 'trackmania-maps');
        if (!fs.existsSync(tempDir)) return { success: true, count: 0 };
        const files = fs.readdirSync(tempDir).filter(f => f.endsWith('.Map.Gbx'));
        for (const file of files) {
            fs.unlinkSync(path.join(tempDir, file));
        }
        log(`Cleared ${files.length} cached maps`);
        return { success: true, count: files.length };
    } catch (error) {
        log(`Error clearing cached maps: ${error.message}`);
        return { success: false, error: error.message };
    }
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

ipcMain.handle('get-tmx-user', async () => {
    return config.tmxUser || null;
});

ipcMain.handle('save-tmx-user', async (event, payload) => {
    try {
        const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
        const userId = Number.isFinite(Number(payload?.userId)) ? Number(payload.userId) : null;
        config.tmxUser = name || userId ? { name, userId } : null;
        saveConfig();
        return { success: true };
    } catch (error) {
        log(`Error saving TMX user: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-local-pbs', async () => {
    try {
        const pbs = await loadLocalPersonalBests();
        return { success: true, pbs };
    } catch (error) {
        log(`Error loading local PBs: ${error.message}`);
        return { success: false, error: error.message };
    }
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

ipcMain.handle('cancel-download', async (event, mapId) => {
    if (cancelDownloadId === mapId) {
        cancelDownloadId = null;
        log(`Download cancelled for map: ${mapId}`);
        return true;
    }
    return false;
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

ipcMain.handle('nadeo-login-ubisoft', async (event, { email, password }) => {
    try {
        const result = await loginWithUbisoft(email, password);
        return result;
    } catch (error) {
        log(`Nadeo Ubisoft login failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('nadeo-login-oauth', async (event, { clientId, clientSecret }) => {
    try {
        const result = await loginWithOAuth(clientId, clientSecret);
        return result;
    } catch (error) {
        log(`Nadeo OAuth login failed: ${error.message}`);
        stopOAuthServer();
        return { success: false, error: error.message };
    }
});

ipcMain.handle('nadeo-logout', async () => {
    logoutNadeo();
    return { success: true };
});

ipcMain.handle('nadeo-status', async () => {
    return {
        authenticated: isNadeoAuthenticated(),
        authMethod: config.nadeoAuthMethod || null,
        accountId: nadeoAccountId,
    };
});

ipcMain.handle('nadeo-get-pbs', async (event, { mapUids }) => {
    try {
        if (!isNadeoAuthenticated()) {
            return { success: false, error: 'Not authenticated', pbs: {} };
        }
        const pbs = await fetchNadeoPbs(mapUids || []);
        return { success: true, pbs };
    } catch (error) {
        log(`Error fetching Nadeo PBs: ${error.message}`);
        return { success: false, error: error.message, pbs: {} };
    }
});

ipcMain.handle('nadeo-restore-session', async () => {
    try {
        const restored = await restoreNadeoSession();
        return { success: restored };
    } catch (error) {
        log(`Nadeo session restore failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('tmio-get-auth-token', async () => {
    return config.tmioAuthToken || null;
});

ipcMain.handle('tmio-save-auth-token', async (event, token) => {
    try {
        const trimmed = (token || '').trim();
        config.tmioAuthToken = trimmed || null;
        saveConfig();
        tmioPbCache = null;
        tmioPbCacheAt = 0;
        return { success: true };
    } catch (error) {
        log(`Error saving TMIO auth token: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('tmio-get-pbs', async (event, { mapUids }) => {
    try {
        if (!config.tmioAuthToken) {
            return { success: false, error: 'Not authenticated', pbs: {} };
        }
        const pbs = await fetchTmioPbs(mapUids || []);
        return { success: true, pbs };
    } catch (error) {
        log(`Error fetching trackmania.io PBs: ${error.message}`);
        return { success: false, error: error.message, pbs: {} };
    }
});

ipcMain.handle('tmio-get-pb-single', async (event, { mapUid }) => {
    try {
        if (!config.tmioAuthToken) {
            return { success: false, error: 'Not authenticated' };
        }
        if (!mapUid) {
            return { success: false, error: 'No mapUid provided' };
        }
        const data = await tmioApiRequest(
            `${TMIO_API_BASE}/leaderboard/personal/map/${mapUid}`,
            config.tmioAuthToken
        );
        if (data && typeof data.time === 'number' && data.time > 0) {
            return {
                success: true,
                pb: {
                    time: data.time,
                    medal: data.medal !== undefined ? data.medal : null,
                    timestamp: data.timestamp || null,
                },
            };
        }
        return { success: true, pb: null };
    } catch (error) {
        log(`TMIO PB fetch failed for map ${mapUid}: ${error.message}`);
        return { success: false, error: error.message };
    }
});

let tmioLoginWindow = null;

ipcMain.handle('tmio-login', async () => {
    return new Promise((resolve) => {
        if (tmioLoginWindow) {
            try { tmioLoginWindow.close(); } catch {}
        }

        tmioLoginWindow = new BrowserWindow({
            width: 900,
            height: 700,
            title: 'Login to trackmania.io',
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
            },
        });

        tmioLoginWindow.loadURL('https://trackmania.io');

        let resolved = false;
        let pollInterval = null;

        function cleanup() {
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
        }

        async function checkForToken() {
            if (resolved || !tmioLoginWindow || tmioLoginWindow.isDestroyed()) return;
            try {
                const token = await tmioLoginWindow.webContents.executeJavaScript(
                    'localStorage.getItem("tmio-secret")', true
                );
                if (token && token.length > 10) {
                    resolved = true;
                    cleanup();
                    config.tmioAuthToken = token;
                    saveConfig();
                    tmioPbCache = null;
                    tmioPbCacheAt = 0;
                    log('Trackmania.io auth token captured successfully');
                    try { tmioLoginWindow.close(); } catch {}
                    tmioLoginWindow = null;
                    resolve({ success: true });
                }
            } catch (e) {
                // Page may not be loaded yet or cross-origin restriction
            }
        }

        pollInterval = setInterval(checkForToken, 1000);

        tmioLoginWindow.webContents.once('did-navigate', () => {
            checkForToken();
        });

        tmioLoginWindow.webContents.once('did-finish-load', () => {
            setTimeout(checkForToken, 2000);
        });

        tmioLoginWindow.on('closed', () => {
            cleanup();
            tmioLoginWindow = null;
            if (!resolved) {
                resolved = true;
                resolve({ success: false, error: 'Login window closed' });
            }
        });
    });
});
