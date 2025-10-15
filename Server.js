const express = require('express');
const { exec, spawn } = require('child_process');
const cors = require('cors');
const mysql = require('mysql2/promise');
const net = require('net');

const app = express();
const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;

// Variable to hold the running tunnel process
let tunnelProcess = null;
let connectedEnv = null; // sit | uat1 | uat2 | null
let tunnelLocalPort = null;

// SSE clients
const sseClients = new Set();

function getCurrentStatus() {
    return {
        status: tunnelProcess ? 'connected' : 'disconnected',
        env: connectedEnv,
        pid: tunnelProcess?.pid || null,
        localPort: tunnelLocalPort,
    };
}

function broadcastStatus() {
    const payload = JSON.stringify({ type: 'status', ...getCurrentStatus() });
    for (const res of sseClients) {
        try {
            res.write(`data: ${payload}\n\n`);
        } catch (e) {
            // best-effort; stale connections will be cleaned up on 'close'
        }
    }
}

// Environment specific SSH tunnel settings
const envTunnel = {
    sit: { defaultLocalPort: 4085, remoteHost: 'cdx-sit2-crs-tidb.int-np.cardx.co.th' },
    uat1: { defaultLocalPort: 4023, remoteHost: 'cdx-uat-crs-tidb.int-np.cardx.co.th' },
    uat2: { defaultLocalPort: 4022, remoteHost: 'cdx-uat2-crs-tidb.int-np.cardx.co.th' }
};

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Teleport Backend Server is running and ready to receive requests.');
});

// Realtime connected status via Server-Sent Events (SSE)
app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Keep the connection alive
    const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) {}
    }, 25000);

    // Send initial status
    res.write(`data: ${JSON.stringify({ type: 'status', ...getCurrentStatus() })}\n\n`);

    sseClients.add(res);
    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
        try { res.end(); } catch (_) {}
    });
});

// Simple status endpoint for polling or diagnostics
app.get('/status', (req, res) => {
    res.json({ success: true, ...getCurrentStatus() });
});

// Expose server info (selected port)
app.get('/server-info', (req, res) => {
    res.json({ success: true, port: server?.address()?.port || null });
});

// Trigger Teleport SSO login (opens browser on the host machine)
app.post('/sso-login', (req, res) => {
    const proxy = 'cardx.teleport.sh:443';
    const loginCmd = `tsh login --proxy ${proxy} --auth=sso`;
    console.log(`Launching terminal for SSO login: ${loginCmd}`);

    try {
        // Open a new PowerShell window and keep it open (-NoExit)
        // Using cmd.exe start to ensure a new window is created
        const psArgs = ['/c', 'start', '', 'powershell', '-NoExit', '-Command', loginCmd];
        const child = spawn('cmd.exe', psArgs, { detached: true, stdio: 'ignore' });
        child.unref();
        return res.json({ success: true, message: 'Opened a new PowerShell window for SSO login.' });
    } catch (e) {
        console.error('Failed to launch terminal for SSO login:', e);
        return res.status(500).json({ success: false, message: e.message || 'Failed to launch terminal' });
    }
});

