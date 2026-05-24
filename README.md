# intervalClaude

错峰激活多个 Claude Code 帐号，最大化每日可用时长。

每个 Claude 帐号有 5 小时滚动重置窗口。如果你有 3 个帐号，按 100 分钟错峰激活，可以让三个 5h 窗口拼接覆盖 8-9 小时工作日。

> **v0.3 新增**：完全动态调度 — daemon 实时评估帐号健康度，按 sub 等级 + 剩余 usage + 窗口剩余时间打分，自动 ping 维护窗口重叠，主帐号用满自动切换。macOS 系统通知。Max 5x = Pro × 5，Max 20x = Pro × 20。
>
> v0.2: OAuth 凭证 + 实时 usage 查询 + `use` 全局切换 + TUI 仪表盘。

## 工作原理

```
帐号 A 窗口  [09:00 ━━━━━━━━━━━━━━━━━ 14:00]
帐号 B 窗口         [10:40 ━━━━━━━━━━━━━━━━━ 15:40]
帐号 C 窗口                [12:20 ━━━━━━━━━━━━━━━━━ 17:20]
                  ↑          ↑          ↑
              你正常工作    A 用完切 B    B 用完切 C
```

守护进程定时为每个帐号发一条 `claude -p "hi"`，让各自的 5h 窗口开始计时。
你主帐号额度用完时跑 `interval-claude use <name>` 瞬间切换到剩余时间最多的帐号。

## 安装

```bash
git clone https://github.com/yezannnn/intervalClaude.git
cd intervalClaude
npm link            # 注册全局命令 interval-claude
```

要求：
- Node.js 18+
- macOS（v0.2 仅支持，依赖 Keychain）
- 零运行时依赖

## 快速开始

### 1. 添加第一个帐号

```bash
# 登录帐号 A
claude /login

# 让 intervalClaude 捕获凭证
interval-claude add primary
# 提示"请先运行 claude /login..."，按回车继续
# 自动读 Keychain，验证 + 显示订阅类型 + 5h 使用率
```

### 2. 添加更多帐号

```bash
# 登出 A，登录 B
claude /logout
claude /login

interval-claude add secondary

# 重复添加 tertiary…
```

或者**交互式批量**：

```bash
interval-claude add
# 提示"准备好登录第 1 个？" → Y → 输入名字 → 自动读取
# 然后提示第 2 个…
```

### 3. 查看所有帐号

```bash
interval-claude list           # 用缓存的 usage（快）
interval-claude list --refresh # 实时查询 API
```

输出示例：
```
NAME       SUB   5H USE  RESETS    7D USE  STATUS
─────────  ────  ──────  ────────  ──────  ──────
* primary  Pro    57%    in 4h32m   14%    🟢
  secondary Pro    0%     -          0%    ⚪
  tertiary Max5x  23%    in 2h11m    5%    🟢

interval_minutes=100  共 3 个帐号
```

`*` 表示当前 Keychain 活跃的帐号。

### 4. 启动守护进程

```bash
interval-claude start
# 检测到 3 个帐号: primary, secondary, tertiary
# 是否开启错峰激活? [Y/n]: Y
# ✅ 错峰安排（5h ÷ 3 = 100 分钟间隔）:
#    primary  → 立即 ping
#    secondary → 100 分钟后 ping
#    tertiary → 200 分钟后 ping
# ✅ 守护进程已启动 (pid=12345)
```

守护进程会：
- 按错峰安排自动 ping 每个帐号触发 5h 窗口
- 每次 ping 后查询并缓存 usage
- 自动续期临期 token

### 5. 切换帐号

主帐号额度用完时：

```bash
interval-claude use secondary
# 备份当前 Keychain 到帐号: primary
# ✅ 已切换到 secondary
#    订阅: Pro
#    5h 使用: 12% (剩余 88%)
# 所有终端的 claude 命令立即生效
```

或自动选剩余时间最多的：

```bash
eval "$(interval-claude export-env)"  # 仅当前 shell
```

