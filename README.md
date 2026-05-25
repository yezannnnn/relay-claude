# relay-claude

> **Turn your multiple Claude Code accounts into a relay pipeline — never get stuck waiting for a 5-hour window to reset.**

[中文文档](./README.zh-CN.md) · [Changelog](./CHANGELOG.md)

## The Problem

Claude Code enforces a **5-hour rolling usage window**. With a single account:

```
Account A  [09:00 ━━━━━━━━ depleted] …wait 5 hours… you're idle by 2pm
```

Multiple accounts don't help by default — each account's 5-hour window only starts counting **after first use**. So you burn through A, log in to B, *then* B's window starts (wait 5 more hours), then C (5 more hours)... Your accounts are islands, not a pipeline.

## How relay-claude Solves It

It chains your accounts into a **relay pipeline**:

```
Account A  [09:00 ━━━━━━━━━━━━━ 14:00]   ← you're here
Account B        [10:15 ━━━━━━━━━━━━━ 15:15]   ← A hits 50% → wake B
Account C              [11:30 ━━━━━━━━━━━━━ 16:30]   ← B hits 50% → wake C
Account D                    [12:45 ━━━━━━━━━━━━━ 17:45]  ← forms a loop
                ↑              ↑              ↑
           you work       A full → B     B full → C
```

How it works:

1. **Staggered activation** — interval is auto-calculated from account count (5h ÷ N). A background ping opens each backup's 5-hour window ahead of time
2. **50% pre-launch** — when the active account hits 50% usage, the next backup is auto-pinged so it's already warmed up by the time you switch
3. **Auto-switch** — when the active account hits 100%, the Keychain credential is swapped instantly. Every terminal's `claude` command updates immediately
4. **Health scoring** — each account gets a real-time score (subscription weight × remaining quota × remaining window). The daemon always picks the highest-scoring backup

The result: **A → B → C, and by the time C runs out, A's window has already reset.** Your accounts run like a conveyor belt — no more waiting.

**macOS only** (depends on Keychain). Linux/Windows planned.

---

## Installation

### npm (recommended)

```bash
npm install -g relay-claude
```

### From source

```bash
git clone https://github.com/yezannnn/relay-claude.git
cd relay-claude
npm link
```

**Requirements:** Node.js ≥ 18, macOS, `curl` in PATH.  
No runtime dependencies — only Node.js built-ins.

---

## Quick Start

### 1. Add accounts

```bash
# Log in to account A first
claude /logout && claude /login

relay-claude add primary
# → reads Keychain, verifies token, shows subscription + usage
```

Repeat for each account (log out, log in, then `add`):

```bash
claude /logout && claude /login
relay-claude add secondary

claude /logout && claude /login
relay-claude add tertiary
```

Or use interactive batch mode:

```bash
relay-claude add    # prompts for each account one by one
```

### 2. Check status

```bash
relay-claude list           # cached usage (instant)
relay-claude list --refresh # live API query
```

```
NAME       SUB     5H USAGE  RESETS     7D    STATUS
─────────  ──────  ────────  ─────────  ────  ──────
* primary  Max5x    57%      in 4h32m   14%   🟢 active
  secondary Pro      0%      —           0%   ⚪ dormant
  tertiary  Pro     23%      in 2h11m    5%   🔵 backup
```

`*` marks the account currently in Keychain (active for all terminals).

### 3. Start the daemon

```bash
relay-claude start
# ✅ Daemon started (pid=12345)
# Logs → ~/.intervalClaude/daemon.log
```

### 4. Live dashboard

```bash
relay-claude tui
```

```
intervalClaude    18:42:57    上次刷新: 18:42:00    Daemon: ● running (uptime 2h 14m)

┌─ 调度策略 ──────────────────────────────────────────────
│ 活跃: primary (Max5x) ← health 187
│ 下一切换候选: secondary (Pro) ← health 231
│ 阈值: 切换=100%   预ping=25% 或 75min   错峰间隔=75min (300÷4)
└────────────────────────────────────────────────────────

  NAME          SUB      5H USAGE               7D    NEXT     RESETS    H分   状态
  primary       Max5x    ████████▌░░░░░░░░░░░  57%    14%    —        2h18m  187   🟢 活跃
  secondary     Pro      ░░░░░░░░░░░░░░░░░░░░   0%     0%    ping@23m  —       300   ⚪ 待激活
  tertiary      Pro      ████▌░░░░░░░░░░░░░░░  23%     5%    —        2h11m   178   🔵 备用

↑↓ 选择   Enter 切换   p ping   r 立即刷新   q 退出
```

Dashboard auto-refreshes usage from API every **60 seconds**. Press `r` to force an immediate refresh.

### 5. Manual account switch

```bash
relay-claude use secondary
# ✅ Switched to secondary (Pro, 88% remaining, resets in 4h32m)
```

