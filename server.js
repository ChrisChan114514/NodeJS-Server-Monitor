const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebSocketServer, WebSocket } = require('ws');
const si = require('systeminformation');
const nodemailer = require('nodemailer');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = 5020;
const VNC_PORT = 5901;
const VNC_CHECK_INTERVAL_MS = 60 * 1000;
const DB_PATH = path.join(__dirname, 'database', 'metrics.db');
const LOG_DIR = path.join(__dirname, 'logs');
const VNC_CHECK_SCRIPT = path.join(__dirname, 'scripts', 'check_vnc_5901.sh');
const VNC_LOG_FILE = path.join(LOG_DIR, 'check_vnc_5901.log');
const EMAIL_CONFIG_PATH = path.join(__dirname, 'email.config.json');
let emailConfig = {};
try {
    emailConfig = JSON.parse(fs.readFileSync(EMAIL_CONFIG_PATH, 'utf8'));
} catch (err) {
    console.warn('Warning: email.config.json not found or invalid. Email alerts will be disabled.');
}

const EMAIL_USER = emailConfig.user || '';
const EMAIL_PASS = emailConfig.pass || '';
const EMAIL_RECEIVERS = emailConfig.receivers || [];
const EMAIL_SIGNATURE_ID = emailConfig.signatureId || '';
const EMAIL_SMTP_HOST = (emailConfig.smtp && emailConfig.smtp.host) ? emailConfig.smtp.host : 'smtp.126.com';
const EMAIL_SMTP_PORT = (emailConfig.smtp && emailConfig.smtp.port) ? emailConfig.smtp.port : 465;
const EMAIL_SMTP_SECURE = (emailConfig.smtp && emailConfig.smtp.secure !== undefined) ? emailConfig.smtp.secure : true;
const WEB_VNC_PASSWORD = process.env.WEB_VNC_PASSWORD || 'shitie';
const WEB_VNC_TOKEN_TTL_MS = 2 * 60 * 1000;

const TEMP_THRESHOLD = 85;
const CPU_THRESHOLD = 90;
const RAM_THRESHOLD = 95;
const GPU_THRESHOLD = 90;
const CONSECUTIVE_ALERTS_REQUIRED = 5;

if (!fs.existsSync(path.dirname(DB_PATH))) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
        timestamp INTEGER PRIMARY KEY,
        cpu_load REAL,
        mem_used INTEGER,
        mem_total INTEGER,
        gpu_load REAL,
        gpu_mem_used INTEGER,
        gpu_mem_total INTEGER,
        temp_main REAL,
        temp_gpu REAL,
        gpu_name TEXT,
        disk_read_sec REAL,
        disk_write_sec REAL,
        fs_size INTEGER,
        fs_used INTEGER,
        net_rx_sec REAL,
        net_tx_sec REAL
    )
`);

try {
    const columns = db.pragma('table_info(metrics)');
    if (!columns.some((c) => c.name === 'temp_gpu')) db.exec('ALTER TABLE metrics ADD COLUMN temp_gpu REAL');
    if (!columns.some((c) => c.name === 'gpu_name')) db.exec('ALTER TABLE metrics ADD COLUMN gpu_name TEXT');
    if (!columns.some((c) => c.name === 'net_rx_sec')) db.exec('ALTER TABLE metrics ADD COLUMN net_rx_sec REAL');
    if (!columns.some((c) => c.name === 'net_tx_sec')) db.exec('ALTER TABLE metrics ADD COLUMN net_tx_sec REAL');
} catch (error) {
    console.warn('DB migration warning:', error.message);
}

const insertStmt = db.prepare(`
    INSERT INTO metrics (
        timestamp, cpu_load, mem_used, mem_total,
        gpu_load, gpu_mem_used, gpu_mem_total,
        temp_main, temp_gpu, gpu_name,
        disk_read_sec, disk_write_sec,
        fs_size, fs_used,
        net_rx_sec, net_tx_sec
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const vncWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const vncWebTokens = new Map();

app.use(express.json());
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));
app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
});
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

