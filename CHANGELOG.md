# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 规范。

---

## [0.3.0] — 2026-05-24

### 新增
- **动态健康度调度算法** — 每轮评估所有帐号的健康度得分（订阅权重 × 剩余用量 × 剩余窗口时长），取代 v0.2 的固定时间表
- **错峰预 ping** — 主帐号用量达 50% 时自动 ping 下一个休眠备用帐号，确保备用窗口提前开启
- **Max 订阅权重** — Max 5x = 5 倍权重，Max 20x = 20 倍，Pro = 1 倍，调度优先选高价值帐号
- **未知 Keychain 检测** — Keychain 存储了配置外的帐号（如手动登录）时，daemon 自动暂停调度，不强行覆盖
- **Token 主动续期** — 临期 30 分钟内自动刷新 access token，防止用户离线期间 token 静默过期
- **TUI 帐号邮箱显示** — 仪表盘每行账户下方显示关联邮箱，一眼识别 OAuth 身份
- **TUI 60 秒自动刷新** — 打开即自动拉取所有帐号最新 usage，每 60 秒轮询一次，无需手动按 `r`
- **TUI 调度策略面板** — 显示当前活跃帐号、下一切换候选、预 ping 阈值、错峰间隔
- **系统通知** — 帐号切换、全部耗尽时发送 macOS 系统通知（可通过 `scheduler.notify: false` 关闭）
- **包名更名为 `claude-relay`**，新增 `claude-relay` 命令别名（保留 `interval-claude` 向后兼容）

### 改进
- Ping 默认使用 `--model haiku`，最小化 ping 操作对额度的消耗
- 日志时间戳改为东八区（`+08:00`）格式，告别难读的 UTC
- `add` 命令自动获取并保存账户邮箱（调用 `/api/oauth/profile`）
- `start` 命令默认进入 TUI 仪表盘（`--no-tui` 可关闭）
- `add` 命令对已有帐号进入更新模式，保留原有 offset 等配置

### 修复
- 修复 daemon 因 Keychain 未知 token 持续触发 USE 动作、每 60 秒覆盖一次 Keychain 导致用量暴涨的严重 bug
- 修复 OAuth token refresh 端点地址错误（`platform.claude.com` → 正确端点）

---

## [0.2.0] — 2026-05-23

### 新增
- **OAuth 凭证管理** — `add` 命令从 macOS Keychain 自动捕获 OAuth access/refresh token，无需手动粘贴
- **实时 usage 查询** — 对接 `/api/oauth/usage` 获取 5 小时 / 7 天用量，`list --refresh` 可强制拉取
- **`use` 命令** — 原子切换 Keychain 凭证，所有终端的 `claude` 命令立即生效
- **TUI 实时仪表盘** — htop 风格多帐号状态面板，方向键选择，进度条 + 颜色显示用量
- **Token 自动续期** — Ping 成功后检测 access token 是否临期，自动换新
- **`remove` 命令** — 删除指定帐号配置
- **批量 `add`** — 无参数进入交互式批量添加模式

### 改进
- 配置格式升级，支持 `credentials`（OAuth）和 `last_usage`（用量缓存）字段
- v0.1 的 `token` 字段自动懒迁移为 `legacy_token`，向后兼容
- `list` 显示订阅类型、用量百分比、重置时间
- `export-env` 替代 `switch`，输出 `export CLAUDE_CODE_OAUTH_TOKEN=...` 供 eval

---

## [0.1.0] — 2026-05-22

### 新增
- 初始发布
- 用 `claude setup-token` 生成长效 token，通过 `CLAUDE_CODE_OAUTH_TOKEN` 环境变量切换帐号
- `add` / `list` / `start` / `stop` / `status` / `ping` / `switch` 基础命令
- Daemon 主循环，按 `offset_minutes` 定时 ping 各帐号触发 5h 窗口
- 可中断 sleep，SIGTERM 后秒级响应退出
- 指数退避重试（最多 3 次）
