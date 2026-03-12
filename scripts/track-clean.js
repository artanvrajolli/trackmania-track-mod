const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = path.join(os.tmpdir(), 'trackmania-maps');

console.log('Temp Dir:', tempDir);
try {
    if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log(`Removed Trackmania temp maps: ${tempDir}`);
    } else {
        console.log(`Trackmania temp maps folder does not exist: ${tempDir}`);
    }
} catch (error) {
    console.error(`Failed to clean Trackmania temp maps: ${error.message}`);
}

try {
    const historyPath = path.join(os.tmpdir(), 'trackmania-history.json');
    if (fs.existsSync(historyPath)) {
        fs.unlinkSync(historyPath);
        console.log(`Removed Trackmania history: ${historyPath}`);
    }
    const markerPath = path.join(os.tmpdir(), 'trackmania-clean-marker');
    fs.writeFileSync(markerPath, Date.now().toString());
    console.log(`Created clean marker: ${markerPath}`);
} catch (error) {
    console.error(`Failed to clean Trackmania history: ${error.message}`);
}