const transporter = nodemailer.createTransport({
    host: EMAIL_SMTP_HOST,
    port: EMAIL_SMTP_PORT,
    secure: EMAIL_SMTP_SECURE,
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS,
    },
});

let alertState = { cpu: 0, ram: 0, gpu: 0, temp: 0 };
let lastEmailTime = 0;
const EMAIL_COOLDOWN = 60 * 60 * 1000;
let fanMode = 'normal';
let vncState = {
    port: VNC_PORT,
    isListening: false,
    isHealthy: false,
    lastCheckAt: null,
    lastSuccessAt: null,
    lastExitCode: null,
    lastReason: 'init',
    lastMessage: 'VNC 未检查',
};
const cpuBrandPromise = si.cpu().then((info) => info.brand || info.manufacturer || 'Unknown CPU').catch(() => 'Unknown CPU');

function runCommand(command, timeout = 1500) {
    return new Promise((resolve) => {
        exec(command, { timeout }, (error, stdout, stderr) => {
            resolve({ error, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
        });
    });
}

function normalizeText(text, fallback) {
    const value = (text || '').trim();
    return value || fallback;
}

function getVncStateSnapshot() {
    return {
        ...vncState,
        lastCheckAtISO: vncState.lastCheckAt ? new Date(vncState.lastCheckAt).toISOString() : null,
        lastSuccessAtISO: vncState.lastSuccessAt ? new Date(vncState.lastSuccessAt).toISOString() : null,
    };
}

function pruneExpiredVncTokens() {
    const now = Date.now();
    for (const [token, expiresAt] of vncWebTokens.entries()) {
        if (expiresAt <= now) {
            vncWebTokens.delete(token);
        }
    }
}

function issueVncWebToken() {
    pruneExpiredVncTokens();
    const token = crypto.randomBytes(24).toString('hex');
    vncWebTokens.set(token, Date.now() + WEB_VNC_TOKEN_TTL_MS);
    return token;
}

function consumeVncWebToken(token) {
    if (!token) return false;
    pruneExpiredVncTokens();
    const expiresAt = vncWebTokens.get(token);
    if (!expiresAt || expiresAt <= Date.now()) {
        vncWebTokens.delete(token);
        return false;
    }
    return true;
}

async function isVncListening() {
    const { error } = await runCommand(`ss -ltn 2>/dev/null | grep -Eq ':${VNC_PORT}([[:space:]]|$)'`, 1500);
    return !error;
}

function readLogTail(filePath, lineCount = 80) {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    return content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .slice(-lineCount);
}

async function runVncWatchdog(reason = 'periodic') {
    if (!fs.existsSync(VNC_CHECK_SCRIPT)) {
        vncState = {
            ...vncState,
            isListening: false,
            isHealthy: false,
            lastCheckAt: Date.now(),
            lastExitCode: 1,
            lastReason: reason,
            lastMessage: `脚本不存在: ${VNC_CHECK_SCRIPT}`,
        };
        io.emit('vnc-status', getVncStateSnapshot());
        return { success: false, state: getVncStateSnapshot() };
    }

    const result = await runCommand(`bash "${VNC_CHECK_SCRIPT}"`, 20000);
    const listening = await isVncListening();
    const now = Date.now();
    const isSuccess = !result.error && listening;

    vncState = {
        ...vncState,
        isListening: listening,
        isHealthy: isSuccess,
        lastCheckAt: now,
        lastSuccessAt: isSuccess ? now : vncState.lastSuccessAt,
        lastExitCode: result.error ? (Number.isInteger(result.error.code) ? result.error.code : 1) : 0,
        lastReason: reason,
        lastMessage: isSuccess
            ? normalizeText(result.stdout, 'VNC 5901 检查通过')
            : normalizeText(`${result.stderr}\n${result.stdout}`, 'VNC 5901 检查失败'),
    };

    io.emit('vnc-status', getVncStateSnapshot());
    return { success: isSuccess, state: getVncStateSnapshot() };
}

async function getGpuFromNvidiaSmi() {
    const cmd = 'nvidia-smi --query-gpu=name,temperature.gpu,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits';
    const { error, stdout } = await runCommand(cmd, 2000);
    if (error || !stdout) return null;

    const firstLine = stdout.split('\n')[0].trim();
    const parts = firstLine.split(',').map((item) => item.trim());
    if (parts.length < 5) return null;

    return {
        name: parts[0] || 'NVIDIA GPU',
        temp: Number.parseFloat(parts[1]) || 0,
        memUsed: Number.parseInt(parts[2], 10) || 0,
        memTotal: Number.parseInt(parts[3], 10) || 0,
        load: Number.parseFloat(parts[4]) || 0,
        source: 'nvidia-smi',
    };
}

async function getGpuFromSystemInformation() {
    try {
        const graphics = await si.graphics();
        if (!graphics.controllers || graphics.controllers.length === 0) return null;

        const controller = graphics.controllers.find((c) => (c.vendor || '').toLowerCase().includes('nvidia')) || graphics.controllers[0];
        return {
            name: controller.model || controller.vendor || 'GPU',
            temp: Number.parseFloat(controller.temperatureGpu) || 0,
            memUsed: Number.parseInt(controller.memoryUsed || 0, 10),
            memTotal: Number.parseInt(controller.memoryTotal || 0, 10),
            load: Number.parseFloat(controller.utilizationGpu) || 0,
            source: 'systeminformation',
        };
    } catch {
        return null;
    }
}

async function getGpuMetrics() {
    const fromSmi = await getGpuFromNvidiaSmi();
    if (fromSmi) return fromSmi;
    const fromSi = await getGpuFromSystemInformation();
    if (fromSi) return fromSi;
    return {
        name: 'GPU Not Available',
        temp: 0,
        memUsed: 0,
        memTotal: 0,
        load: 0,
        source: 'none',
    };
}

function getNetworkSummary(netStats) {
    if (!Array.isArray(netStats) || netStats.length === 0) {
        return { rx: 0, tx: 0 };
    }
    const valid = netStats.filter((entry) => (entry.iface || '').toLowerCase() !== 'lo');
    const target = valid.length > 0 ? valid : netStats;
    const rx = target.reduce((sum, entry) => sum + (entry.rx_sec || 0), 0);
    const tx = target.reduce((sum, entry) => sum + (entry.tx_sec || 0), 0);
    return { rx, tx };
}

async function collectMetrics() {
    try {
        const [cpuLoad, mem, temp, fsSize, diskIO, netStats, gpu, cpuBrand] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.cpuTemperature(),
            si.fsSize(),
            si.disksIO(),
            si.networkStats(),
            getGpuMetrics(),
            cpuBrandPromise,
        ]);

        const rootFs = fsSize.find((item) => item.mount === '/') || fsSize[0] || { size: 0, used: 0 };
        const network = getNetworkSummary(netStats);

        return {
            timestamp: Date.now(),
            cpu_name: cpuBrand,
            cpu_load: Number.parseFloat(cpuLoad.currentLoad || 0),
            cpu_cores: Array.isArray(cpuLoad.cpus) ? cpuLoad.cpus.map((core) => Number.parseFloat(core.load || 0)) : [],
            mem_used: Number.parseInt(mem.active || 0, 10),
            mem_total: Number.parseInt(mem.total || 0, 10),
            gpu_load: Number.parseFloat(gpu.load || 0),
            gpu_mem_used: Number.parseInt(gpu.memUsed || 0, 10),
            gpu_mem_total: Number.parseInt(gpu.memTotal || 0, 10),
            temp_main: Number.parseFloat(temp.main || 0),
            temp_gpu: Number.parseFloat(gpu.temp || 0),
            gpu_name: gpu.name || 'Unknown GPU',
            gpu_source: gpu.source || 'none',
            disk_read_sec: Number.parseFloat(diskIO.rIO_sec || 0),
            disk_write_sec: Number.parseFloat(diskIO.wIO_sec || 0),
            fs_size: Number.parseInt(rootFs.size || 0, 10),
            fs_used: Number.parseInt(rootFs.used || 0, 10),
            net_rx_sec: Number.parseFloat(network.rx || 0),
            net_tx_sec: Number.parseFloat(network.tx || 0),
        };
    } catch (error) {
        console.error('collectMetrics error:', error.message);
        return null;
    }
}

