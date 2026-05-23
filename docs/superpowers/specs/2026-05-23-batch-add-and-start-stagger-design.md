# 批量加帐号 + start 时询问错峰 设计

**日期**: 2026-05-23
**状态**: 草稿
**关联代码**: `intervalClaude/`

---

## 背景

第一版 v0.1.0 实现了 `add`（单条）+ start 时直接用 config 里的 offset 启动。实际使用反馈：

1. **批量添加体验差**：3 个帐号要 add 三次，每次输入 token，繁琐
2. **错峰决策被前置**：add 时就要决定 offset，但用户实际上是配置好帐号后才想"现在开始错峰"

## 目标

- 一次添加多个帐号（交互式 + 命令行参数两种姿势）
- 错峰激活决策延后到 `start` 时再问
- 错峰间隔自动按 `5h ÷ 帐号数` 计算（不再让用户手填 offset）

---

## 设计变更

### 数据模型变更

`config.json` 中 `account.offset_minutes` 字段含义变化：

| | v0.1 旧含义 | v0.2 新含义 |
|---|---|---|
| **何时设定** | `add` 时显式或自动 | `start` 时（若选择错峰）写入 |
| **是否必填** | 是 | 否（可缺省，缺省即未参与错峰） |
| **用户输入** | 手动填或 CLI 自动 | 完全由系统在 start 时计算 |

向后兼容：v0.1 已有的 config（含 offset_minutes）继续工作，start 时给提示"检测到已有 offset 配置，使用现有错峰安排，是否重新计算？[y/N]"。

### add 命令重新设计

**用法 1：交互式批量（无参数）**
```
$ interval-claude add
请输入第 1 个帐号名: primary
请输入 token: sk-ant-xxx
继续添加？[Y/n]: y
请输入第 2 个帐号名: secondary
请输入 token: sk-ant-yyy
继续添加？[Y/n]: n
✅ 已添加 2 个帐号
配置文件: ~/.intervalClaude/config.json
```

**用法 2：命令行参数批量**
```
$ interval-claude add primary:sk-ant-xxx secondary:sk-ant-yyy tertiary:sk-ant-zzz
✅ 已添加 3 个帐号: primary, secondary, tertiary
配置文件: ~/.intervalClaude/config.json
```

**用法 3：保留旧 `add <name>` 单条**（向后兼容）
```
$ interval-claude add primary
token (帐号 primary): [输入]
✅ 已添加帐号 "primary"
```

**冲突处理**：
- 重名 → 报错并跳过（不覆盖现有 token），其他成功的继续添加
- token 格式校验（必须以 `sk-ant-` 开头）→ 不符合则报错，但保留之前已成功添加的
- 命令行参数模式遇到错误 → 部分成功，最后总结 "成功 X 个，失败 Y 个"

### start 命令新增交互

```
$ interval-claude start
检测到 3 个帐号：primary, secondary, tertiary
是否开启错峰激活？[Y/n]: Y
✅ 错峰安排（每帐号 5h 窗口，错峰间隔 100 分钟）:
   primary    → 立即 ping
   secondary  → 100 分钟后 ping
   tertiary   → 200 分钟后 ping
✅ 守护进程已启动 (pid=12345)
日志: ~/.intervalClaude/daemon.log
```

**用户答 `n`**:
```
$ interval-claude start
...
是否开启错峰激活？[Y/n]: n
所有帐号将立即 ping（无错峰）
✅ 守护进程已启动 (pid=12345)
```
→ 所有帐号 offset_minutes = 0，效果等同于同时激活

**已有 offset 配置时**:
```
$ interval-claude start
检测到已有错峰安排：primary(0) secondary(90) tertiary(180)
是否重新计算？[y/N]: N
✅ 使用现有错峰安排
✅ 守护进程已启动 (pid=12345)
```

**非交互模式**（脚本调用）:
```
$ interval-claude start --no-prompt          # 不询问，按 config 现状启动
$ interval-claude start --stagger            # 强制重新错峰
$ interval-claude start --no-stagger         # 强制全 0 offset
```

### 错峰算法

```
interval_minutes = 300 / max(accounts.length, 1)  # 5h = 300min
for i, account in enumerate(accounts):
    account.offset_minutes = i * interval_minutes
```

3 帐号 → 间隔 100min
2 帐号 → 间隔 150min
4 帐号 → 间隔 75min

**特殊情况**：
- 1 个帐号 → offset 0，不需要错峰
- 5+ 个帐号 → 间隔 < 60min，给警告但仍执行（"间隔小于 60 分钟，错峰效果有限"）

写入 `config.json` 的 `interval_minutes` 字段也同步更新（守护进程续 ping 周期依赖这个）。

---

## CLI 帮助更新

`add` 帮助：
```
add [name[:token]...]      添加帐号
    无参数 → 进入交互式批量添加
    带参数 → 直接添加 name:token 对（用 : 分隔）
    示例:
      interval-claude add
      interval-claude add primary:sk-ant-xxx secondary:sk-ant-yyy
      interval-claude add primary                # 单条交互（输入 token）
```

`start` 帮助新增：
```
start [--stagger | --no-stagger] [--no-prompt]
    --stagger       重新计算并应用错峰（覆盖现有 offset）
    --no-stagger    所有帐号 offset=0，立即同时 ping
    --no-prompt     非交互模式，按 config 现状启动
    （无参数 → 交互询问）
```

---

## 实施分解

| Task | 内容 |
|------|------|
| 1 | 新增 `src/commands/stagger.js` — 错峰算法 + 单测 |
| 2 | 重写 `src/commands/add.js` 支持批量 + 命令行参数 |
| 3 | 重写 `src/commands/daemon-cmd.js` 的 startCommand 加交互 |
| 4 | 更新 cli.js 帮助文本 |
| 5 | 手动 E2E 验证（交互、命令行、有/无 stagger） |

---

## 不在本次范围

- 删除帐号命令（remove）—— 已有 removeAccount 函数但无 CLI 入口
- 修改 interval_minutes 命令 —— 现在通过 stagger 自动计算，无需手改
- token keychain 存储 —— 后续优化
- token 格式严格校验 —— 仅做前缀检查
