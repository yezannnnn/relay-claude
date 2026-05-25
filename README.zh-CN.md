# relay-claude

> **一个让你的 Claude Code 多账户流水线运转、不再被 5 小时窗口卡住的工具。**

[中文文档](./README.zh-CN.md) · [Changelog](./CHANGELOG.md)

## 你遇到的问题

Claude Code 的额度按 **5 小时滚动窗口** 计算。如果你只用一个账户：

```
账户 A  [09:00 ━━━━━━━━ 用完] ……等 5 小时 ……  下午两点就开始干等
```

就算你有好几个账户也好不到哪去 —— 因为每个账户的 5 小时窗口要"用过才开始计时"。等到 A 用完才登录 B，B 的窗口才刚开始，又要等 5 小时；等 B 用完登录 C，又要重新等。**你的几个账户其实是一个个孤岛，不是流水线。**

## relay-claude 怎么解决

把多个账户编成一条**接力流水线**：

```
账户 A  [09:00 ━━━━━━━━━━━━━ 14:00]    ← 你在用
账户 B        [10:15 ━━━━━━━━━━━━━ 15:15]    ← A 用到 50%，自动唤醒 B
账户 C              [11:30 ━━━━━━━━━━━━━ 16:30]    ← B 用到 50%，自动唤醒 C
账户 D                    [12:45 ━━━━━━━━━━━━━ 17:45]   ← 形成循环
                ↑              ↑              ↑
            正常工作       A 满 → 切 B    B 满 → 切 C
```

核心做法：

1. **错峰激活**：根据账户数自动算间隔（5h ÷ N），到点 ping 一下让备用账户的 5 小时窗口提前开始计时
2. **50% 阈值预启动**：主账户用到 50% 时，自动唤醒下一个备用账户，等你切过去时它已经热身好几小时
3. **自动切换**：主账户用满 100%，立刻切换 Keychain 凭证，所有终端的 `claude` 命令同步生效
4. **健康度调度**：实时给每个账户打分（订阅权重 × 剩余额度 × 剩余时长），永远切到最优账户

结果：**A 用完用 B，B 用完用 C，C 用完时 A 的窗口刚好重置可以接着用** —— 几个账户像传送带一样转起来，不再有等待。

**当前仅支持 macOS**（依赖 Keychain）。Linux / Windows 支持计划中。

---

## 安装

### npm（推荐）

```bash
npm install -g relay-claude
```

### 从源码

```bash
git clone https://github.com/yezannnnn/relay-claude.git
cd relay-claude
npm link
```

**依赖：** Node.js ≥ 18、macOS、`curl` 在 PATH 中。零运行时依赖，只用 Node.js 标准库。

---

## 快速开始

### 1. 添加账户

```bash
# 先登录账户 A
claude /logout && claude /login

# relay-claude 自动读取 Keychain 捕获凭证
relay-claude add primary
# 显示：订阅类型 + 5h 用量 + 邮箱
```

逐个添加其余账户（每次先登出再登入）：

```bash
claude /logout && claude /login
relay-claude add secondary

claude /logout && claude /login
relay-claude add tertiary
```

或使用**交互式批量模式**：

```bash
relay-claude add    # 逐个引导添加
```

### 2. 查看所有账户

```bash
relay-claude list             # 读本地缓存（快）
relay-claude list --refresh   # 实时查 API
```

```
NAME       SUB     5H 用量   重置      7天    状态
─────────  ──────  ──────    ───────   ────   ──────
* primary  Max5x    57%      4h32m 后   14%   🟢 活跃
  secondary Pro      0%      —           0%   ⚪ 待激活
  tertiary  Pro     23%      2h11m 后    5%   🔵 备用
```

`*` 表示当前 Keychain 中的活跃账户（所有终端生效）。

### 3. 启动守护进程

```bash
relay-claude start
# ✅ 守护进程已启动 (pid=12345)
# 日志写入 ~/.intervalClaude/daemon.log
```

### 4. 实时仪表盘

```bash
relay-claude tui
```

```
intervalClaude    18:42:57    上次刷新: 18:42:00    Daemon: ● 运行中 (uptime 2h14m)

┌─ 调度策略 ─────────────────────────────────────────────
│ 活跃: primary (Max5x) ← health 187
│ 下一切换候选: secondary (Pro) ← health 231
│ 阈值: 切换=100%   预ping=50% 或 75min   错峰间隔=75min (300÷4)
└────────────────────────────────────────────────────────

  NAME       SUB    5H 用量                  7天   下次     重置     H分   状态
  primary    Max5x  ████████▌░░░░░░░░░░  57%  14%  —      2h18m  187   🟢 活跃
  secondary  Pro    ░░░░░░░░░░░░░░░░░░░░  0%   0%  ping@23m —    300   ⚪ 待激活
  tertiary   Pro    ████▌░░░░░░░░░░░░░░  23%   5%  —      2h11m  178   🔵 备用

↑↓ 选择   Enter 切换   p ping   r 立即刷新   q 退出
```