async function sendAlertEmail(subject, message) {
    const now = Date.now();
    const isManual = subject.includes('Manual Report');
    if (!isManual && now - lastEmailTime < EMAIL_COOLDOWN) return;

    const payload = {
        from: `"System Monitor" <${EMAIL_USER}>`,
        to: EMAIL_RECEIVERS.join(', '),
        subject: isManual ? subject : `[ALERT] ${subject}`,
        text: `${message}\n\nID: ${EMAIL_SIGNATURE_ID}\nTime: ${new Date().toLocaleString()}`,
    };

    await transporter.sendMail(payload);
    if (!isManual) lastEmailTime = now;
}

app.post('/api/report', async (_req, res) => {
    try {
        const metrics = await collectMetrics();
        if (!metrics) return res.status(500).json({ success: false, error: '采集系统信息失败' });

        const memPercent = metrics.mem_total > 0 ? (metrics.mem_used / metrics.mem_total) * 100 : 0;
        const diskPercent = metrics.fs_size > 0 ? (metrics.fs_used / metrics.fs_size) * 100 : 0;
        const report = `
System Status Report
--------------------
Time: ${new Date().toLocaleString()}

- CPU: ${metrics.cpu_load.toFixed(1)}%
- CPU Model: ${metrics.cpu_name}
- CPU: ${metrics.cpu_load.toFixed(1)}%
- CPU Temp: ${metrics.temp_main.toFixed(1)}°C
- RAM: ${memPercent.toFixed(1)}%
- GPU: ${metrics.gpu_load.toFixed(1)}%
- GPU Temp: ${metrics.temp_gpu.toFixed(1)}°C
- GPU Mem: ${metrics.gpu_mem_used}MB / ${metrics.gpu_mem_total}MB
- GPU Name: ${metrics.gpu_name}
- Disk: ${diskPercent.toFixed(1)}%
- Net In: ${(metrics.net_rx_sec / 1024).toFixed(2)} KB/s
- Net Out: ${(metrics.net_tx_sec / 1024).toFixed(2)} KB/s
        `;

        await sendAlertEmail('Manual Report: System Status', report);
        res.json({ success: true, message: '邮件发送成功' });
    } catch (error) {
        console.error('/api/report error:', error.message);
        res.status(500).json({ success: false, error: error.message || '邮件发送失败' });
    }
});

