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

const deviceId = config.deviceId || os.hostname();
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