### 6. 实时仪表盘

```bash
interval-claude tui
```

```
┌─ intervalClaude · 守护进程运行中 (uptime 1h 23m) ─────┐
│                                                       │
│  NAME         SUB      5H USE         7D USE  NEXT    │
│  ────────     ────     ───────────    ──────  ──────  │
│  * primary    Pro      ███▌░ 57%      14%     已过    │
│    secondary  Pro      ░░░░░ 0%       0%      1h23m   │
│    tertiary   Max5x    █▌░░░ 23%      5%      3h10m   │
│                                                       │
│  当前 Keychain: primary                               │
│                                                       │
│  [r] 刷新  [u] 切换  [p] ping  [q] 退出              │
└───────────────────────────────────────────────────────┘
```

按键：
- `r` — 强制 API 刷新所有帐号 usage
- `u` — 切换帐号（弹出选择菜单）
- `p` — 手动 ping
- `s` — 启动 daemon（如未运行）
- `q` — 退出

### 7. 停止守护进程

```bash
interval-claude stop
```

## 命令清单

### 帐号管理

| 命令 | 说明 |
|------|------|
| `add [name] [--offset N]` | 从 Keychain 捕获凭证；无参数 = 批量 |
| `list [--refresh]` | 列出帐号 + 订阅 + usage |
| `remove <name> [--yes]` | 删除帐号 |
| `use <name>` | 全局切换 Keychain（所有终端立即生效） |
| `export-env [name]` | 输出 shell export 命令（仅当前 shell） |

### 守护进程

| 命令 | 说明 |
|------|------|
| `start` | 启动（交互式询问错峰） |
| `stop` | 停止 |
| `status` | 查看状态 |
| `ping <name>` | 手动触发 ping |
| `tui` | 实时多帐号仪表盘 |

## 配置文件

存储位置：`~/.intervalClaude/`（可通过 `INTERVAL_CLAUDE_HOME` 覆盖）

`config.json` (v0.2 格式)：
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
        "scopes": ["user:profile", "user:inference", ...],
        "subscriptionType": "pro"
      },
      "last_usage": {
        "five_hour": {"utilization": 0.57, "resets_at": "2026-05-23T19:00:00Z"},
        "seven_day": {"utilization": 0.14, "resets_at": "2026-05-28T15:00:00Z"}
      }
    }
  ]
}
```

文件权限 0o600（仅本人可读写）。**不要提交到 git**。

## v0.1 → v0.2 升级

v0.1 用 `claude setup-token` 生成的长效 token 没有 `user:profile` scope，无法查 usage。

升级方式：
1. 安装 v0.2
2. 跑 `interval-claude list` — 旧帐号会显示 SUB="v0.1"
3. 对每个帐号：
   ```bash
   claude /logout
   claude /login        # 登录该帐号
   interval-claude remove <name> --yes
   interval-claude add <name>
   ```

## 跨平台

| 平台 | 状态 |
|------|------|
| macOS | ✅ v0.2 完整支持（Keychain） |
| Linux | ⏳ v0.3 计划（读 `~/.config/claude/credentials.json`） |
| Windows | ⏳ v0.3 计划（Credential Manager） |

## 技术细节

- **零运行时依赖**：只用 Node.js 标准库 + `curl` 命令
- **Usage API**：`https://api.anthropic.com/api/oauth/usage` (非官方但稳定)
- **Token refresh**：`POST /api/oauth/token` (client_id 与 claude CLI 一致)
- **代理支持**：通过 `curl` 自动读 `https_proxy` 环境变量
- **错峰算法**：`offset_minutes = i * (300 / N)` 自动按帐号数分配

## 安全提醒

- `config.json` 含明文 token，**绝不要提交到公开仓库**
- Token 泄露时立即去 https://claude.ai/settings/keys 撤销
- 调用 Anthropic 非官方 API（`/api/oauth/usage`）有改动风险，但同样的 endpoint 被 cc-switch、claude CLI 自身使用，相对稳定

## License

MIT
