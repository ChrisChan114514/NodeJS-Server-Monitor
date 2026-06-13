# System Monitor Server

系统监控服务端，负责接收各 Agent 上报的监控数据，提供 Web 控制台统一展示，并管理 MQTT Broker。

## 功能

- **内置 MQTT Broker**（Aedes）：接收各客户端 Agent 的实时指标上报
- **Web 控制台**：基于 Express + Socket.io 的实时仪表盘，支持多设备切换查看
- **数据持久化**：SQLite 存储历史数据，支持 1d / 7d / 30d 趋势查询
- **本地控制**（仅本机）：
  - VNC 5901 状态监控与远程桌面代理
  - NVIDIA 显卡风扇模式切换
  - 邮件告警与即时报告
- **Agent 认证**：基于 Token 的 MQTT 连接鉴权

## 目录结构

```
server/
├── server.js              # 主程序
├── package.json           # 依赖
├── server.config.json     # 服务端配置（端口、Token）
├── email.config.json      # 邮件 SMTP 配置
├── public/                # Web 前端（HTML/CSS/JS）
├── database/              # SQLite 数据库
├── scripts/               # VNC 检查脚本
└── logs/                  # 运行日志
```

## 安装

```bash
cd server
npm install
```

## 配置

### server.config.json

```json
{
    "port": 5020,
    "mqttPort": 1883,
    "agentToken": "change-me-to-a-random-secret-string"
}
```

- `port`：Web 服务端口（默认 5020）
- `mqttPort`：MQTT Broker 端口（默认 1883）
- `agentToken`：Agent 连接鉴权密钥，所有 Agent 的 `token` 必须与此一致

### email.config.json（可选）

用于邮件告警和即时报告功能。如不需要，可忽略。

```json
{
    "user": "your-email@example.com",
    "pass": "your-auth-code",
    "receivers": ["receiver@example.com"],
    "signatureId": "123456",
    "smtp": {
        "host": "smtp.example.com",
        "port": 465,
        "secure": true
    }
}
```

## 启动

### 方式一：直接运行

```bash
node server.js
```

### 方式二：PM2 守护进程（推荐）

```bash
bash start.sh
```

或手动：

```bash
pm2 start server.js --name system-monitor-server
pm2 save
```

## 内网穿透

如需让远端 Agent 接入，需将本机的 **5020**（Web）和 **1883**（MQTT）端口穿透到公网。

推荐使用 frp：

```ini
# frpc.ini
[system-monitor-web]
type = tcp
local_port = 5020
remote_port = 5020

[system-monitor-mqtt]
type = tcp
local_port = 1883
remote_port = 1883
```

## 注意事项

- 数据库文件 `database/metrics.db` 启动时会自动迁移（兼容旧版单设备结构）
- `server.config.json` 和 `email.config.json` 已加入 `.gitignore`，请勿提交到版本控制
- Aedes 版本锁定为 `0.51.3`，请勿升级