> ⚠️ **Restart Claude CLI after switching**: The Keychain credential is updated immediately, but any running `claude` process holds the old token in memory. Close and reopen your claude session for the new account to take effect.

### 6. Stop the daemon

```bash
relay-claude stop
```

---

## Scheduling Strategy (v0.3)

### Health Score

Every account is assigned a health score each cycle:

| Account state | Health formula |
|---------------|----------------|
| Dormant (window not started) | `weight × 1.0 × 300` |
| Window expired | `weight × 1.0 × 300` |
| Active window, usage < 100% | `weight × (1 − usage) × remaining_minutes` |
| Usage ≥ 100% | `0` |
| Window expires in < 3 min | `0` |

**Subscription weights** (configurable):

| Plan | Weight |
|------|--------|
| Pro | 1× |
| Max 5x | 5× |
| Max 20x | 20× |
| Team | 10× |

A Max 5x account at 50% usage is scored as more valuable than a fresh Pro account.

### When the Daemon Acts

**Force switch** — triggered when the active account:
- usage ≥ 100%
- 5-hour window expired
- hit rate-limit in the last 10 minutes
- no account found in Keychain

Action: switch to the highest-health alternative. If that account's window hasn't started → `PING` first, then `USE`.

**Pre-ping** — triggered when the active account is healthy but:
- elapsed time since window start ≥ `300min ÷ N` (stagger interval), OR
- active usage ≥ `1 ÷ N` (proportional threshold)

Action: `PING` the next dormant backup account to open its window.

With 4 accounts, the stagger interval is `300 ÷ 4 = 75 minutes` and the usage threshold is `25%`. The daemon pre-pings a backup after the active account has been running for 75 minutes or has used 25% of its quota — whichever comes first.

### Safety Guards

- **Unknown Keychain token**: if the Keychain holds a token that doesn't belong to any configured account (e.g. you manually logged into a personal account), the daemon pauses all scheduling and logs the event. It will not overwrite your manual login.
- **Ping model**: all pings use `--model haiku` (cheapest model) to minimize quota impact.
- **Token auto-renewal**: tokens expiring in < 30 minutes are renewed proactively to prevent silent expiry.

---

## Commands

### Account management

| Command | Description |
|---------|-------------|
| `add [name] [--offset N]` | Capture credentials from Keychain; no args = batch |
| `list [--refresh]` | List accounts with subscription, usage, health |
| `remove <name> [--yes]` | Remove an account |
| `use <name>` | Switch global Keychain credential (all terminals) |

### Daemon

| Command | Description |
|---------|-------------|
| `start [--no-tui]` | Start background daemon |
| `stop` | Stop daemon (SIGTERM → SIGKILL after 5s) |
| `status` | Show running state, PID, uptime |
| `ping <name>` | Manually trigger one ping |
| `tui` / `watch` | Live dashboard |

---

## Configuration

Stored in `~/.intervalClaude/` (override with `INTERVAL_CLAUDE_HOME`).

### `config.json`

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
        "scopes": ["user:profile", "user:inference"],
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
    "expire_threshold_min": 3,
    "notify": true,
    "sub_weights": {
      "pro": 1,
      "max_5x": 5,
      "max_20x": 20,
      "team": 10
    }
  }
}
```

File permissions: `0o600` (owner read/write only). **Never commit this file.**

### `state.json` (managed by daemon)

```json
{
  "daemon_pid": 12345,
  "started_at": "2026-05-24T10:00:00+08:00",
  "last_pings": {
    "primary":   "2026-05-24T10:00:15+08:00",
    "secondary": "2026-05-24T11:15:22+08:00",
    "tertiary":  null
  }
}
```

---

## Daemon Log

Logs are written to `~/.intervalClaude/daemon.log` with UTC+8 timestamps:

```
[2026-05-24T18:42:57+08:00] daemon: 主循环启动 (v0.3 动态调度)
[2026-05-24T18:42:58+08:00] schedule: PING secondary (health=300)
[2026-05-24T18:43:25+08:00] PING secondary: OK
[2026-05-24T19:57:13+08:00] schedule: USE tertiary (health=278)
[2026-05-24T19:57:13+08:00] daemon: Keychain 属于未知帐号，暂停调度
```

---

## Platform Support

| Platform | Status |
|----------|--------|
| macOS | ✅ Full support (Keychain) |
| Linux | ⏳ Planned — reads `~/.config/claude/credentials.json` |
| Windows | ⏳ Planned — Credential Manager |

---

## Security

- `config.json` contains plaintext tokens. Set permissions to `600`, never commit to a public repo.
- If tokens are compromised, revoke them at https://claude.ai/settings/keys
- Uses Anthropic's internal OAuth endpoints (`/api/oauth/usage`, `/api/oauth/profile`) — same endpoints used by Claude CLI itself. Not officially documented but stable.

---

## License

MIT © yezannnn