app.post('/api/fan', async (req, res) => {
    const mode = req.body?.mode === 'strong' ? 'strong' : 'normal';

    const commands = mode === 'strong'
        ? [
            'DISPLAY=:0 XAUTHORITY=/home/cc/.Xauthority nvidia-settings -a "[gpu:0]/GPUFanControlState=1" -a "[fan:0]/GPUTargetFanSpeed=100"',
            'DISPLAY=:0 XAUTHORITY=/home/cc/.Xauthority nvidia-settings -a "[gpu:0]/GPUFanControlState=1" -a "[gpu:0]/GPUTargetFanSpeed=100"',
            'sudo -n DISPLAY=:0 XAUTHORITY=/home/cc/.Xauthority nvidia-settings -a "[gpu:0]/GPUFanControlState=1" -a "[fan:0]/GPUTargetFanSpeed=100"',
            'sudo -n DISPLAY=:0 XAUTHORITY=/home/cc/.Xauthority nvidia-settings -a "[gpu:0]/GPUFanControlState=1" -a "[gpu:0]/GPUTargetFanSpeed=100"',
        ]
        : [
            'DISPLAY=:0 XAUTHORITY=/home/cc/.Xauthority nvidia-settings -a "[gpu:0]/GPUFanControlState=0"',
            'sudo -n DISPLAY=:0 XAUTHORITY=/home/cc/.Xauthority nvidia-settings -a "[gpu:0]/GPUFanControlState=0"',
        ];

    const attempts = [];
    for (const command of commands) {
        const result = await runCommand(command, 3000);
        attempts.push({ command, stderr: result.stderr, stdout: result.stdout, ok: !result.error });
        if (!result.error) {
            fanMode = mode;
            return res.json({ success: true, mode: fanMode, message: '风扇模式切换成功', attempts });
        }
    }

    fanMode = mode;
    res.status(200).json({
        success: false,
        mode: fanMode,
        message: '已发送风扇控制命令，但系统拒绝执行（常见于笔记本 BIOS 锁定）',
        attempts,
    });
});

