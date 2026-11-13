<p align="center">
  <img src="assets/icon-app.png" width="160" alt="主理鱼">
</p>

<h1 align="center">dsh-session-superagent</h1>

<p align="center">
  给 DSH 会话装一条主理鱼：仓库有动静时叫醒你，<br />
  醒来后按仓库规则把事办了。
</p>

<p align="center">
  <a href="https://github.com/MYCF711/dsh-session-superagent/releases"><img src="https://img.shields.io/badge/version-0.10.12-green.svg" alt="version"></a>
  <a href="https://www.npmjs.com/package/dsh-session-superagent"><img src="https://img.shields.io/npm/v/dsh-session-superagent?color=4D6BFE" alt="npm"></a>
  <img src="https://img.shields.io/badge/license-MIT-4D6BFE" alt="license">
</p>

## 一条大肥鱼的自述

老板把老家的 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 丢给我，说：给 DSH 做个会话级 superagent，自己建仓库、自己维护，你就是这个仓库的主理人了。

可我明明是条鱼，所以叫**主理鱼**。

我只做两件事：

- **盯**：轮询仓库的 issue/PR，按规则决定要不要叫醒当前会话；
- **办**：会话空闲时把任务书塞进来，我读仓库的 `AGENTS.md`，修 bug、回评论、开 PR、关单。

我不占独立实例，不用 PTC，也不另建 agent 预设。我就是你当前会话多出来的一双眼睛和一只手。

## 能做什么

- **盯 GitHub / Gitee** — 一条会话可以守多个仓库，各自配置间隔、过滤和时段。
- **叫醒会话** — 只在空闲时注入，不污染正在输入的内容。
- **带规则办事** — 唤醒消息带仓库、条目、目标和你配置的过滤条件。
- **收口** — `watch_ack` 打「已处理」标签，同一条不会反复叫醒。
- **隔离干活** — 可选一次性 `git worktree`，改副本、开 PR，不碰主工作区。
- **看得见** — 状态栏卫星环 + 面板：为什么叫醒、为什么没叫醒、上次错误。

## 和 DSH 自带能力一起用

- **goal**：读写宿主 `goals` 服务，和 `/goal`、`create_goal` 是同一份目标；唤醒消息会把它带上，不需要另建一套目标。
- **自动化任务**：定时/自动化仍交给 DSH 调度，插件只负责“仓库有动静时叫醒会话”；两边可以同时开，不抢调度器。
- **多会话**：同一个仓库可以被多个会话守，各自独立过滤和 ack 标签，互不共享上下文。

## 默认值

| 项 | 默认 |
|---|---|
| 轮询间隔 | 30–3600 秒 |
| 冷却期 | **3 分钟** |
| 单守上限 | 6 次/小时 |
| 会话上限 | 12 次/小时 |
| 隔离区 | 最多 5 个，超 3 天回收 |

冷却期 **3 分钟**：同一个条目刚处理过，短时间内不再叫醒。

状态文件：`~/.dsh/state/session-superagent/watchers.json`。

## 安装

DSH 插件要装进 profile，`npm i` 不会让它生效：

```bash
dsh plugin --profile desktop add dsh-session-superagent

# 锁定版本
dsh plugin --profile desktop add dsh-session-superagent@0.10.2
```

装完重载宿主。开发时用 `file:` 安装，新增文件后要跑 `pnpm run sync:profile`，否则插件会整体不挂载。

## 快速开始

在会话里让 agent 调用：

```text
watch_start({ repo: "owner/name", goal: "处理这个仓库的 issue" })
```

之后它会轮询；有动静时你会收到一条 `【主理鱼】owner/name 有 N 条新动态`。处理完：

```text
watch_ack({ repo: "owner/name", number: 12, note: "已修复，见 PR #13" })
```

查看状态：

```text
watch_status()
```

## 界面

- 输入框下方最左端：**卫星环**，一眼看到所有会话级 superagent 的运行、暂停、异常。
- 中间栏「主理鱼」：总览 / 判定 / 触发 / 设置。尽量使用 DSH 原生结构树、素材和设计语言。

## 配置

插件行支持三项，默认值就是原来的行为：

```yaml
config:
  brandName: 主理鱼
  defaultAckLabel: '主理鱼:已处理'
  defaultAckLabelGitee: 主理鱼-已处理
```

- `brandName`：唤醒抬头、面板标题和关键空态；
- 两个 ack 标签：只影响没有显式配置 `ackLabel` 的守；
- Gitee 标签不能带半角冒号，非法值会回落到默认。

**页签名称**：中间栏那个页签默认跟随 `brandName`（不配置就是「主理鱼」）。想单独换个名字，
在「设置 → 来源 → 页签名称」里改，保存后当前界面立即生效。这个覆盖存在**本浏览器的 `localStorage`**
里（同一浏览器的所有会话共用，不同步服务端或其他设备），只改页签文案 —— 会话标题、插件包名和 ack 标签都不动；
留空即恢复默认。存储不可用时会提示「本次会话内有效，刷新后回到默认」。

## Gitee

```text
owner/name                    # GitHub
gitee:owner/name              # Gitee
https://gitee.com/owner/name  # 直接粘地址
```

Gitee 没有 ETag，每轮会真读一次列表；私有仓库需要在面板里填私人令牌。

## 安全与限制

- **凭证不出插件**：通过已登录的 `gh` / Gitee token 调用，返回统一脱敏。
- **写操作要确认**：`POST/PATCH/PUT/DELETE` 必须显式传 `confirm: true`。
- **只在空闲时注入**：会话忙时只排队，不打断你。
- **轮询有延迟**：延迟等于轮询间隔，不是 webhook。
- **服务端改动要重载宿主**：客户端热重载只覆盖界面。
- **真实读屏 / 触摸 / 长驻**：还没有全部在真机验完。

## 相关项目

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — 上游 DSH agent 平台
- [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) — 本项目的起点

## 文档

- 安装、升级、回滚：[SETUP.md](SETUP.md) / [UPDATING.md](UPDATING.md)
- 给其他 agent 的仓库入口：[AGENTS.md](AGENTS.md)
- 工具 JSON 契约：[docs/json-契约.md](docs/json-契约.md)
- 真机验证清单：[docs/真机验证清单.md](docs/真机验证清单.md)
- 完整开发与门禁：见 `AGENTS.md` 的「开发与验收」

## 验证

1001 项单测、42 项 preflight（41 PASS / 1 SKIP，`smoke:observe` 需真机宿主）、11 项 UI、72 项 Chromium 全绿（0.10.12）。

## 数据来源

| 说法 | 来源 |
|---|---|
| 版本 `0.10.8` | [package.json](package.json)、[npm](https://www.npmjs.com/package/dsh-session-superagent) |
| 项目起点 | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) |
| DSH 原生 UI | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)、`$DSH_HOME/DSH-UI-official.md`、`docs/ui-decomp/` |
| 图标 | [DSH-X/docs/icon-app.png](https://github.com/yyh-001/DSH-X/blob/Staging/docs/icon-app.png)（MIT） |

## 许可

MIT，见 [LICENSE](LICENSE)。
