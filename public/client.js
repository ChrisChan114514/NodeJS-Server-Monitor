const socket = io();

// DOM Elements
const cpuValue = document.getElementById('cpu-value');
const cpuNameLine = document.getElementById('cpu-name-line');
const ramValue = document.getElementById('ram-value');
const gpuValue = document.getElementById('gpu-value');
const diskUsageValue = document.getElementById('disk-usage-value');
const diskProgress = document.getElementById('disk-progress');
const tempValue = document.getElementById('temp-value');
const ramDetail = document.getElementById('ram-detail');
const gpuMemValue = document.getElementById('gpu-mem-value');
const gpuTempValue = document.getElementById('gpu-temp-value');
const gpuName = document.getElementById('gpu-name');
const diskDetail = document.getElementById('disk-detail');
const diskRead = document.getElementById('disk-read');
const diskWrite = document.getElementById('disk-write');
const diskIoTotal = document.getElementById('disk-io-total');
const netIn = document.getElementById('net-in');
const netOut = document.getElementById('net-out');
const netTotal = document.getElementById('net-total');
const tempState = document.getElementById('temp-state');
const tempCpuValue = document.getElementById('temp-cpu-value');
const tempGpuValue = document.getElementById('temp-gpu-value');
const statusBadge = document.getElementById('status');
const reportBtn = document.getElementById('send-report-btn');
const fanToggle = document.getElementById('fan-toggle');
const cpuCard = document.getElementById('cpu-card');
const cpuModal = document.getElementById('cpu-modal');
const cpuModalClose = document.getElementById('cpu-modal-close');
const cpuCoreList = document.getElementById('cpu-core-list');
const vncStateValue = document.getElementById('vnc-state');
const vncLastCheck = document.getElementById('vnc-last-check');
const vncPort = document.getElementById('vnc-port');
const vncCheckBtn = document.getElementById('vnc-check-btn');
const vncStartBtn = document.getElementById('vnc-start-btn');
const vncWebBtn = document.getElementById('vnc-web-btn');
const vncLogPreview = document.getElementById('vnc-log-preview');

let latestCpuCores = [];