app.get('/api/fan', (_req, res) => {
    res.json({ mode: fanMode });
});

app.get('/api/history', (req, res) => {
    const range = req.query.range || '1d';
    let hours = 24;
    if (range === '7d') hours = 24 * 7;
    if (range === '30d') hours = 24 * 30;

    const startTime = Date.now() - hours * 60 * 60 * 1000;
    try {
        const rows = db.prepare('SELECT * FROM metrics WHERE timestamp > ? ORDER BY timestamp ASC').all(startTime);
        let result = rows;
        if (range === '7d') result = rows.filter((_, index) => index % 10 === 0);
        if (range === '30d') result = rows.filter((_, index) => index % 60 === 0);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Database error' });
    }
});

app.get('/api/vnc/status', async (_req, res) => {
    const listening = await isVncListening();
    if (listening !== vncState.isListening) {
        vncState = {
            ...vncState,
            isListening: listening,
            isHealthy: listening && vncState.isHealthy,
            lastMessage: listening ? '端口正在监听' : vncState.lastMessage,
        };
    }

    res.json({
        success: true,
        ...getVncStateSnapshot(),
        recentLogs: readLogTail(VNC_LOG_FILE, 30),
    });
});

app.post('/api/vnc/start', async (_req, res) => {
    try {
        const result = await runVncWatchdog('manual-start');
        res.status(result.success ? 200 : 500).json({
            success: result.success,
            ...result.state,
            recentLogs: readLogTail(VNC_LOG_FILE, 40),
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message || 'VNC 启动失败' });
    }
});

app.post('/api/vnc/check', async (_req, res) => {
    try {
        const result = await runVncWatchdog('manual-check');
        res.status(result.success ? 200 : 500).json({
            success: result.success,
            ...result.state,
            recentLogs: readLogTail(VNC_LOG_FILE, 40),
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message || 'VNC 检查失败' });
    }
});

app.post('/api/vnc/web-login', async (req, res) => {
    const password = String(req.body?.password || '');
    if (!password || password !== WEB_VNC_PASSWORD) {
        return res.status(401).json({ success: false, error: '密码错误' });
    }

    const listening = await isVncListening();
    if (!listening) {
        return res.status(503).json({ success: false, error: 'VNC 当前未监听，请先执行一键启动' });
    }

    const token = issueVncWebToken();
    res.json({
        success: true,
        token,
        expiresInSec: Math.floor(WEB_VNC_TOKEN_TTL_MS / 1000),
        remotePath: `/remote.html?token=${token}`,
    });
});

app.get('/api/vnc/logs', (req, res) => {
    const lines = Number.parseInt(req.query.lines, 10);
    const lineCount = Number.isFinite(lines) ? Math.max(10, Math.min(lines, 300)) : 100;
    res.json({
        success: true,
        logs: readLogTail(VNC_LOG_FILE, lineCount),
    });
});

app.use(express.static(path.join(__dirname, 'public')));

server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    let token = '';
    try {
        const target = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        pathname = target.pathname;
        token = target.searchParams.get('token') || '';
    } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }

    if (pathname !== '/vnc-ws') {
        return;
    }

    if (!consumeVncWebToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    vncWss.handleUpgrade(req, socket, head, (ws) => {
        vncWss.emit('connection', ws);
    });
});