仪表盘每 **60 秒**自动从 API 拉取最新用量，无需手动刷新。

### 5. 手动切换账户

```bash
relay-claude use secondary
# ✅ 已切换到 secondary（Pro，剩余 88%，4h32m 后重置）
```

> ⚠️ **切换后需重启 Claude CLI**：Keychain 凭证已更新，但正在运行的 `claude` 进程持有旧 token 的内存缓存。关闭当前终端中的 claude 会话并重新打开，新账户才会生效。

### 6. 停止守护进程

```bash
relay-claude stop
```

---

## 调度策略

### 健康度评分

每个周期对所有账户计算健康度：

| 账户状态 | 健康度公式 |
|----------|-----------|
| 待激活（窗口未开启） | `权重 × 1.0 × 300` |
| 窗口已过期 | `权重 × 1.0 × 300` |
| 窗口进行中，用量 < 100% | `权重 × (1 − 用量) × 剩余分钟` |
| 用量 ≥ 100% | `0` |
| 窗口 < 3 分钟到期 | `0` |

**订阅权重：**

| 订阅 | 权重 |
|------|------|
| Pro | 1× |
| Max 5x | 5× |
| Max 20x | 20× |
| Team | 10× |

Max 5x 账户 50% 用量的健康度，远高于一个全新的 Pro 账户。

### 触发条件

**强制切换** — 当前活跃账户满足以下任一条件时：
- 用量 ≥ 100%
- 5h 窗口已过期
- 10 分钟内触发了 limit_reached
- Keychain 中无任何账户

**预 ping** — 主账户用量达到 **50%** 时，自动 ping 下一个休眠备用账户，提前开启其 5h 窗口。

### 安全保护

- **未知 Keychain 检测**：Keychain 中的 token 不属于任何已配置账户（如你手动登录了其他账户）时，daemon 暂停全部调度，不强行覆盖
- **Ping 使用 Haiku 模型**：每次 ping 消耗极小，不影响额度
- **Token 主动续期**：临期 30 分钟内自动刷新，防止 token 静默过期

---

## 命令一览

### 账户管理

| 命令 | 说明 |
|------|------|
| `add [name] [--offset N]` | 从 Keychain 捕获凭证；无参数 = 批量模式 |
| `list [--refresh]` | 列出账户、订阅类型、用量 |
| `remove <name> [--yes]` | 删除账户 |
| `use <name>` | 全局切换 Keychain（所有终端生效） |

### 守护进程

| 命令 | 说明 |
|------|------|
| `start [--no-tui]` | 启动后台守护进程 |
| `stop` | 停止守护进程（SIGTERM → 5s 后 SIGKILL） |
| `status` | 查看运行状态、PID、运行时长 |
| `ping <name>` | 手动触发一次 ping |
| `tui` / `watch` | 打开实时仪表盘 |

---

## 配置文件

存储路径：`~/.intervalClaude/`（可通过 `INTERVAL_CLAUDE_HOME` 覆盖）

`config.json` 示例：

```json
{
  "interval_minutes": 100,
  "ping_prompt": "hi",
  "accounts": [
    {
      "name": "primary",
      "offset_minutes": 0,
      "credentials": {
        "accessToken": "sk-ant-oat01-...",
        "refreshToken": "sk-ant-ort01-...",
        "expiresAt": 1779573809608,
        "subscriptionType": "max_5x",
        "email": "you@example.com"
      },
      "last_usage": {
        "five_hour": { "utilization": 0.57, "resets_at": "2026-05-24T11:00:00Z" },
        "seven_day":  { "utilization": 0.14, "resets_at": "2026-05-29T08:00:00Z" }
      }
    }
  ],
  "scheduler": {
    "enabled": true,
    "stagger_min": 75,
    "preping_usage_threshold": 0.5,
    "notify": true,
    "sub_weights": { "pro": 1, "max_5x": 5, "max_20x": 20, "team": 10 }
  }
}
```

文件权限 `0o600`（仅本人可读写）。**不要提交到 git**。

---

## 平台支持

| 平台 | 状态 |
|------|------|
| macOS | ✅ 完整支持（Keychain） |
| Linux | ⏳ 计划中 — 读 `~/.config/claude/credentials.json` |
| Windows | ⏳ 计划中 — Credential Manager |

---

## 安全提示

- `config.json` 含明文 token，请设置权限为 `600`，**不要提交到公开仓库**
- Token 泄露时立即前往 https://claude.ai/settings/keys 撤销
- 使用 Anthropic 内部 OAuth 接口（`/api/oauth/usage`、`/api/oauth/profile`），与 Claude CLI 使用相同端点，相对稳定，但非官方文档接口

---

## 更新日志

查看 [CHANGELOG.md](./CHANGELOG.md) 了解各版本变更详情。

---

## License

MIT © yezannnnn