// Simple SQL validator: allow only single-statement SELECT queries
function isSafeSelectQuery(query) {
    if (typeof query !== 'string') return false;
    // Remove block comments and line comments for accurate checks
    let text = query.replace(/\/\*[\s\S]*?\*\//g, '');
    text = text.replace(/--[^\n\r]*/g, '');
    text = text.trim();

    // Must start with SELECT and contain FROM (after trimming comments)
    if (!/^select\b/i.test(text)) return false;
    if (!/\bfrom\b/i.test(text)) return false;

    // Disallow dangerous keywords as whole words (but allow nested selects)
    const forbidden = /\b(update|delete|insert|drop|alter|create|truncate|grant|revoke)\b/i;
    if (forbidden.test(text)) return false;

    // Allow at most one semicolon, and only if it's the final character
    const semicolons = (text.match(/;/g) || []).length;
    if (semicolons > 1) return false;
    if (semicolons === 1 && !/;\s*$/.test(text)) return false;

    return true;
}

// Execute SQL (read-only) endpoint
app.post('/execute-sql', async (req, res) => {
    try {
        const { query, dbConfig } = req.body || {};
        if (!query || !dbConfig) {
            return res.status(400).json({ success: false, message: 'Missing query or dbConfig' });
        }
        if (!isSafeSelectQuery(query)) {
            return res.status(400).json({ success: false, message: 'Only single-statement SELECT queries are allowed.' });
        }

        let { host, port: dbPort, user, password, database } = dbConfig;
        // Normalize host to IPv4 loopback if user provided localhost/blank
        host = (host || '127.0.0.1').toString().trim();
        if (host.toLowerCase() === 'localhost' || host === '' || host === '::1') {
            host = '127.0.0.1';
        }
        if (!host || !dbPort || !user) {
            return res.status(400).json({ success: false, message: 'Incomplete DB configuration (host, port, user required)' });
        }

        // Quick TCP reachability check to give clearer error if tunnel is not active
        try {
            await new Promise((resolve, reject) => {
                const socket = net.connect({ host, port: Number(dbPort), timeout: 1500 }, () => {
                    socket.destroy();
                    resolve();
                });
                socket.on('error', (err) => {
                    socket.destroy();
                    reject(err);
                });
                socket.on('timeout', () => {
                    socket.destroy();
                    reject(new Error('Connection timed out'));
                });
            });
        } catch (tcpErr) {
            return res.status(502).json({
                success: false,
                message: `Cannot reach ${host}:${dbPort}. Ensure SSH tunnel is connected for the selected environment and the local port is open. (${tcpErr.message})`
            });
        }

        const connection = await mysql.createConnection({
            host,
            port: Number(dbPort),
            user,
            password: password || undefined,
            database: database || undefined,
            multipleStatements: false,
            rowsAsArray: false
        });

        try {
            const [rows] = await connection.execute(query);
            await connection.end();
            return res.json({ success: true, data: rows });
        } catch (err) {
            try { await connection.end(); } catch (_) {}
            return res.status(500).json({ success: false, message: err.message || 'Query execution failed' });
        }
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message || 'Unexpected server error' });
    }
});

// Endpoint สำหรับการเชื่อมต่อจริง
app.post('/connect', (req, res) => {
    // Kill any existing tunnel before starting a new one
    if (tunnelProcess) {
        console.log('Terminating existing tunnel process before starting a new one.');
        tunnelProcess.kill();
        tunnelProcess = null;
        connectedEnv = null;
        tunnelLocalPort = null;
        broadcastStatus();
    }

    const { env } = req.body;
    if (!env || !envTunnel[env]) {
        return res.status(400).json({ success: false, message: 'Invalid or missing environment specified.' });
    }

    const user = "Manuchet@cardx.co.th";
    const proxy = "cardx.teleport.sh:443";
    
    const loginCommand = `tsh login --proxy=${proxy} --auth=local --user="${user}"`;
    const statusCommand = `tsh status`;
    const { defaultLocalPort, remoteHost } = envTunnel[env];

    console.log(`Executing: ${loginCommand}`);
    
    exec(loginCommand, (loginError, loginStdout, loginStderr) => {
        if (loginError) {
            console.error(`Login failed: ${loginStderr}`);
            return res.status(500).json({ 
                success: false, 
                message: `Login failed. Please check credentials and Teleport setup. \n\nError: ${loginStderr}` 
            });
        }
        
        console.log(`Login successful for ${user}. Now fetching status...`);
        exec(statusCommand, (statusError, statusStdout, statusStderr) => {
            if (statusError) {
                console.error(`Error executing tsh status: ${statusStderr}`);
                return res.status(500).json({ 
                    success: false, 
                    message: `Failed to get TSH status: ${statusStderr}` 
                });
            }

            console.log('Successfully fetched TSH status. Now creating SSH tunnel...');
            (async () => {
                // choose a free local port, prefer the default and then next 50 ports
                let chosenPort = defaultLocalPort;
                const range = Array.from({ length: 51 }, (_, i) => defaultLocalPort + i);
                for (const p of range) {
                    if (await isPortFree(p)) { chosenPort = p; break; }
                }

                const sshTunnelCommand = `tsh ssh -N -L ${chosenPort}:${remoteHost}:4000 devops@cdx-sit-nonprod-pci-acn-bastion-host`;
                console.log(`Executing: ${sshTunnelCommand}`);

                const [command, ...args] = sshTunnelCommand.split(' ');
                tunnelLocalPort = chosenPort;
                broadcastStatus();

                tunnelProcess = spawn(command, args, { detached: true }); // detached: true helps in managing the process group

                tunnelProcess.on('error', (err) => {
                    console.error('Failed to start SSH tunnel process:', err);
                    if (!res.headersSent) {
                        res.status(500).json({ success: false, message: 'Failed to spawn SSH tunnel process.' });
                    }
                    tunnelProcess = null;
                    connectedEnv = null;
                    tunnelLocalPort = null;
                    broadcastStatus();
                });
            
                tunnelProcess.stderr.on('data', (data) => {
                    const errorMessage = data.toString();
                    console.error(`SSH Tunnel stderr: ${errorMessage}`);
                    if (!res.headersSent) {
                        tunnelProcess.kill();
                        tunnelProcess = null;
                        connectedEnv = null;
                        tunnelLocalPort = null;
                        res.status(500).json({ success: false, message: `Failed to establish SSH tunnel: ${errorMessage}` });
                    }
                    broadcastStatus();
                });

                tunnelProcess.on('close', (code) => {
                    console.log(`SSH tunnel process exited with code ${code}`);
                    tunnelProcess = null;
                    connectedEnv = null;
                    tunnelLocalPort = null;
                    broadcastStatus();
                });

                // Wait a moment to catch any immediate errors from the ssh command
                setTimeout(() => {
                    if (!res.headersSent) {
                        console.log(`SSH tunnel for ${env.toUpperCase()} assumed to be active on ${chosenPort}.`);
                        connectedEnv = env;
                        broadcastStatus();
                        res.json({ 
                            success: true, 
                            data: statusStdout,
                            tunnelPort: chosenPort,
                            message: `SSH tunnel for ${env.toUpperCase()} environment initiated on port ${chosenPort}.`
                        });
                    }
                }, 2000); // 2 second delay to wait for potential connection errors
            })();
        });
    });
});