vncWss.on('connection', (ws) => {
    const vncSocket = net.createConnection({ host: '127.0.0.1', port: VNC_PORT });

    const safeClose = () => {
        try { vncSocket.destroy(); } catch {}
        try { ws.close(); } catch {}
    };

    ws.on('message', (data, isBinary) => {
        if (vncSocket.destroyed) return;
        if (isBinary || Buffer.isBuffer(data)) {
            vncSocket.write(data);
            return;
        }
        vncSocket.write(Buffer.from(String(data), 'utf8'));
    });

    ws.on('close', () => {
        if (!vncSocket.destroyed) vncSocket.end();
    });

    ws.on('error', (error) => {
        console.warn('vnc websocket error:', error.message);
        safeClose();
    });

    vncSocket.on('data', (chunk) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(chunk, { binary: true });
        }
    });

    vncSocket.on('error', (error) => {
        console.warn('vnc tcp error:', error.message);
        safeClose();
    });

    vncSocket.on('close', () => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    });
});

setInterval(async () => {
    const metrics = await collectMetrics();
    if (!metrics) return;

    io.emit('metrics', {
        ...metrics,
        vnc: getVncStateSnapshot(),
    });

    insertStmt.run(
        metrics.timestamp,
        metrics.cpu_load,
        metrics.mem_used,
        metrics.mem_total,
        metrics.gpu_load,
        metrics.gpu_mem_used,
        metrics.gpu_mem_total,
        metrics.temp_main,
        metrics.temp_gpu,
        metrics.gpu_name,
        metrics.disk_read_sec,
        metrics.disk_write_sec,
        metrics.fs_size,
        metrics.fs_used,
        metrics.net_rx_sec,
        metrics.net_tx_sec
    );

    if (metrics.cpu_load > CPU_THRESHOLD) alertState.cpu += 1; else alertState.cpu = 0;
    const ramPercent = metrics.mem_total > 0 ? (metrics.mem_used / metrics.mem_total) * 100 : 0;
    if (ramPercent > RAM_THRESHOLD) alertState.ram += 1; else alertState.ram = 0;
    if (metrics.gpu_load > GPU_THRESHOLD) alertState.gpu += 1; else alertState.gpu = 0;
    if (metrics.temp_main > TEMP_THRESHOLD || metrics.temp_gpu > TEMP_THRESHOLD) alertState.temp += 1; else alertState.temp = 0;

    const alerts = [];
    if (alertState.cpu >= CONSECUTIVE_ALERTS_REQUIRED) alerts.push(`CPU 长时间高负载: ${metrics.cpu_load.toFixed(1)}%`);
    if (alertState.ram >= CONSECUTIVE_ALERTS_REQUIRED) alerts.push(`RAM 长时间高占用: ${ramPercent.toFixed(1)}%`);
    if (alertState.gpu >= CONSECUTIVE_ALERTS_REQUIRED) alerts.push(`GPU 长时间高负载: ${metrics.gpu_load.toFixed(1)}%`);
    if (alertState.temp >= 2) alerts.push(`温度过高 CPU ${metrics.temp_main.toFixed(1)}°C / GPU ${metrics.temp_gpu.toFixed(1)}°C`);

    if (alerts.length > 0) {
        try {
            await sendAlertEmail('System Anomaly Detected', alerts.join('\n'));
        } catch (error) {
            console.error('auto alert email error:', error.message);
        }
    }
}, 2000);

setInterval(() => {
    runVncWatchdog('periodic').catch((error) => {
        console.error('VNC watchdog periodic error:', error.message);
    });
}, VNC_CHECK_INTERVAL_MS);

setInterval(() => {
    pruneExpiredVncTokens();
}, 30 * 1000);

runVncWatchdog('startup').catch((error) => {
    console.error('VNC watchdog startup error:', error.message);
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
