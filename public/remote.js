import RFB from '/novnc/core/rfb.js';

const screen = document.getElementById('vnc-screen');
const statusText = document.getElementById('status-text');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const reconnectBtn = document.getElementById('reconnect-btn');
const immersiveExitBtn = document.getElementById('immersive-exit-btn');
const overlay = document.getElementById('overlay');

const params = new URLSearchParams(window.location.search);
const token = params.get('token') || '';
const sessionKey = `vnc_pwd_${token}`;
const vncPassword = sessionStorage.getItem(sessionKey) || '';

let rfb = null;
let immersiveEnabled = false;

function updateFullscreenButton() {
    fullscreenBtn.textContent = immersiveEnabled ? '退出沉浸' : '沉浸全屏';
}

function setImmersive(enabled) {
    immersiveEnabled = enabled;
    document.body.classList.toggle('immersive', enabled);
    immersiveExitBtn.classList.toggle('hidden', !enabled);
    updateFullscreenButton();
}

async function enterImmersive() {
    setImmersive(true);

    // Try true browser fullscreen too, but immersive layout still works if blocked.
    if (document.fullscreenElement) return;
    try {
        await document.documentElement.requestFullscreen();
    } catch {
        // Browser may block fullscreen without recent user gesture.
    }
}

async function exitImmersive() {
    setImmersive(false);

    if (!document.fullscreenElement) return;
    try {
        await document.exitFullscreen();
    } catch {
        // Ignore browser-specific fullscreen exit failures.
    }
}

function toggleFullscreen() {
    if (immersiveEnabled) {
        exitImmersive();
        return;
    }
    enterImmersive();
}

function setStatus(text, isOk = null) {
    statusText.textContent = text;
    statusText.classList.remove('status-good', 'status-bad');
    if (isOk === true) statusText.classList.add('status-good');
    if (isOk === false) statusText.classList.add('status-bad');
}

function showOverlay(text) {
    overlay.textContent = text;
    overlay.classList.remove('hidden');
}

function hideOverlay() {
    overlay.classList.add('hidden');
}

function getWsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/vnc-ws?token=${encodeURIComponent(token)}`;
}

function connectRemote() {
    if (!token || !vncPassword) {
        showOverlay('连接凭据缺失，请返回监控页重新点击“远程桌面连接”。');
        setStatus('无法连接: 缺少 token 或密码', false);
        return;
    }

    if (rfb) {
        try {
            rfb.disconnect();
        } catch {}
        rfb = null;
    }

    hideOverlay();
    setStatus('正在连接远程桌面...');

    const wsUrl = getWsUrl();
    rfb = new RFB(screen, wsUrl, {
        credentials: { password: vncPassword },
        shared: true,
    });

    rfb.scaleViewport = true;
    rfb.resizeSession = true;
    rfb.background = '#0a0f16';

    rfb.addEventListener('connect', () => {
        setStatus('远程桌面已连接（Esc 可退出沉浸）', true);
        enterImmersive();
    });

    rfb.addEventListener('disconnect', (event) => {
        if (event?.detail?.clean) {
            setStatus('连接已断开', false);
            showOverlay('连接已关闭，可点击“重连”再次连接。');
            return;
        }
        setStatus('连接异常中断', false);
        showOverlay('连接异常中断，可点击“重连”重试。');
    });

    rfb.addEventListener('credentialsrequired', () => {
        setStatus('VNC 认证失败，请返回重新输入密码', false);
        showOverlay('VNC 认证失败，请返回监控页重新输入密码。');
    });

    rfb.addEventListener('securityfailure', (event) => {
        const reason = event?.detail?.reason || 'unknown reason';
        setStatus(`安全握手失败: ${reason}`, false);
        showOverlay(`安全握手失败: ${reason}`);
    });
}

reconnectBtn.addEventListener('click', () => {
    connectRemote();
});

fullscreenBtn.addEventListener('click', () => {
    toggleFullscreen();
});

immersiveExitBtn.addEventListener('click', () => {
    exitImmersive();
});

document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && immersiveEnabled) {
        // Esc or browser UI exited fullscreen: also leave immersive layout.
        setImmersive(false);
    }
    updateFullscreenButton();
});

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && immersiveEnabled) {
        event.preventDefault();
        event.stopPropagation();
        exitImmersive();
    }
}, true);

updateFullscreenButton();

connectRemote();
