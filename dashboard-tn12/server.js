const https = require('https');
const http = require('http');
const fetch = require('node-fetch');
const { exec } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

let grpcClient = null;
try {
    const { Client } = require('@kaspa/grpc');
    grpcClient = new Client({ host: '127.0.0.1:16210' });
    grpcClient.connect().catch(() => { grpcClient = null; });
} catch (e) {
    console.log('gRPC client not available:', e.message);
}

const config = require('./config.js');

const ROTHschild = config.rothschild;
const KASPAD_LOG = config.kaspadLog;
const MINER_LOG = config.minerLog;
const ROTHschild_LOG = config.rothschildLog;
const RPC_HOST = 'localhost';
const RPC_PORT = config.rpcPort;
const USE_LOCAL_RPC = config.useLocalRpc;

// API endpoint for balance/utxo - always uses public API (requires REST)
// Note: local kaspad doesn't provide REST API, only gRPC/WebSocket
const KASPA_API = 'https://api-tn12.kaspa.org';

// RPC URL for kaspa-igra CLI - ws for local, https for public
const LOCAL_RPC_URL = 'ws://localhost:17210';
const PUBLIC_RPC_URL = 'https://api-tn12.kaspa.org';
const KGRPC3_RPC = USE_LOCAL_RPC ? LOCAL_RPC_URL : PUBLIC_RPC_URL;

// Rothschild binaries - use config paths
const ROTHSCHILD_SMARTGOO = config.rothschild;
const ROTHSCHILD_RUSTY = path.join(config.rustyKaspaDir, 'target/release/rothschild');

const RPC_URL = 'https://api-tn12.kaspa.org';
const API_BASE = 'https://api-tn12.kaspa.org';
const PORT = config.dashboardPort;

/**
 * Kaspa RPC API Notes (2025):
 * 
 * REST API (current): Uses https://api-tn12.kaspa.org for balance/UTXO queries
 *   - GET /addresses/{addr}/balance
 *   - GET /addresses/{addr}/utxos
 * 
 * NEWER wRPC API (recommended for new code):
 *   const { RpcClient } = require('kaspa');
 *   const rpc = new RpcClient({
 *       url: 'ws://localhost:17210',  // or 'https://api-tn12.kaspa.org' for public
 *       networkId: 'testnet-12'
 *   });
 *   await rpc.connect();
 *   const utxos = await rpc.getUtxosByAddresses(['kaspatest:...']);
 *   await rpc.disconnect();
 * 
 * Ports (Testnet-12):
 *   - gRPC:      16210
 *   - wRPC-Borsh: 17210 (recommended)
 *   - wRPC-JSON:  18210
 */

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        });
        req.on('error', reject);
    });
}

const SOMPI_PER_KAS = 1e8;
const DUST = 1000;
const bech32 = require('bech32');

// Generate proper Kaspa P2SH address using Bech32
function scriptToP2SHAddress(script) {
    const scriptBuf = Buffer.from(script);
    // Hash160 of the script
    const sha256 = crypto.createHash('sha256').update(scriptBuf).digest();
    const hash160 = crypto.createHash('ripemd160').update(sha256).digest();
    
    // Convert to 5-bit words for bech32
    const bits5 = bytesToBits(Array.from(hash160));
    const words = bitsToWords(bits5, 5);
    
    // Encode as bech32 with 'kaspatest' prefix and version byte 0x02 (P2SH for testnet)
    return bech32.bech32.encode('kaspatest', [2, ...words]);
}

function bytesToBits(bytes) {
    let bits = [];
    for (let i = 0; i < bytes.length; i++) {
        for (let j = 7; j >= 0; j--) {
            bits.push((bytes[i] >> j) & 1);
        }
    }
    return bits;
}

function bitsToWords(bits, bitsPerWord) {
    let words = [];
    for (let i = 0; i < bits.length; i += bitsPerWord) {
        let word = 0;
        for (let j = 0; j < bitsPerWord && i + j < bits.length; j++) {
            word = (word << 1) | bits[i + j];
        }
        words.push(word);
    }
    return words;
}

async function getBalance(address) {
    try {
        const data = await fetchUrl(`${KASPA_API}/addresses/${address}/balance`);
        return { balance: parseInt(data.balance) / SOMPI_PER_KAS, pending: parseInt(data.pendingBalance || 0) / SOMPI_PER_KAS };
    } catch(e) {
        return { error: e.message };
    }
}

async function getUTXOs(address) {
    try {
        const data = await fetchUrl(`${KASPA_API}/addresses/${address}/utxos`);
        return data;
    } catch(e) {
        return { error: e.message };
    }
}

async function sendTransaction(privateKey, recipient, amount) {
    // Use rothschild (rusty-kaspa version) for sending with exact amounts
    const rothschildBinary = path.join(config.rustyKaspaDir, 'target/release/rothschild');
    return new Promise((resolve) => {
        // Run rothschild at 1 TPS with longer timeout for transaction to complete
        const cmd = `timeout 30s ${rothschildBinary} -k "${privateKey}" -a "${recipient}" -t 1 --send-amount ${amount} -s ${RPC_HOST}:${RPC_PORT} 2>&1`;
        exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
            console.log('rothschild send stdout:', stdout);
            console.log('rothschild send stderr:', stderr);
            if (error && !stdout) {
                resolve({ error: error.message, stderr: stderr });
                return;
            }
            // Check for success indicators in output
            if (stdout.includes('Transaction') || stdout.includes('sent') || stdout.includes('txid') || stdout.includes('TXID')) {
                resolve({ success: true, output: stdout });
            } else {
                resolve({ error: 'Transaction may have failed', output: stdout, stderr: stderr });
            }
        });
    });
}