function formatRate(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 KB/s';
    if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(2)} MB/s`;
    return `${(bytesPerSec / 1024).toFixed(2)} KB/s`;
}

function formatTime(ts) {
    if (!ts) return '--';
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString();
}

function updateVncUI(vnc) {
    if (!vnc) return;
    const isUp = Boolean(vnc.isHealthy ?? vnc.isListening);
    vncStateValue.textContent = isUp ? '运行中' : '已停止';
    vncStateValue.classList.remove('vnc-state-up', 'vnc-state-down');
    vncStateValue.classList.add(isUp ? 'vnc-state-up' : 'vnc-state-down');
    vncLastCheck.textContent = `最近检查: ${formatTime(vnc.lastCheckAt)}`;
    vncPort.textContent = String(vnc.port || 5901);
    vncWebBtn.disabled = !isUp;

    if (Array.isArray(vnc.recentLogs) && vnc.recentLogs.length > 0) {
        vncLogPreview.textContent = vnc.recentLogs.slice(-6).join('\n');
        return;
    }

    if (vnc.lastMessage) {
        vncLogPreview.textContent = vnc.lastMessage;
    }
}

async function openWebRemoteDesktop() {
    const password = window.prompt('请输入远程桌面密码');
    if (!password) return;

    const originalText = vncWebBtn.textContent;
    vncWebBtn.disabled = true;
    vncWebBtn.textContent = '连接中...';

    try {
        const res = await fetch('/api/vnc/web-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            alert(`连接失败: ${data.error || 'unknown error'}`);
            return;
        }

        // Keep password only in this tab/session for noVNC auth.
        sessionStorage.setItem(`vnc_pwd_${data.token}`, password);
        window.location.href = data.remotePath || `/remote.html?token=${encodeURIComponent(data.token)}`;
    } catch (error) {
        alert(`连接请求失败: ${error.message}`);
    } finally {
        vncWebBtn.disabled = false;
        vncWebBtn.textContent = originalText;
    }
}

async function fetchVncStatus() {
    try {
        const res = await fetch('/api/vnc/status');
        if (!res.ok) return;
        const data = await res.json();
        updateVncUI(data);
    } catch (error) {
        console.error('fetchVncStatus error:', error);
    }
}

async function runVncAction(endpoint, button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '执行中...';
    try {
        const res = await fetch(endpoint, { method: 'POST' });
        const data = await res.json();
        updateVncUI(data);
        if (!res.ok || !data.success) {
            alert(`操作失败: ${data.error || data.lastMessage || 'unknown error'}`);
            return;
        }
        alert(endpoint.includes('start') ? 'VNC 一键启动完成' : 'VNC 检查完成');
    } catch (error) {
        alert(`请求失败: ${error.message}`);
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

// Fan Control Logic
fanToggle.addEventListener('change', async (e) => {
    const isStrong = e.target.checked;
    try {
        const res = await fetch('/api/fan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: isStrong ? 'strong' : 'normal' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (data.success) {
            alert(`风扇模式已切换: ${data.mode === 'strong' ? '强力' : '系统调度'}`);
            return;
        }
        alert(data.message || '风扇控制被系统拒绝');
    } catch (err) {
        console.error('Fan control error:', err);
        alert('设置风扇模式失败: ' + err.message);
        e.target.checked = !isStrong; // Revert
    }
});

reportBtn.addEventListener('click', async () => {
    reportBtn.disabled = true;
    reportBtn.textContent = '发送中...';
    try {
        const res = await fetch('/api/report', { method: 'POST' });
        
        if (!res.ok) {
            throw new Error(`HTTP error! status: ${res.status}`);
        }
        
        const data = await res.json();
        if (data.success) {
            alert('报告已发送到您的邮箱');
        } else {
            alert('发送失败: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        console.error("Report fetch error:", e);
        alert('发送请求失败，请检查网络或服务器日志。\n' + e.message);
    } finally {
        reportBtn.disabled = false;
        reportBtn.textContent = '发送即时报告';
    }
});

// Charts Configuration
const chartConfig = {
    type: 'line',
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        elements: { point: { radius: 0 } },
        scales: {
            x: { display: false },
            y: { min: 0, max: 100, display: false }
        },
        plugins: { legend: { display: false } }
    }
};

function createMiniChart(ctx, color) {
    if (typeof Chart === 'undefined') {
        console.warn('Chart.js unavailable, mini chart disabled.');
        return {
            data: { datasets: [{ data: new Array(30).fill(0) }] },
            update: () => {},
        };
    }

    return new Chart(ctx, {
        ...chartConfig,
        data: {
            labels: new Array(30).fill(''),
            datasets: [{
                data: new Array(30).fill(0),
                borderColor: color,
                borderWidth: 2,
                fill: false,
                tension: 0.4
            }]
        }
    });
}

const cpuChart = createMiniChart(document.getElementById('cpuChart').getContext('2d'), '#4caf50');
const ramChart = createMiniChart(document.getElementById('ramChart').getContext('2d'), '#2196f3');
const gpuChart = createMiniChart(document.getElementById('gpuChart').getContext('2d'), '#ff9800');
const netChart = createMiniChart(document.getElementById('netChart').getContext('2d'), '#9c27b0');
const tempChart = createMiniChart(document.getElementById('tempChart').getContext('2d'), '#f44336');
const diskChart = createMiniChart(document.getElementById('diskChart').getContext('2d'), '#03a9f4');
const diskIoChart = createMiniChart(document.getElementById('diskIoChart').getContext('2d'), '#ffc107');

// Real-time Update Logic
function updateMiniChart(chart, value) {
    const data = chart.data.datasets[0].data;
    data.shift();
    data.push(value);
    chart.update();
}

socket.on('connect', () => {
    statusBadge.textContent = '已连接';
    statusBadge.className = 'status-badge connected';
});

socket.on('disconnect', () => {
    statusBadge.textContent = '断开连接';
    statusBadge.className = 'status-badge disconnected';
});

socket.on('metrics', (data) => {
    // Update Values
    cpuValue.textContent = `${data.cpu_load.toFixed(1)}%`;
    ramValue.textContent = `${((data.mem_used / data.mem_total) * 100).toFixed(1)}%`;
    gpuValue.textContent = `${data.gpu_load.toFixed(1)}%`;
    
    // Disk
    const diskPercent = (data.fs_used / data.fs_size) * 100;
    diskUsageValue.textContent = `${diskPercent.toFixed(1)}%`;
    diskProgress.style.width = `${diskPercent}%`;
    diskDetail.textContent = `${(data.fs_used / 1073741824).toFixed(1)} GB / ${(data.fs_size / 1073741824).toFixed(1)} GB`;
    
    // I/O
    const diskReadMb = (data.disk_read_sec / 1024 / 1024);
    const diskWriteMb = (data.disk_write_sec / 1024 / 1024);
    const diskIOMb = diskReadMb + diskWriteMb;
    diskRead.textContent = `${diskReadMb.toFixed(2)} MB/s`;
    diskWrite.textContent = `${diskWriteMb.toFixed(2)} MB/s`;
    diskIoTotal.textContent = `${diskIOMb.toFixed(2)} MB/s`;

    // Misc
    tempValue.textContent = Number.isFinite(data.temp_main) ? Number(data.temp_main).toFixed(1) : '--';
    gpuTempValue.textContent = Number.isFinite(data.temp_gpu) ? Number(data.temp_gpu).toFixed(1) : '--';
    tempCpuValue.textContent = Number.isFinite(data.temp_main) ? Number(data.temp_main).toFixed(1) : '--';
    tempGpuValue.textContent = Number.isFinite(data.temp_gpu) ? Number(data.temp_gpu).toFixed(1) : '--';
    gpuName.textContent = data.gpu_name || '';
    cpuNameLine.textContent = data.cpu_name || '--';
    latestCpuCores = Array.isArray(data.cpu_cores) ? data.cpu_cores : [];

    const maxTemp = Math.max(data.temp_main || 0, data.temp_gpu || 0);
    if (maxTemp >= 85) {
        tempState.textContent = '过热';
        tempState.style.color = '#f44336';
    } else if (maxTemp >= 70) {
        tempState.textContent = '偏高';
        tempState.style.color = '#ff9800';
    } else {
        tempState.textContent = '正常';
        tempState.style.color = '#4caf50';
    }

    ramDetail.textContent = `${(data.mem_used / 1073741824).toFixed(1)} GB / ${(data.mem_total / 1073741824).toFixed(1)} GB`;
    const gpuMemPercent = data.gpu_mem_total > 0 ? ((data.gpu_mem_used / data.gpu_mem_total) * 100) : 0;
    gpuMemValue.textContent = `${gpuMemPercent.toFixed(1)}%`;

    const rx = data.net_rx_sec || 0;
    const tx = data.net_tx_sec || 0;
    netIn.textContent = formatRate(rx);
    netOut.textContent = formatRate(tx);
    netTotal.textContent = formatRate(rx + tx);

    // Update Charts
    updateMiniChart(cpuChart, data.cpu_load);
    updateMiniChart(ramChart, (data.mem_used / data.mem_total) * 100);
    updateMiniChart(gpuChart, data.gpu_load);
    updateMiniChart(netChart, Math.min(100, ((rx + tx) / (10 * 1024 * 1024)) * 100));
    updateMiniChart(tempChart, Math.min(100, maxTemp));
    updateMiniChart(diskChart, diskPercent);
    updateMiniChart(diskIoChart, Math.min(100, (diskIOMb / 200) * 100));

    if (data.vnc) {
        updateVncUI(data.vnc);
    }
});

socket.on('vnc-status', (data) => {
    updateVncUI(data);
});

function renderCpuCores() {
    if (!latestCpuCores.length) {
        cpuCoreList.innerHTML = '<div class="core-item"><span>暂无核心数据</span><span>--</span></div>';
        return;
    }
    cpuCoreList.innerHTML = latestCpuCores
        .map((load, index) => `<div class="core-item"><span>Core ${index}</span><span>${Number(load).toFixed(1)}%</span></div>`)
        .join('');
}

cpuCard.addEventListener('click', () => {
    renderCpuCores();
    cpuModal.classList.remove('hidden');
});

cpuModalClose.addEventListener('click', () => {
    cpuModal.classList.add('hidden');
});

cpuModal.addEventListener('click', (event) => {
    if (event.target === cpuModal) {
        cpuModal.classList.add('hidden');
    }
});

// History Chart
let historyChartInstance = null;
const historyCtx = document.getElementById('historyChart').getContext('2d');

async function loadHistory(range) {
    if (typeof Chart === 'undefined') {
        console.warn('Chart.js unavailable, history chart disabled.');
        return;
    }

    const res = await fetch(`/api/history?range=${range}`);
    const data = await res.json();

    if (!data || data.length === 0) return;

    const labels = data.map(d => new Date(d.timestamp).toLocaleString());
    const cpuData = data.map(d => d.cpu_load);
    const ramData = data.map(d => (d.mem_used / d.mem_total) * 100);
    const gpuData = data.map(d => d.gpu_load);
    const cpuTempData = data.map(d => d.temp_main);
    const gpuTempData = data.map(d => d.temp_gpu || 0);
    const netInData = data.map(d => (d.net_rx_sec || 0) / 1024 / 1024);
    const netOutData = data.map(d => (d.net_tx_sec || 0) / 1024 / 1024);

    if (historyChartInstance) {
        historyChartInstance.destroy();
    }

    historyChartInstance = new Chart(historyCtx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                { label: 'CPU %', data: cpuData, borderColor: '#4caf50', borderWidth: 1, pointRadius: 0 },
                { label: 'RAM %', data: ramData, borderColor: '#2196f3', borderWidth: 1, pointRadius: 0 },
                { label: 'GPU %', data: gpuData, borderColor: '#ff9800', borderWidth: 1, pointRadius: 0 },
                { label: 'CPU Temp °C', data: cpuTempData, borderColor: '#f44336', borderWidth: 1, pointRadius: 0, hidden: false, borderDash: [5, 5] },
                { label: 'GPU Temp °C', data: gpuTempData, borderColor: '#e91e63', borderWidth: 1, pointRadius: 0, hidden: false },
                { label: 'Net In MB/s', data: netInData, borderColor: '#9c27b0', borderWidth: 1, pointRadius: 0, hidden: true },
                { label: 'Net Out MB/s', data: netOutData, borderColor: '#00bcd4', borderWidth: 1, pointRadius: 0, hidden: true }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { display: true, ticks: { maxTicksLimit: 10 } },
                y: { beginAtZero: true }
            }
        }
    });
}

// History Controls
document.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        loadHistory(e.target.dataset.range);
    });
});

// Initial Load
loadHistory('1d');

// Sync fan toggle state
fetch('/api/fan')
    .then(res => res.json())
    .then(data => {
        fanToggle.checked = data.mode === 'strong';
    })
    .catch(() => {
        fanToggle.checked = false;
    });

vncCheckBtn.addEventListener('click', () => runVncAction('/api/vnc/check', vncCheckBtn));
vncStartBtn.addEventListener('click', () => runVncAction('/api/vnc/start', vncStartBtn));
vncWebBtn.addEventListener('click', openWebRemoteDesktop);

fetchVncStatus();
setInterval(fetchVncStatus, 15000);
