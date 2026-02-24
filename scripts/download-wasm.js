const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

// Use a new directory to avoid EPERM on locked 'src/wasm'
const WASM_DIR = path.join(__dirname, '../src/grammars');

if (!fs.existsSync(WASM_DIR)) {
  fs.mkdirSync(WASM_DIR, { recursive: true });
}

// tree-sitter-wasms@0.0.97 is compatible with web-tree-sitter@0.26.5 (ABI 14)
// Latest versions use ABI 15+ which is incompatible
const BASE_URL = 'https://unpkg.com/tree-sitter-wasms@0.0.97/out';

const files = [
  'tree-sitter-javascript.wasm',
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-vue.wasm'
];

const downloadUrl = (url, dest, retries = 3) => {
    return new Promise((resolve, reject) => {
        const request = https.get(url, function(response) {
            if (response.statusCode === 302 || response.statusCode === 301) {
                if (!response.headers.location) {
                    return reject(new Error(`Redirect with no location for ${url}`));
                }
                const newUrl = new URL(response.headers.location, url).toString();
                // request.destroy(); // Optional, but good practice
                downloadUrl(newUrl, dest, retries).then(resolve).catch(reject);
                return;
            }
            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to download ${url}: ${response.statusCode} ${response.statusMessage}`));
            }
            
            const file = fs.createWriteStream(dest);
            response.pipe(file);
            file.on('finish', function() {
                file.close(() => resolve());
            });
            file.on('error', function(err) {
                // fs.unlink(dest, () => {});
                reject(err);
            });
        });
        
        request.on('error', (err) => {
             if (retries > 0) {
                setTimeout(() => {
                    downloadUrl(url, dest, retries - 1).then(resolve).catch(reject);
                }, 1000);
            } else {
                reject(err);
            }
        });
    });
};

async function main() {
    console.log(`Downloading WASM files to ${WASM_DIR}...`);
    for (const file of files) {
        const dest = path.join(WASM_DIR, file);
        try {
            if (fs.existsSync(dest)) {
                try { fs.unlinkSync(dest); } catch(e) {}
            }
            await downloadUrl(`${BASE_URL}/${file}`, dest, 3);
            console.log(`Downloaded ${file}`);
        } catch (err) {
            console.error(`Error downloading ${file}: ${err.message}`);
        }
    }
}

main();
