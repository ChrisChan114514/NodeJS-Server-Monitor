const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { collectMetrics } = require('./lib/metrics');

const CONFIG_PATH = path.join(__dirname, 'agent.config.json');

let config = {};
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
    console.error('Failed to load agent.config.json:', err.message);
    console.error('Please copy agent.config.json.example to agent.config.json and fill in your settings.');
    process.exit(1);
}

// Enforce unique deviceId across all agents.
// Multiple agents with the same deviceId (e.g. "local") would collide on the
// MQTT broker (same clientId) and overwrite each other in the server's device
// registry, causing the frontend to flicker between different hosts.
const GENERIC_DEVICE_IDS = new Set(['local', 'localhost', 'default', 'agent', 'test', '']);
function isGenericDeviceId(id) {
    return GENERIC_DEVICE_IDS.has((id || '').trim().toLowerCase());
}
let deviceId = config.deviceId || os.hostname();
if (isGenericDeviceId(deviceId)) {
    const hostname = os.hostname();
    if (hostname && hostname !== deviceId) {
        console.warn(`[Agent] WARNING: deviceId in config ("${deviceId}") is not unique. Auto-overriding with hostname: "${hostname}".`);
        console.warn('[Agent] Please update agent.config.json and set "deviceId" to a unique value (e.g. the hostname).');
        deviceId = hostname;
    } else if (!hostname) {
        console.error('[Agent] ERROR: Could not determine a unique deviceId. Please set "deviceId" in agent.config.json to a unique value.');
        process.exit(1);
    }
}
const deviceName = config.deviceName || deviceId;
const brokerUrl = config.brokerUrl || 'mqtt://localhost:1883';
const token = config.token || '';
const isLocal = /localhost|127\.0\.0\.1|::1/.test(brokerUrl);

const statusTopic = `agents/${deviceId}/status`;
const metricsTopic = `agents/${deviceId}/metrics`;

function getStatusPayload(online) {
    return JSON.stringify({
        online,
        hostname: os.hostname(),
        deviceName,
        isLocal,
        timestamp: Date.now(),
    });
}

const client = mqtt.connect(brokerUrl, {
    clientId: deviceId,
    username: 'agent',
    password: token,
    reconnectPeriod: 5000,
    connectTimeout: 30 * 1000,
    will: {
        topic: statusTopic,
        payload: getStatusPayload(false),
        qos: 1,
        retain: true,
    },
});

client.on('connect', () => {
    console.log(`[Agent] Connected to MQTT Broker: ${brokerUrl}`);
    client.publish(statusTopic, getStatusPayload(true), { qos: 1, retain: true });
});

client.on('reconnect', () => {
    console.log('[Agent] Reconnecting to MQTT Broker...');
});

client.on('offline', () => {
    console.log('[Agent] MQTT Client offline');
});

client.on('error', (err) => {
    console.error('[Agent] MQTT Error:', err.message);
});

// Heartbeat every 5s
setInterval(() => {
    if (!client.connected) return;
    client.publish(statusTopic, getStatusPayload(true), { qos: 0, retain: true });
}, 5000);

// Metrics every 2s
setInterval(async () => {
    if (!client.connected) return;
    try {
        const metrics = await collectMetrics();
        if (metrics) {
            client.publish(metricsTopic, JSON.stringify(metrics), { qos: 0 });
        }
    } catch (err) {
        console.error('[Agent] Failed to collect/publish metrics:', err.message);
    }
}, 2000);

console.log(`[Agent] Starting with deviceId=${deviceId}, deviceName=${deviceName}, isLocal=${isLocal}, broker=${brokerUrl}`);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[Agent] Shutting down...');
    client.publish(statusTopic, getStatusPayload(false), { qos: 1, retain: true }, () => {
        client.end(true, () => {
            process.exit(0);
        });
    });
});
