# intervalClaude

错峰激活多个 Claude Code 帐号，最大化每日可用时长。

每个 Claude 帐号有 5 小时滚动重置窗口。如果你有 3 个帐号，按 100 分钟错峰激活，可以让三个 5h 窗口拼接覆盖 8-9 小时工作日。

## 工作原理

```
帐号 A 窗口  [09:00 ━━━━━━━━━━━━━━━━━ 14:00]
帐号 B 窗口         [10:40 ━━━━━━━━━━━━━━━━━ 15:40]
帐号 C 窗口                [12:20 ━━━━━━━━━━━━━━━━━ 17:20]
                  ↑          ↑          ↑
              你正常工作    A 用完切 B    B 用完切 C
```

守护进程定时给每个帐号发一条 `claude -p "hi"`，让它各自的 5h 窗口开始计时。你只需要在主帐号额度用完时运行 `interval-claude switch`，瞬间切换到剩余时间最多的帐号。

## 安装

```bash
git clone https://github.com/yezannnn/intervalClaude.git
cd intervalClaude
npm link            # 注册全局命令 interval-claude
```

要求 Node.js 18+。零运行时依赖。

## 准备工作

为每个 Claude 帐号生成长效 token：

```bash
# 登录帐号 A
claude /login
claude setup-token   # 输出一个 sk-ant-xxx token，复制保存

# 切换到帐号 B 重复
claude /logout
claude /login
claude setup-token
```

## 快速开始

```bash
# 1. 初始化（添加第一个帐号）
interval-claude init

# 2. 添加更多帐号（offset 自动按 100min 递增）
interval-claude add secondary
interval-claude add tertiary

# 3. 查看帐号列表
interval-claude list

# 4. 启动守护进程（后台运行）
interval-claude start

# 5. 主帐号用完时，切到剩余时间最多的帐号
eval "$(interval-claude switch)"
claude   # 这下走新帐号

# 6. 实时仪表盘（可选）
interval-claude watch

# 7. 停止守护进程
interval-claude stop
```

## 命令清单

| 命令 | 说明 |
|------|------|
| `init` | 交互式向导，添加第一个帐号 |
| `add <name>` | 添加帐号，可选 `--offset N`（默认自动排队） |
| `list` | 列出所有帐号 + ping 状态 + 估算剩余时间 |
| `start` | 启动守护进程（后台运行） |
| `stop` | 停止守护进程 |
| `status` | 查看守护进程状态 |
| `switch [name]` | 输出 shell 命令切换 token。不带 name 自动选剩余最多的 |
| `ping <name>` | 手动触发某帐号 ping（测试用） |
| `watch` | 实时 ASCII 仪表盘 |

### switch 的 shell 适配

```bash
# Bash / Zsh (默认)
eval "$(interval-claude switch)"

# PowerShell
interval-claude switch --shell pwsh | Invoke-Expression

# CMD
interval-claude switch --shell cmd > %TEMP%\set.bat && %TEMP%\set.bat
```

## 配置文件

存储位置：
- Mac/Linux: `~/.intervalClaude/`
- Windows: `%USERPROFILE%\.intervalClaude\`

可通过环境变量 `INTERVAL_CLAUDE_HOME` 覆盖（用于测试）。

`config.json`:
```json
{
  "interval_minutes": 100,
  "ping_prompt": "hi",
  "accounts": [
    {"name": "primary",   "token": "sk-ant-xxx", "offset_minutes": 0},
    {"name": "secondary", "token": "sk-ant-xxx", "offset_minutes": 100},
    {"name": "tertiary",  "token": "sk-ant-xxx", "offset_minutes": 200}
  ]
}
```

文件权限 0o600（仅本人可读写）。**不要提交到 git**。

## 守护进程行为

- 每 60 秒扫描一次配置和状态
- 按 `started_at + offset_minutes` 计算每个帐号的首次 ping 时间
- 已 ping 过的帐号按 `interval_minutes × 帐号数` 周期续 ping
- ping 失败自动重试 3 次（指数退避 1s/2s/4s）
- 单帐号失败不影响其他帐号
- 配置/状态文件每轮重读，支持运行时修改

日志写入 `~/.intervalClaude/daemon.log`。

## 跨平台

| 项 | Mac/Linux | Windows |
|---|---|---|
| 配置路径 | `~/.intervalClaude/` | `%USERPROFILE%\.intervalClaude\` |
| 后台进程 | `spawn detached` + unref | 同样 |
| 信号 | SIGTERM | Node 模拟 SIGTERM |
| Switch 输出 | `export VAR=xxx` | `set VAR=xxx` 或 PowerShell `$env:VAR='xxx'` |

## 开发

```bash
npm test           # 跑所有单元测试（54+ 个）
node bin/interval-claude --help
```

测试用临时目录隔离（`INTERVAL_CLAUDE_HOME=/tmp/test-idc`），不污染真实配置。

## 安全提醒

- `config.json` 含明文 token，**永远不要提交到公开仓库**
- Token 一旦泄露可用任何 Claude API 调用计入你的额度
- 如果 token 泄露，去 https://claude.ai/settings/keys 撤销

## 常见问题

**Q: 守护进程跑着，电脑睡眠唤醒后还能工作吗？**
A: 唤醒后下次 60s 扫描会立即补上逾期未 ping 的帐号。

**Q: 怎么知道某帐号 5h 窗口什么时候到期？**
A: `interval-claude list` 显示 REMAIN(m) 列；或 `interval-claude watch` 实时看。

**Q: 主帐号还有额度但我想提前切？**
A: `interval-claude switch <name>` 显式指定。

**Q: ping 用的是什么模型？**
A: 默认 prompt "hi"，触发当前帐号的 5h 窗口开始计时。可改 config.json 的 `ping_prompt`。

## License

MIT
