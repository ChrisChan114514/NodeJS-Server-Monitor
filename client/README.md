# System Monitor Agent

系统监控客户端（Agent），部署在各被监控设备上，负责采集本机系统指标并通过 MQTT 上报到 Server。

## 功能

- **系统信息采集**：CPU、内存、GPU（NVIDIA）、温度、磁盘、网络 I/O
- **MQTT 上报**：每 2 秒推送指标，每 5 秒发送心跳
- **自动重连**：内置断线重连机制
- **本机识别**：根据 Broker 地址自动判断是否为 Server 本机（localhost/127.0.0.1）

## 目录结构

```
client/
├── agent.js               # 主程序
├── lib/
│   └── metrics.js         # 共享采集逻辑
├── package.json           # 依赖
├── agent.config.json      # Agent 配置
└── agent.config.json.example
```

## 安装

```bash
cd client
npm install
```

## 配置

复制模板并编辑：

```bash
cp agent.config.json.example agent.config.json
nano agent.config.json
```

### agent.config.json

```json
{
    "deviceId": "raspberry-pi-4b-office",
    "deviceName": "树莓派-办公室",
    "brokerUrl": "mqtt://your-public-domain:1883",
    "token": "change-me-to-a-random-secret-string"
}
```

- `deviceId`：设备唯一标识（英文，无空格）
- `deviceName`：设备显示名称（前端展示用）
- `brokerUrl`：Server 的 MQTT Broker 地址
  - **本机 Agent**（与 Server 同设备）：`mqtt://localhost:1883`
  - **远端 Agent**：`mqtt://server公网IP或域名:1883`
- `token`：与 `server/server.config.json` 中的 `agentToken` 保持一致

## 启动

### 方式一：直接运行

```bash
node agent.js
```

### 方式二：PM2 守护进程（推荐）

```bash
bash start.sh
```

或手动：

```bash
pm2 start agent.js --name system-monitor-agent
pm2 save
```

## 部署到远端设备

1. 将 `client/` 目录复制到目标设备：

```bash
scp -r client/ user@remote-host:/path/to/monitor/
```

2. 在目标设备安装依赖并配置：

```bash
cd /path/to/monitor/client
npm install
nano agent.config.json
```

3. 启动 Agent：

```bash
bash start.sh
```

## 注意事项

- Agent 仅依赖 `systeminformation` 和 `mqtt`，非常轻量
- `agent.config.json` 已加入 `.gitignore`，请勿提交到版本控制
- 如需停止 Agent：`pm2 stop system-monitor-agent`