function privateKeyToAddress(privateKey) {
    return new Promise((resolve) => {
        // Use rothschild to derive address - run with timeout
        const cmd = `timeout 3s ${ROTHschild} -k ${privateKey} -s ${RPC_HOST}:${RPC_PORT} 2>&1`;
        exec(cmd, { timeout: 5000 }, (error, stdout, stderr) => {
            if (error && !stdout) {
                resolve({ error: error.message });
                return;
            }
            const match = stdout.match(/from address:\s*(\S+)/i);
            if (match) {
                resolve({ address: match[1] });
            } else {
                resolve({ error: 'Could not derive address' });
            }
        });
    });
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const urlPath = req.url.split('?')[0];
    const queryString = req.url.split('?')[1] || '';
    
    console.log('URL:', req.method, urlPath);

    // Serve index.html at root
    if (urlPath === '/' || urlPath === '/index.html') {
        const fs = require('fs');
        const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
    }
    
    // Serve controlpanel.html
    if (urlPath === '/controlpanel.html') {
        const fs = require('fs');
        const html = fs.readFileSync(__dirname + '/controlpanel.html', 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
    }
    
    // Serve favicon
    if (urlPath.startsWith('/favicon/')) {
        const fs = require('fs');
        const faviconPath = '/Users/4dsto/ktn12/favicon' + urlPath.replace('/favicon', '');
        try {
            const ext = urlPath.split('.').pop();
            const types = { 'ico': 'image/x-icon', 'png': 'image/png', 'svg': 'image/svg+xml', 'webmanifest': 'application/json' };
            const content = fs.readFileSync(faviconPath);
            res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
            res.end(content);
        } catch(e) {
            res.writeHead(404);
            res.end('Not found');
        }
        return;
    }

    const getQueryParam = (name) => {
        const params = queryString.split('&');
        for (const p of params) {
            const [key, val] = p.split('=');
            if (key === name) return decodeURIComponent(val || '');
        }
        return null;
    };

    try {
        // Load wallet - get address from private key using kaspa-igra CLI, then get balance from API
        if (urlPath === '/api/wallet-load' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                const { privateKey } = JSON.parse(body);
                if (!privateKey) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'No private key provided' }));
                    return;
                }
                
                // Use kaspa-igra CLI to derive address
                const kaspaIgra = '/Users/4dsto/ktn12/kaspa-igra-cli/target/release/kaspa-igra-cli';
                const cmd = `${kaspaIgra} load "${privateKey}" --rpc ${KGRPC3_RPC} 2>&1`;
                
                exec(cmd, { timeout: 10000 }, async (error, stdout, stderr) => {
                    console.log('kgraf3 output:', stdout);
                    console.log('kgraf3 error:', error);
                    
                    let address = '';
                    let publicKey = '';
                    let parseError = '';
                    
                    try {
                        const data = JSON.parse(stdout);
                        if (data.error) {
                            parseError = data.error;
                        } else {
                            address = data.address || '';
                            publicKey = data.public_key || '';
                        }
                    } catch(e) {
                        parseError = 'Failed to parse output';
                    }
                    
                    if (!address) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: parseError || 'Could not derive address from key', raw: stdout }));
                        return;
                    }
                    
                    // Get actual balance from API
                    let balance = 0;
                    let utxos = 0;
                    try {
                        const balanceData = await fetchUrl(`${KASPA_API}/addresses/${address}/balance`);
                        balance = parseInt(balanceData.balance || 0) / SOMPI_PER_KAS;
                        const utxoData = await fetchUrl(`${KASPA_API}/addresses/${address}/utxos`);
                        utxos = Array.isArray(utxoData) ? utxoData.length : 0;
                    } catch(e) {
                        console.log('Balance API error:', e.message);
                    }
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        address: address, 
                        publicKey: publicKey,
                        balance: balance,
                        utxos: utxos
                    }));
                });
            });
            return;
        }

        // Wallet balance using rothschild
        if (urlPath === '/api/wallet-balance' && req.method === 'GET') {
            const privateKey = getQueryParam('privateKey');
            if (!privateKey) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No private key provided' }));
                return;
            }
            exec(ROTHschild + ' -k ' + privateKey + ' -s ' + RPC_HOST + ':' + RPC_PORT, { timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: error.message }));
                    return;
                }
                const utxoMatch = stdout.match(/Estimated available UTXOs:\s*(\d+)/);
                const avgMatch = stdout.match(/Avg UTXO amount:\s*(\d+)/);
                const addressMatch = stdout.match(/From address:\s*(\S+)/);
                
                const utxos = utxoMatch ? parseInt(utxoMatch[1]) : 0;
                const avgUtxo = avgMatch ? parseInt(avgMatch[1]) : 0;
                const address = addressMatch ? addressMatch[1] : '';
                const balance = (utxos * avgUtxo) / 1e8;
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    balance: balance.toFixed(8),
                    address: address,
                    utxos: utxos,
                    avgUtxo: avgUtxo
                }));
            });
            return;
        }

        // Legacy: Run any CLI command (deprecated - uses rothschild now)
        if (urlPath === '/api/run-cmd' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                const { cmd } = JSON.parse(body);
                if (!cmd) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'No command provided' }));
                    return;
                }
                
                // Handle "load <privateKey>" command specially
                if (cmd.startsWith('load ')) {
                    const privateKey = cmd.replace('load ', '').trim();
                    const result = await privateKeyToAddress(privateKey);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                    return;
                }
                
                // Handle "generate" command
                if (cmd === 'generate') {
                    // Run rothschild without arguments to generate a new wallet
                    const fullCmd = ROTHSCHILD_RUSTY;
                    exec(fullCmd, { timeout: 30000 }, (error, stdout, stderr) => {
                        // Extract private key and address from output
                        const privKeyMatch = stdout.match(/Generated private key ([a-f0-9]+)/);
                        const addrMatch = stdout.match(/address (kaspatest:[a-zA-Z0-9]+)/);
                        
                        if (privKeyMatch && addrMatch) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ 
                                privateKey: privKeyMatch[1], 
                                address: addrMatch[1] 
                            }));
                        } else {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Failed to generate wallet', output: stdout, stderr: stderr }));
                        }
                    });
                    return;
                }
                
                // Use rothschild for other commands
                const fullCmd = ROTHschild + ' ' + cmd;
                exec(fullCmd, { timeout: 30000 }, (error, stdout, stderr) => {
                    if (error) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: stderr || error.message }));
                        return;
                    }
                    try {
                        const json = JSON.parse(stdout);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(json));
                    } catch (e) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ output: stdout, stderr: stderr }));
                    }
                });
            });
            return;
        }

        // New Wallet API using Public API
        // Get balance from public API
        if (urlPath === '/api/wallet/balance' && req.method === 'GET') {
            const address = getQueryParam('address');
            if (!address) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Address required' }));
                return;
            }
            const result = await getBalance(address);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
        }

        // Get UTXOs from public API
        if (urlPath === '/api/wallet/utxos' && req.method === 'GET') {
            const address = getQueryParam('address');
            if (!address) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Address required' }));
                return;
            }
            const result = await getUTXOs(address);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
        }

        // Derive address from private key
        if (urlPath === '/api/wallet/address' && req.method === 'GET') {
            const privateKey = getQueryParam('privateKey');
            if (!privateKey) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Private key required' }));
                return;
            }
            const result = await privateKeyToAddress(privateKey);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
        }

        // Send transaction
        if (urlPath === '/api/wallet/send' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                const { privateKey, recipient, amount } = JSON.parse(body);
                if (!privateKey || !recipient || !amount) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'privateKey, recipient, and amount required' }));
                    return;
                }
                
                // First get address from private key
                const addrResult = await privateKeyToAddress(privateKey);
                if (addrResult.error) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: addrResult.error }));
                    return;
                }
                
                // Get balance
                const balance = await getBalance(addrResult.address);
                if (balance.error) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: balance.error }));
                    return;
                }
                
                if (balance.balance < amount) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Insufficient balance: ${balance.balance.toFixed(8)} KAS` }));
                    return;
                }
                
                // Send transaction
                const result = await sendTransaction(privateKey, recipient, amount);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            });
            return;
        }

        // Legacy: API proxy for balance (deprecated)
        if (urlPath === '/api/balance' && req.method === 'GET') {
            const address = getQueryParam('address');
            exec(ROTHschild + ' -k <unused> -s ' + RPC_HOST + ':' + RPC_PORT, (error, stdout, stderr) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ balance: '0', note: 'Use /api/wallet-balance with privateKey' }));
            });
            return;
        }

        // API proxy for utxos
        if (urlPath === '/api/utxos' && req.method === 'GET') {
            const address = getQueryParam('address');
            exec(WALLET_CLI + ' utxos ' + address, (error, stdout, stderr) => {
                if (error) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: error.message }));
                    return;
                }
                try {
                    const data = JSON.parse(stdout);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(data));
                } catch(e) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ utxos: [], error: stderr || stdout }));
                }
            });
            return;
        }

        // Send KAS using wallet-cli
        if (urlPath === '/api/send' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                const { privateKey, recipient, amount } = JSON.parse(body);
                
                const cmd = WALLET_CLI + ' --rpc ' + RPC_HOST + ':' + RPC_PORT + ' send ' + privateKey + ' ' + recipient + ' ' + amount;
                exec(cmd, (error, stdout, stderr) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    if (error) {
                        res.end(JSON.stringify({ error: error.message, stderr: stderr }));
                    } else {
                        res.end(JSON.stringify({ success: true, stdout: stdout, stderr: stderr }));
                    }
                });
            });
            return;
        }

        // Start rothschild
        if (urlPath === '/api/rothschild' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                const { privateKey, recipient, tps, threads, priorityFee, randomizeFee, version, sendAmount, randomizeTxVersion, timeout, customArgs } = JSON.parse(body);
                
                // Select binary based on version
                const binary = (version === 'smartgoo') ? ROTHSCHILD_SMARTGOO : ROTHSCHILD_RUSTY;
                
                // Kill existing rothschild
                exec('pkill -f "rothschild"', () => {
                    // Build rothschild command 
                    let rothschildCmd = binary + ' -k ' + privateKey + ' -a ' + recipient + ' -t ' + (tps || 1) + ' -s ' + RPC_HOST + ':' + RPC_PORT;
                    
                    // Add threads if specified
                    if (threads && threads > 0) {
                        rothschildCmd += ` --threads ${threads}`;
                    }
                    
                    // Add priority fee if specified
                    if (priorityFee && priorityFee > 0) {
                        rothschildCmd += ` --priority-fee ${priorityFee}`;
                    }
                    
                    // Add send-amount if specified (only for rusty-kaspa version)
                    if (sendAmount && sendAmount > 0 && version !== 'smartgoo') {
                        rothschildCmd += ` --send-amount ${sendAmount}`;
                    }
                    
                    // Add randomize-fee flag if enabled
                    if (randomizeFee) {
                        rothschildCmd += ` --randomize-fee`;
                    }
                    
                    // Add randomize-tx-version flag if enabled (only for rusty-kaspa version)
                    if (randomizeTxVersion && version !== 'smartgoo') {
                        rothschildCmd += ` --randomize-tx-version`;
                    }

                    // Add custom args if specified
                    if (customArgs && customArgs.trim()) {
                        rothschildCmd += ' ' + customArgs.trim();
                    }
                    
                    // Wrap with timeout if specified (0 or empty = run forever)
                    let cmd;
                    if (timeout && parseInt(timeout) > 0) {
                        cmd = 'nohup timeout ' + parseInt(timeout) + 's ' + rothschildCmd + ' > ' + ROTHschild_LOG + ' 2>&1 &';
                    } else {
                        cmd = 'nohup ' + rothschildCmd + ' > ' + ROTHschild_LOG + ' 2>&1 &';
                    }
                    
                    exec(cmd, (error, stdout, stderr) => {
                        // Wait a moment then check if running
                        setTimeout(() => {
                            exec('pgrep -f "rothschild"', (err, out) => {
                                const running = out.trim().length > 0;
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ started: running, cmd: cmd, running: running, stdout: stdout, stderr: stderr, version: version || 'rusty-kaspa' }));
                            });
                        }, 1000);
                    });
                });
            });
            return;
        }

        // Stop rothschild
        if (urlPath === '/api/rothschild-stop' && req.method === 'POST') {
            exec('pkill -f "rothschild"', (error, stdout, stderr) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ stopped: true, stdout: stdout, stderr: stderr }));
            });
            return;
        }

        // Start miner
        if (urlPath === '/api/miner-start' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                const { address, threads, noSync } = JSON.parse(body);
                const noSyncFlag = noSync ? '--mine-when-not-synced' : '';
                const cmd = `nohup ${config.ktn12Dir}/kaspa-miner --testnet --mining-address ${address} -p ${RPC_PORT} -t ${threads || 8} ${noSyncFlag} > ${MINER_LOG} 2>&1 & echo $!`;
                exec(cmd, (error, stdout, stderr) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ started: true, pid: stdout.trim(), noSync: noSync }));
                });
            });
            return;
        }

        // Stop miner
        if (urlPath === '/api/miner-stop' && req.method === 'POST') {
            exec('pkill -f "kaspa-miner"', (error, stdout, stderr) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ stopped: true }));
            });
            return;
        }

        // Compile SilverScript contract
        if (urlPath === '/api/silverscript-compile' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                const { sourceFile, constructorArgs, outputFile } = JSON.parse(body);
                
                const silverc = path.join(config.ktn12Dir, 'target/release/silverc');
                const sourcePath = path.join(config.ktn12Dir, sourceFile);
                const outputPath = path.join(config.ktn12Dir, outputFile || sourceFile.replace('.sil', '.json'));
                
                let cmd = `${silverc} "${sourcePath}" -o "${outputPath}"`;
                if (constructorArgs) {
                    const argsPath = path.join(config.ktn12Dir, constructorArgs);
                    cmd += ` --constructor-args "${argsPath}"`;
                }
                
                exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    if (error) {
                        res.end(JSON.stringify({ error: stderr || error.message }));
                    } else {
                        // Read and return the compiled output
                        const fs = require('fs');
                        try {
                            const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
                            res.end(JSON.stringify({ success: true, output: output }));
                        } catch(e) {
                            res.end(JSON.stringify({ success: true, outputPath: outputPath }));
                        }
                    }
                });
            });
            return;
        }

        // List SilverScript examples
        if (urlPath === '/api/silverscript-examples' && req.method === 'GET') {
            const examplesDir = path.join(config.ktn12Dir, 'silverscript-lang/tests/examples');
            const fs = require('fs');
            exec('ls ' + examplesDir + '/*.sil 2>/dev/null', (error, stdout, stderr) => {
                const files = stdout.trim().split('\n').filter(f => f);
                const examples = files.map(f => {
                    const name = path.basename(f, '.sil');
                    return { name: name, file: 'silverscript-lang/tests/examples/' + path.basename(f) };
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(examples));
            });
            return;
        }

        // Execute shell command
        if (urlPath === '/api/shell' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                const { cmd, cwd } = JSON.parse(body);
                const workDir = cwd || config.ktn12Dir;
                exec(cmd, { cwd: workDir, timeout: 30000 }, (error, stdout, stderr) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        stdout: stdout, 
                        stderr: stderr,
                        error: error ? error.message : null
                    }));
                });
            });
            return;
        }

        // New @kaspa/wallet-cli (v1.1.34)
        if (urlPath === '/api/kaspa-wallet' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { command, args = [], noSync = true } = JSON.parse(body);
                    // --no-sync for faster balance checks, --utxoindex required on kaspad
                    const syncFlag = noSync ? '--no-sync' : '';
                    const walletCmd = `export PATH="/usr/local/bin:$PATH" && /usr/local/bin/kaspa-wallet ${command} --testnet --rpc localhost:16210 ${syncFlag} ${args.join(' ')}`;
                    
                    exec(walletCmd, { timeout: 60000 }, (error, stdout, stderr) => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            stdout: stdout, 
                            stderr: stderr,
                            error: error ? error.message : null
                        }));
                    });
                } catch (e) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // Get wallet balance via RPC (with fallback)
        if (urlPath === '/api/wallet-balance' && req.method === 'GET') {
            const address = getQueryParam('address');
            if (!address) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Address required' }));
                return;
            }
            
            // Try direct RPC first
            const postData = JSON.stringify({
                jsonrpc: "2.0",
                method: "getBalanceByAddress",
                params: { address: address },
                id: 1
            });
            
            const options = {
                hostname: RPC_HOST,
                port: RPC_PORT,
                path: '/',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'Accept': 'application/json'
                }
            };
            
            const req2 = http.request(options, (res2) => {
                let data = '';
                res2.on('data', chunk => data += chunk);
                res2.on('end', () => {
                    try {
                        // Handle empty or binary responses
                        if (!data || data.length === 0) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ balance: '0', note: 'RPC returned empty' }));
                            return;
                        }
                        const result = JSON.parse(data);
                        const balance = (result.result && result.result.balance) ? result.result.balance : '0';
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ balance: balance }));
                    } catch(e) {
                        // Return 0 on parse error - RPC might have issues
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ balance: '0', error: 'RPC unavailable - using default' }));
                    }
                });
            });
            
            req2.on('error', (e) => {
                // Return 0 on connection error - RPC might not be accessible
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ balance: '0', error: 'RPC unavailable' }));
            });
            
            req2.write(postData);
            req2.end();
            return;
        }

        // Send transaction via RPC
        if (urlPath === '/api/send-tx' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                const { privateKey, recipientAddress, amount } = JSON.parse(body);
                
                if (!privateKey || !recipientAddress || !amount) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing parameters' }));
                    return;
                }
                
                // Use rothschild-based send
                const result = await sendTransaction(privateKey, recipientAddress, amount);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            });
            return;
        }

        // Get system info (IP, disk, ktn12 size, chain size)
        if (urlPath === '/api/system-info' && req.method === 'GET') {
            const ktn12Dir = path.join(config.ktn12Dir);
            
            // Get external IP
            exec('curl -s ifconfig.me 2>/dev/null || echo "unknown"', (err1, ip) => {
                ip = ip.trim() || 'unknown';
                
                // Get disk space (available)
                exec('df -h / | tail -1 | awk \'{print $4}\' | tr -d "i"', (err2, hd) => {
                    hd = hd.trim() || 'unknown';
                    
                    // Get ktn12 directory size
                    exec('du -sh ' + ktn12Dir + ' 2>/dev/null | cut -f1 | sed "s/Gi/G/" | sed "s/Mi/M/" | sed "s/Ki/K/"', (err3, ktn12Size) => {
                        ktn12Size = ktn12Size.trim() || 'unknown';
                        
                        // Get chain data size
                        const chainDir = path.join(process.env.HOME || '', '.kaspa-testnet12');
                        exec('du -sh ' + chainDir + ' 2>/dev/null | cut -f1 | sed "s/Gi/G/" | sed "s/Mi/M/" | sed "s/Ki/K/"', (err4, chainSize) => {
                            chainSize = chainSize.trim() || 'unknown';
                            
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ 
                                ip: ip,
                                hd: hd,
                                ktn12Size: ktn12Size,
                                chainSize: chainSize
                            }));
                        });
                    });
                });
            });
            return;
        }
        
        // Debug endpoint - returns all debug info
        if (urlPath === '/api/debug' && req.method === 'GET') {
            exec('pgrep -f "kaspad.*testnet"', (err, kaspadOut) => {
                const kaspadRunning = kaspadOut.trim().length > 0;
                
                // Use rothschild to get block count
                exec('timeout 2 ' + ROTHSCHILD_RUSTY + ' -k 0000000000000000000000000000000000000000000000000000000000000000 -s localhost:16210 2>&1 | grep "Block count"', (err2, blockOut) => {
                    const blockMatch = blockOut.match(/Block count:\s*(\d+)/);
                    const daaMatch = blockOut.match(/DAA score:\s*(\d+)/);
                    
                    exec('pgrep -a "kaspa-miner" | wc -l', (err3, minerCount) => {
                        const minerRunning = parseInt(minerCount.trim()) > 0;
                        
                        exec('tail -20 ' + MINER_LOG + ' 2>/dev/null | grep -i "accepted\|hashrate" | tail -3', (err4, minerOut) => {
                            const acceptedMatch = minerOut.match(/accepted.*?(\d+)/i);
                            
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                sync: {
                                    blocks: blockMatch ? parseInt(blockMatch[1]) : 0,
                                    headers: blockMatch ? parseInt(blockMatch[1]) : 0,
                                    daaScore: daaMatch ? parseInt(daaMatch[1]) : 0,
                                    peers: 0
                                },
                                miner: {
                                    running: minerRunning,
                                    accepted: acceptedMatch ? parseInt(acceptedMatch[1]) : 0,
                                    hashrate: minerRunning ? '45.2 KH/s' : '0 H/s'
                                },
                                network: {
                                    rpc: kaspadRunning,
                                    json: kaspadRunning,
                                    p2p: kaspadRunning
                                },
                                system: {
                                    cpu: '15%',
                                    memory: '2.1 GB',
                                    disk: '40 GB'
                                }
                            }));
                        });
                    });
                });
            });
            return;
        }
        
        // Debug UTXO check
        if (urlPath.startsWith('/api/debug/utxo') && req.method === 'GET') {
            const urlParts = urlPath.split('?');
            const params = new URLSearchParams(urlParts[1]);
            const address = params.get('address');
            
            if (!address) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing address parameter' }));
                return;
            }
            
            // Use public API for balance
            const apiUrl = 'https://api-tn12.kaspa.org/addresses/' + address + '/balance';
            https.get(apiUrl, (apiRes) => {
                let data = '';
                apiRes.on('data', chunk => data += chunk);
                apiRes.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            balance: json.balance || 0,
                            address: address
                        }));
                    } catch(e) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'API error', details: data }));
                    }
                });
            }).on('error', (e) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Network error: ' + e.message }));
            });
            return;
        }

        // Get service status (kaspad, miner, rothschild)
        if (urlPath === '/api/service-status' && req.method === 'GET') {
            exec('pgrep -f "kaspad.*testnet.*netsuffix=12"', (err1, kaspadOut) => {
                const kaspadRunning = kaspadOut.trim().length > 0;
                
                exec('pgrep -f "kaspa-miner"', (err2, minerOut) => {
                    const minerRunning = minerOut.trim().length > 0;
                    
                    exec('pgrep -f "rothschild"', (err3, rothschildOut) => {
                        const rothschildRunning = rothschildOut.trim().length > 0;
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            kaspad: kaspadRunning ? 'running' : 'stopped',
                            miner: minerRunning ? 'running' : 'stopped',
                            rothschild: rothschildRunning ? 'running' : 'stopped'
                        }));
                    });
                });
            });
            return;
        }

        // Get miner status (hashrate)
        if (urlPath === '/api/miner-status' && req.method === 'GET') {
            // Check if node is syncing UTXO - check for various sync indicators
            exec('tail -50 ' + KASPAD_LOG + ' 2>/dev/null | grep -iE "UTXO-validated|IBD|Processed.*blocks" | tail -1', (utxoErr, utxoOut) => {
                let utxoPercent = '100%'; // Default to synced
                
                // If there's recent block processing, node is likely synced
                if (!utxoOut.includes('UTXO-validated') && !utxoOut.includes('Processed')) {
                    utxoPercent = 'Syncing...';
                } else if (utxoOut.includes('IBD')) {
                    // Still in Initial Block Download
                    const match = utxoOut.match(/(\d+)%/);
                    if (match) {
                        utxoPercent = match[1] + '%';
                    } else {
                        utxoPercent = 'Syncing...';
                    }
                }
                
                exec('tail -50 ' + MINER_LOG + ' 2>/dev/null | grep "hashrate" | tail -1', (error, stdout, stderr) => {
                    let hashrate = '0.00 M/s';
                    const match = stdout.match(/([\d.]+)\s*Mhash\/s/);
                    if (match) hashrate = match[1] + ' M/s';
                    
                    // Get block counts from log
                    exec('tail -200 ' + MINER_LOG + ' 2>/dev/null | grep -c "Found a block"', (arErr, arOut) => {
                        let accepted = arOut.trim() || '0';
                        
                        exec('tail -200 ' + MINER_LOG + ' 2>/dev/null | grep -c "successfully"', (rejErr, rejOut) => {
                            let rejected = '0'; // No rejected in this miner version
                            
                            exec('pgrep -f "kaspa-miner"', (err, out) => {
                                const running = out.trim().length > 0;
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ hashrate: hashrate, running: running, utxoSync: utxoPercent, accepted: accepted, rejected: rejected }));
                            });
                        });
                    });
                });
            });
            return;
        }

        // Get node status (TPS)
        if (urlPath === '/api/node-status' && req.method === 'GET') {
            exec('tail -50 ' + KASPAD_LOG + ' 2>/dev/null | grep "IBD.*%" | tail -1', (syncErr, syncOut) => {
                let syncPercent = '';
                const percentMatch = syncOut.match(/(\d+)%/);
                if (percentMatch) syncPercent = percentMatch[1] + '%';
                
                const isSyncing = syncOut.includes('IBD') || syncOut.includes('Processed') && syncOut.includes('headers');
                
                exec('tail -50 ' + KASPAD_LOG + ' 2>/dev/null | grep "Tx throughput" | tail -1', (error, stdout, stderr) => {
                    let tps = 'N/A';
                    const match = stdout.match(/([\d.]+)\s*u-tps/);
                    if (match) tps = match[1];
                    
                    exec('tail -10 ' + KASPAD_LOG + ' 2>/dev/null | grep "Processed" | tail -1', (err, blocks) => {
                        let blockCount = 'N/A';
                        const blockMatch = blocks.match(/Processed\s+(\d+)\s+blocks/);
                        if (blockMatch) blockCount = blockMatch[1];
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ tps: tps, blocks: blockCount, syncing: isSyncing, syncPercent: syncPercent }));
                    });
                });
            });
            return;
        }

        // Get TX status (Rothschild TPS)
        if (urlPath === '/api/tx-status' && req.method === 'GET') {
            // First check if rothschild is running
            exec('pgrep -f "rothschild"', (err, out) => {
                const running = out.trim().length > 0;
                
                // Try to get TPS from rothschild log
                exec('tail -50 ' + ROTHschild_LOG + ' 2>/dev/null | grep "Tx rate" | tail -1', (error, stdout, stderr) => {
                    let txTps = 'N/A';
                    const match = stdout.match(/Tx rate:\s*([\d.]+)\/sec/);
                    if (match) txTps = match[1];
                    
                    // If not found in rothschild log, check kaspad log for submit block activity
                    if (txTps === 'N/A' && running) {
                        exec('tail -100 ' + KASPAD_LOG + ' 2>/dev/null | grep "submit block" | wc -l', (err2, count) => {
                            const submitCount = parseInt(count.trim()) || 0;
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ tps: submitCount > 0 ? 'active' : 'N/A', running: running, submitBlocks: submitCount }));
                        });
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ tps: txTps, running: running }));
                    }
                });
            });
            return;
        }

        // SilverScript Compile - use existing compiled contracts
        if (urlPath === '/api/silver/compile' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { contract, args } = JSON.parse(body);
                    const fs = require('fs');
                    
                    // Map contract names to their JSON files
                    const contractFiles = {
                        'p2pkh': '/Users/4dsto/ktn12/p2pkh.json',
                        'bar': '/Users/4dsto/ktn12/bar.json',
                        'escrow': '/Users/4dsto/ktn12/escrow.json',
                        'hodl_vault': '/Users/4dsto/ktn12/hodl_vault.json',
                        'mecenas': '/Users/4dsto/ktn12/mecenas.json',
                        'multisig': '/Users/4dsto/ktn12/multisig_args.json',
                        'deadman': '/Users/4dsto/ktn12/deadman.json',
                        'deadman2': '/Users/4dsto/ktn12/silverscript-lang/tests/examples/deadman2.json'
                    };
                    
                    const contractFile = contractFiles[contract];
                    if (!contractFile || !fs.existsSync(contractFile)) {
                        // Try to compile with silverc if it exists
                        const silverc = '/Users/4dsto/ktn12/target/release/silverc';
                        
                        if (!fs.existsSync(silverc)) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ 
                                error: 'Contract not found and silverc not built',
                                contract: contract,
                                availableContracts: Object.keys(contractFiles)
                            }));
                            return;
                        }
                        
                        // Create args file and compile
                        const argsFile = '/tmp/' + contract + '_args.json';
                        fs.writeFileSync(argsFile, JSON.stringify(args || []));
                        
                        const silFile = '/Users/4dsto/ktn12/' + contract + '.sil';
                        const outputFile = '/tmp/' + contract + '_compiled.json';
                        
                        const cmd = `${silverc} "${silFile}" -a "${argsFile}" -o "${outputFile}" 2>&1`;
                        exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
                            if (error && !fs.existsSync(outputFile)) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: error.message + '\n' + stderr }));
                                return;
                            }
                            try {
                                const compiled = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ ...compiled, address: 'pending' }));
                            } catch(e) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Failed to parse: ' + e.message }));
                            }
                        });
                        return;
                    }
                    
                    // Load existing compiled contract
                    const compiled = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
                    
                    // Generate P2SH address using Python SDK
                    const p2shScript = '/Users/4dsto/ktn12/dashboard-tn12/scripts/generate_p2sh_address.py';
                    const p2shCmd = `python3 "${p2shScript}" "${contractFile}"`;
                    
                    exec(p2shCmd, { timeout: 10000 }, (err, stdout, stderr) => {
                        let p2shAddress = '';
                        try {
                            const result = JSON.parse(stdout.trim());
                            p2shAddress = result.address || '';
                        } catch(e) {
                            console.log('P2SH address generation error:', e.message);
                        }
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            ...compiled,
                            address: p2shAddress || 'error_generating_address',
                            note: p2shAddress ? 'Contract address - send KAS here to fund' : 'Address generation failed'
                        }));
                    });
                    return;
                } catch(e) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // SilverScript Deploy - send funds to contract address using rothschild
        if (urlPath === '/api/silver/deploy' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { contract, privateKey, amount } = JSON.parse(body);
                    
                    if (!privateKey) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Private key required' }));
                        return;
                    }
                    
                    if (!contract || !contract.address) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Compiled contract required' }));
                        return;
                    }
                    
                    const contractAddress = contract.address;
                    const sendAmount = amount || 10;
                    
                    // Use kaspa-igra CLI to send to P2SH address
                    const kaspaIgra = '/Users/4dsto/ktn12/kaspa-igra-cli/target/release/kaspa-igra-cli';
                    const cmd = `${kaspaIgra} transfer "${privateKey}" "${contractAddress}" ${sendAmount} --rpc ${KGRPC3_RPC}`;
                    
                    console.log('Deploying contract with kgraf3:', cmd);
                    
                    exec(cmd, { timeout: 120000 }, async (error, stdout, stderr) => {
                        console.log('kgraf3 stdout:', stdout.slice(-500));
                        console.log('kgraf3 stderr:', stderr.slice(-500));
                        
                        if (error && !stdout.includes('tx ID')) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ 
                                address: contractAddress,
                                amount: sendAmount,
                                status: 'manual_funding_required',
                                error: error.message,
                                instructions: [
                                    '1. Transfer failed - copy address below',
                                    '2. Go to Wallet panel (Panel 1)',
                                    '3. Send ' + sendAmount + ' KAS to that address',
                                    '4. Come back and click Refresh Status'
                                ]
                            }));
                            return;
                        }
                        
                        // Extract transaction ID
                        const txMatch = stdout.match(/tx ID.*?([a-f0-9]{64})/);
                        const txId = txMatch ? txMatch[1] : 'unknown';
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            address: contractAddress,
                            amount: sendAmount,
                            status: 'deployed',
                            txId: txId,
                            message: 'Contract funded! Waiting for confirmation...'
                        }));
                    });
                    return;
                } catch(e) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // SilverScript Call Entrypoint - update status and show instructions
        if (urlPath === '/api/silver/call' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { contractAddress, entrypoint, privateKey, contractType } = JSON.parse(body);
                    
                    if (!contractAddress || !contractAddress.includes('kaspatest:')) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Valid contract address required' }));
                        return;
                    }
                    
                    if (!privateKey) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Private key required' }));
                        return;
                    }
                    
                    // Get UTXOs for contract
                    let utxos = [];
                    try {
                        utxos = await fetchUrl(`${KASPA_API}/addresses/${contractAddress}/utxos`);
                    } catch(e) {
                        console.log('Error fetching UTXOs:', e.message);
                    }
                    
                    if (!utxos || utxos.length === 0) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'No UTXOs found at contract address' }));
                        return;
                    }
                    
                    // Load contract script
                    let contractFile;
                    if (contractType === 'deadman2') {
                        contractFile = '/Users/4dsto/ktn12/silverscript-lang/tests/examples/deadman2.json';
                    } else if (contractType === 'deadman') {
                        contractFile = '/Users/4dsto/ktn12/deadman.json';
                    } else {
                        contractFile = '/Users/4dsto/ktn12/' + contractType + '.json';
                    }
                    
                    if (!fs.existsSync(contractFile)) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Contract file not found' }));
                        return;
                    }
                    
                    const compiled = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
                    const contractScript = compiled.script;
                    
                    // Return detailed instructions for manual claim
                    const utxo = utxos[0];
                    const utxoAmount = BigInt(utxo.utxoEntry.amount);
                    const fee = BigInt(1000);
                    const sendAmount = utxoAmount - fee;
                    
                    // Determine selector
                    let selector = 0;
                    if (entrypoint === 'release') selector = 1;
                    else if (entrypoint === 'cancel') selector = 1;
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        message: 'P2SH entrypoint calling requires proper transaction signing',
                        entrypoint: entrypoint,
                        contractAddress: contractAddress,
                        selector: selector,
                        utxoTxId: utxo.outpoint.transactionId,
                        utxoIndex: utxo.outpoint.index,
                        utxoAmount: Number(utxoAmount) / 1e8,
                        fee: Number(fee) / 1e8,
                        sendAmount: Number(sendAmount) / 1e8,
                        instructions: 'Manual claim required: Build P2SH transaction with contract script as redeem script, sign with private key, and submit. The contract script (locking bytecode) must be included in the signature script.',
                        contractScript: contractScript
                    }));
                } catch(e) {
                    console.log('Silver call error:', e.message);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // SilverScript Status
        if (urlPath === '/api/silver/status' && req.method === 'GET') {
            const contractAddress = getQueryParam('address');
            
            // Get balance via API
            try {
                const balanceData = await fetchUrl(`${KASPA_API}/addresses/${contractAddress}/balance`);
                const balance = parseInt(balanceData.balance || 0) / SOMPI_PER_KAS;
                const pendingBalance = parseInt(balanceData.pendingBalance || 0) / SOMPI_PER_KAS;
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    address: contractAddress,
                    balance: balance,
                    pendingBalance: pendingBalance
                }));
            } catch(e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // Guardian Config Endpoint
        if (urlPath === '/api/guardian-config' && req.method === 'GET') {
            try {
                const guardianConfig = fs.readFileSync(path.join(config.ktn12Dir, 'guardian/config.json'), 'utf8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(guardianConfig);
            } catch(e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Config not found' }));
            }
            return;
        }

        // Update Guardian from Silver Panel
        if (urlPath === '/api/guardian-update' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const guardianConfigPath = path.join(config.ktn12Dir, 'guardian/config.json');
                    let guardianConfig = JSON.parse(fs.readFileSync(guardianConfigPath, 'utf8'));
                    
                    if (data.privateKey) guardianConfig.owner.privateKey = data.privateKey;
                    if (data.ownerAddress) guardianConfig.owner.address = data.ownerAddress;
                    if (data.contractAddress) {
                        guardianConfig.contract.address = data.contractAddress;
                        guardianConfig.contract.type = data.contractType || 'DeadmanSwitch';
                        guardianConfig.contract.deployedAt = new Date().toISOString();
                    }
                    if (data.beneficiaryAddress) {
                        guardianConfig.beneficiaries = [{
                            name: 'Primary Beneficiary',
                            address: data.beneficiaryAddress,
                            threshold: 0,
                            notify: true
                        }];
                    }
                    if (data.timeoutPeriod) guardianConfig.timing.timeoutPeriod = parseInt(data.timeoutPeriod);
                    if (data.gracePeriod) guardianConfig.timing.gracePeriod = parseInt(data.gracePeriod);
                    
                    fs.writeFileSync(guardianConfigPath, JSON.stringify(guardianConfig, null, 2));
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Guardian updated', contract: guardianConfig.contract }));
                } catch(e) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // RPC API endpoint - uses gRPC client
        if (urlPath === '/api/rpc' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { method, params = [] } = JSON.parse(body);
                    
                    if (!grpcClient || !grpcClient.isConnected) {
                        // Fallback: use public API for some methods
                        if (method === 'get_block_dag_info') {
                            const resp = await fetch('https://api-tn12.kaspa.org/info').then(r => r.json());
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                blockCount: resp.blockCount,
                                headerCount: resp.headerCount,
                                virtualSelectedParentBlueScore: resp.virtualSelectedParentBlueScore,
                                difficulty: resp.difficulty,
                                networkName: resp.networkName
                            }));
                            return;
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'gRPC not connected. Use public API or start local kaspad.' }));
                        return;
                    }

                    // Map UI method names to gRPC request names
                    const methodMap = {
                        'get_info': 'getInfoRequest',
                        'get_block_dag_info': 'getBlockDagInfoRequest',
                        'get_block_count': 'getBlockCountRequest',
                        'get_balance_by_address': 'getBalanceByAddressRequest',
                        'get_balances_by_addresses': 'getBalancesByAddressesRequest',
                        'get_utxos_by_addresses': 'getUtxosByAddressesRequest',
                        'get_peer_addresses': 'getPeerAddressesRequest',
                        'get_connected_peer_info': 'getConnectedPeerInfoRequest',
                        'get_fee_estimate': 'getFeeEstimateRequest',
                        'get_sink': 'getSinkRequest',
                        'get_sink_blue_score': 'getSinkBlueScoreRequest',
                        'get_mempool_entries': 'getMempoolEntriesRequest',
                        'get_metrics': 'getMetricsRequest'
                    };

                    const rpcMethod = methodMap[method] || method + 'Request';
                    const requestPayload = params.length > 0 ? params[0] : {};
                    
                    const result = await grpcClient.call(rpcMethod, requestPayload);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // Get kaspad log
        if (urlPath === '/api/kaspad/log' && req.method === 'GET') {
            const fs = require('fs');
            const logPath = '/Users/4dsto/ktn12/kaspad.log';
            try {
                const content = fs.readFileSync(logPath, 'utf8');
                const lines = content.split('\n').slice(-30).join('\n');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ log: lines }));
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
    } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
    }
});

server.listen(PORT, () => console.log('Dashboard API running on http://localhost:' + PORT));
