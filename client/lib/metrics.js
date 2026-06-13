const si = require('systeminformation');
const { exec } = require('child_process');

function runCommand(command, timeout = 1500) {
    return new Promise((resolve) => {
        exec(command, { timeout }, (error, stdout, stderr) => {
            resolve({ error, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
        });
    });
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

const cpuBrandPromise = si.cpu().then((info) => info.brand || info.manufacturer || 'Unknown CPU').catch(() => 'Unknown CPU');

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

module.exports = { collectMetrics, runCommand };