// Endpoint สำหรับการยกเลิกการเชื่อมต่อ
app.post('/disconnect', (req, res) => {
    if (tunnelProcess) {
        console.log('Killing existing SSH tunnel process...');
        tunnelProcess.kill('SIGTERM'); // Send termination signal
        tunnelProcess = null;
        connectedEnv = null;
        broadcastStatus();
    }

    const logoutCommand = 'tsh logout';
    console.log(`Executing: ${logoutCommand}`);

    exec(logoutCommand, (error, stdout, stderr) => {
        if (error) {
            console.error(`Logout failed: ${stderr}`);
        }
        console.log('Logout successful.');
        res.json({
            success: true,
            message: 'Tunnel terminated and successfully logged out.'
        });
        broadcastStatus();
    });
});


// (duplicate /execute-sql removed)

let server;

function isPortFree(portToTest) {
    return new Promise((resolve) => {
        const tester = net.createServer()
            .once('error', () => resolve(false))
            .once('listening', () => tester.once('close', () => resolve(true)).close())
            .listen(portToTest, '0.0.0.0');
    });
}

async function choosePort() {
    if (envPort && envPort !== 3000) {
        if (await isPortFree(envPort)) return envPort;
        console.error(`Configured PORT ${envPort} not available.`);
    }
    // Preferred ranges (avoid 3000): 3100-3110, then 3001-3009
    const candidates = [];
    for (let p = 3100; p <= 3110; p++) candidates.push(p);
    for (let p = 3001; p <= 3009; p++) candidates.push(p);
    for (const p of candidates) {
        if (await isPortFree(p)) return p;
    }
    // Last resort: ask OS for a random port
    return 0;
}

(async () => {
    const selectedPort = await choosePort();
    server = app.listen(selectedPort, () => {
        const boundPort = server.address().port;
        console.log(`Teleport command server listening at http://localhost:${boundPort}`);
        if (boundPort === 3000) {
            console.warn('Warning: bound to 3000 despite preference; consider setting PORT to avoid conflicts.');
        }
    });

    server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
            console.error(`Selected port is already in use. Stop the existing process or set PORT to a different value.`);
        } else {
            console.error('Server error:', err);
        }
        process.exit(1);
    });
})();

