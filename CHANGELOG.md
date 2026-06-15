## [0.6.1](https://github.com/yezannnnn/relay-claude/compare/v0.6.0...v0.6.1) (2026-06-15)


### Bug Fixes

* **oauth:** code-exchange endpoint 迁移到 platform.claude.com 修复 add 404 ([2a6b8c0](https://github.com/yezannnnn/relay-claude/commit/2a6b8c0fc6302baa53caf34d8e1fb2e9aebd131c))

# [0.6.0](https://github.com/yezannnnn/relay-claude/compare/v0.5.2...v0.6.0) (2026-06-11)


### Features

* **tui:** 支持中英文界面切换（l 键，持久化到 config.ui.lang） ([f6e2ce2](https://github.com/yezannnnn/relay-claude/commit/f6e2ce20c88b1feaebb614b8d7de760ba22fd22c))

## [0.5.2](https://github.com/yezannnnn/relay-claude/compare/v0.5.1...v0.5.2) (2026-06-11)


### Bug Fixes

* **daemon:** usage 接口 429 面板冻结，尊重 retry-after 退避 ([d415f91](https://github.com/yezannnnn/relay-claude/commit/d415f91b4b64a73f45a4da7197be1f954bb0513f))
* **oauth:** 修复 add 流程多个实测 bug ([57df707](https://github.com/yezannnnn/relay-claude/commit/57df7073ff3b922965724de991813a31d351934b))


### Features

* **daemon:** account_uuid 自愈匹配避免 token rotation 丢账户 ([14512f8](https://github.com/yezannnnn/relay-claude/commit/14512f8eefab4e8cd01b8f5bfee5235aa539ba2f))
* **oauth:** 自实现 OAuth Authorization Code + PKCE 流程支持多账户独立 session ([7a131c7](https://github.com/yezannnnn/relay-claude/commit/7a131c7e63acac09bbf2af0af6fa3c11b84c86ee))

## [0.5.1](https://github.com/yezannnnn/relay-claude/compare/v0.5.0...v0.5.1) (2026-06-03)


### Bug Fixes

* 修复 USE 通知额度显示旧缓存 + 防止 usage 403 时重复切换通知 ([7172735](https://github.com/yezannnnn/relay-claude/commit/7172735ef439a784f6bcdd95791a3dc3ea3eec1f))

# [0.5.0](https://github.com/yezannnnn/relay-claude/compare/v0.4.1...v0.5.0) (2026-06-03)


### Bug Fixes

* 修复测试 Keychain 污染 + ACTION_USE 绕过 useAccountFn 注入 ([151d685](https://github.com/yezannnnn/relay-claude/commit/151d685f659cde6831729e839dea19e5760d4a1d))

## [0.4.1](https://github.com/yezannnnn/relay-claude/compare/v0.4.0...v0.4.1) (2026-05-25)

# [0.4.0](https://github.com/yezannnnn/relay-claude/compare/v0.3.0...v0.4.0) (2026-05-25)


### Bug Fixes

* **v0.3:** refresh endpoint platform.claude.com + daemon 主动续期临期 token ([db5fbbc](https://github.com/yezannnnn/relay-claude/commit/db5fbbc1da9baac46b8be2312b309a76bcc4dec1))


### Features

* start 默认进入 TUI + add 同名时进入更新模式 ([d496a43](https://github.com/yezannnnn/relay-claude/commit/d496a436a009edd1cdb57e2fb212fa8da732fb78))
* v0.3 claude-relay 正式发布准备 ([f063cd5](https://github.com/yezannnnn/relay-claude/commit/f063cd57da0e4698dca5d76340ca394363b74009))

# [0.3.0](https://github.com/yezannnnn/relay-claude/compare/v0.2.0...v0.3.0) (2026-05-24)


### Bug Fixes

* **tui:** ping failure shows status, no longer kills TUI ([30469da](https://github.com/yezannnnn/relay-claude/commit/30469da79f025a39e3b183d35bbde89ee7262cb7))
* **tui:** reduce flicker — overwrite in place + 10s interval ([d3903fd](https://github.com/yezannnnn/relay-claude/commit/d3903fd641ed4e448a27858081dfa943fe101a0d))


### Features

* **tui:** htop-style with arrow-key selection, color bars, no flicker ([ce71e02](https://github.com/yezannnnn/relay-claude/commit/ce71e02c73f34ac0d5b2bb9df95f73f7f5158405))
* **v0.3:** config 注入 scheduler 默认字段 + 合并用户配置 ([12df5df](https://github.com/yezannnnn/relay-claude/commit/12df5dfef0a9b7e4a035b021a14bdf372ca6be39))
* **v0.3:** daemon 集成调度循环 + pinger 检测 limit_reached ([55d9f3f](https://github.com/yezannnnn/relay-claude/commit/55d9f3fc0409024962d206a713aa95be208357a4))
* **v0.3:** notifier 模块 (osascript 系统通知) ([a950478](https://github.com/yezannnnn/relay-claude/commit/a950478d3dad6abeb155aadc473ace3c32b3f034))
* **v0.3:** scheduler 算法升级 — 健康度评分 + 动态错峰判断 ([e355bfc](https://github.com/yezannnnn/relay-claude/commit/e355bfc032afdf0fa78a197e409569a08e3732de))
* **v0.3:** TUI 加调度策略面板 + 健康度 + 状态标签 ([b4db1a9](https://github.com/yezannnnn/relay-claude/commit/b4db1a9846b1263cc3d3b5d438b81976de4a9a73))

# [0.2.0](https://github.com/yezannnnn/relay-claude/compare/3835e26584d99d584a32b22078b643c21c6c8042...v0.2.0) (2026-05-23)


### Bug Fixes

* **v0.2:** oauth.js uses curl for proxy/UA compatibility ([c56cce6](https://github.com/yezannnnn/relay-claude/commit/c56cce6fff71d9b14c8400b285de37eff9f3cc88))


### Features

* **v0.2:** add command captures OAuth credentials from Keychain ([7410a53](https://github.com/yezannnnn/relay-claude/commit/7410a53fb9d673a2895b8270267bf8d90c74900b))
* **v0.2:** config supports credentials + last_usage, lazy migrate v0.1 token ([c380740](https://github.com/yezannnnn/relay-claude/commit/c380740a127e0076858569333063b41d544c8f0c))
* **v0.2:** daemon polls usage and refreshes tokens after each ping ([904d55e](https://github.com/yezannnnn/relay-claude/commit/904d55ef7e93d583b83625ade4eb2836d5cbbb21))
* **v0.2:** keychain module for reading claude CLI OAuth credentials ([3835e26](https://github.com/yezannnnn/relay-claude/commit/3835e26584d99d584a32b22078b643c21c6c8042))
* **v0.2:** list shows subscription + usage + reset time ([e44cbd8](https://github.com/yezannnnn/relay-claude/commit/e44cbd894d555f7d6f09e9cfea1443c5bb9f3651))
* **v0.2:** oauth module for usage query and token refresh ([6e29a25](https://github.com/yezannnnn/relay-claude/commit/6e29a259cfd812a643abcb642929678ab3876187))
* **v0.2:** pinger reads credentials.accessToken via getAccessToken helper ([20775c9](https://github.com/yezannnnn/relay-claude/commit/20775c958c1c136d736544adf99d6fff059cd2ff))
* **v0.2:** remove command for deleting accounts ([d1f3a77](https://github.com/yezannnnn/relay-claude/commit/d1f3a77edbe9ebc0df6f1020edf720305a1fed88))
* **v0.2:** rename switch to export-env (keep switch as alias), use getAccessToken ([b19dc1e](https://github.com/yezannnnn/relay-claude/commit/b19dc1eb938f5ca2abed2223c0c38afb4fa8dcff))
* **v0.2:** start command interactively prompts for stagger ([11add84](https://github.com/yezannnnn/relay-claude/commit/11add84d46d4610ec2d1e61a3fd9f8dbcb88e948))
* **v0.2:** tui command for real-time multi-account dashboard ([e305851](https://github.com/yezannnnn/relay-claude/commit/e30585182fd3a8f583b790887b54de966d46e4ed))
* **v0.2:** use command swaps Keychain credentials atomically ([006d92c](https://github.com/yezannnnn/relay-claude/commit/006d92c6957663a2b1e5c2db4ecaf9e180e3453e))
