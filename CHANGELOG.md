# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 规范。

---

## [0.4.1] — 2026-05-25

### 修复
- **🔴 严重 bug：race condition 导致 token chain 断裂** — TUI 5min 自动刷新 / 用户按 `r` 会做 `loadConfig → 改 → saveConfig`，过程中 daemon 同时也在写 config。TUI 用旧快照写回时，把 daemon 续期的新 token 覆盖回旧 token。下次 daemon 用废了的 refresh_token 调 API 返回 invalid_grant，所有账户雪崩。表现：第二天打开必须每个账户重新 `/login`。
- **🔴 严重 bug：死循环 PING 浪费额度** — `usage` 查询失败（429 限流）时，daemon 写入的 placeholder window 被 TUI 的 race 覆盖。下个周期 daemon 又判定备用账户"未激活"，又 PING 一次，每分钟一次循环。单账户额度被白白消耗 10-20%。
- **🔴 严重 bug：refresh 失败重试触发 IP 限流** — 之前 daemon refresh 失败后下个 60s 循环就重试，连续失败时每分钟打废 Anthropic API，触发 IP 级限流，导致所有账户的 usage 查询雪崩。
- **🟡 切换震荡** — `usage` 查询失败时写入的 placeholder window utilization=0，被调度器误判为"满血账户"，可能被选作切换目标，切过去发现实际耗尽又切回。

### 改进
- **`updateConfig(updater)` 原子化写入接口** — 新增 `src/config.js`。所有写 config 的入口（daemon × 3、tui、list、add、remove、use 共 8 处）统一走此接口，每次都重新 `loadConfig` 拿最新版本再 patch，杜绝读旧写新覆盖。
- **TUI 不再主动 refresh token** — TUI 改用 `queryUsage`（不 refresh），只读 usage，token 续期完全交给 daemon。TUI 失败时显示"待续期"而不是"失败"。
- **daemon refresh 失败指数退避** — 1min → 2min → 4min → 8min → 16min → 30min（封顶）。避免连续 invalid_grant 时每分钟打废 API。
- **placeholder 加 `isPlaceholder: true` 标记**，调度器对其健康度打 0.3 折扣，避免误选作切换目标。
- **daemon 续期成功后同步写 Keychain**（如果该账户正是 active），避免 config 里是新 token、Keychain 里是旧 token。

### 测试
- 新增 `updateConfig` 单测 4 个（原子读改写、串行依赖、边界）
- 总测试数 91 → 95，全部通过

---

## [0.4.0] — 2026-05-25

### 新增
- **ASCII Banner** — `relay-claude --help / --version / start` 时显示 Logo + tagline
- **iTerm2 来源通知** — TUI 在跑时通过 OSC 9 escape 让通知显示为 iTerm2 图标（与 Claude CLI 一致）。daemon 与 TUI 通过共享文件 `~/.intervalClaude/pending-notification.json` 通信
- **terminal-notifier 集成** — 如检测到已安装则优先使用，让通知显示正确的来源 app 图标（无依赖时回退 osascript）
- **预激活通知** — 新增"已预激活备用帐号"通知，带触发原因（错峰间隔到达 / 用量阈值触发）
- **接力优先切换策略** — `bestSwitchCandidate` 优先选已激活的备用，避免预激活白做。新增 `MIN_REMAINING_FOR_RELAY=10min` 阈值，剩余太少则让位给未激活备用
- **TUI 失败原因显示** — `已刷新 ... — 3 OK, 1 失败: 备用1` 直接标出哪个账户失败
- **可配置预 ping 阈值** — `scheduler.preping_usage_threshold`，默认 50%

### 改进
- 项目重命名为 **relay-claude**（包名 + 命令名 + git 仓库）；保留 `interval-claude` 命令别名
- **预 ping 链式策略** — 每个 active 账户最多只激活下一个备用，避免一次性 ping 多个备用过早消耗 5h 窗口；切换后由新 active 自己接力
- **TUI 自动刷新拉长到 5 分钟**（原 60 秒），账户间加 800ms 间隔，避免 Anthropic IP 限流
- TUI 标题栏改为 `▲ relay-claude`，统一品牌呈现
- 通知文案优化：`主力 → 备用1` 直观展示切换路径

### 修复
- **🐛 严重 bug：daemon 死循环 PING 同一备用** — ping 成功但 usage 查询失败（如 429 限流）时，未写入 `resets_at`，导致下个周期再次判定为"未激活" → 重复 ping。修复：usage 失败时写入占位 5h 窗口，避免重复 ping 触发 IP 限流
- **🐛 切换不走预激活备用** — 健康度公式让未激活账户始终赢已激活的（按满 5h 计分），导致预激活的备用被跳过。修复：切换优先级分两层，已激活 + 剩余 ≥ 10min 的备用优先

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
- **包名更名为 `relay-claude`**，新增 `relay-claude` 命令别名（保留 `interval-claude` 向后兼容）

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
