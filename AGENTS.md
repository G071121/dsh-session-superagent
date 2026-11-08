# AGENTS.md —— 给 AI 执行者的入口

> 人请读 [README](./README.md)。这份只回答两件事：
> **你现在该读哪一份**，以及**忘了哪一条会静默出错**。
>
> 形态参照 `MYCF711/magpie-plugin-scaffold` 的 AGENTS（定位表 + 坑表），
> 本地化成本仓库的真实命令与已经踩过的坑。

---

## 〇、UI 硬约束：原生 DSH 优先，最小自制

本项目所有页面、二三级界面、弹层、空态、表单和状态栏 UI，**默认采用 DSH 原生 UI 结构树、官方素材与设计语言**，不重新设计一套。

开工前必读：

1. `D:/DeepSeek Harness/home/DSH-UI-official.md` 与 `D:/DeepSeek Harness/home/dsh-ui-official/`（唯一结构树/素材主库）；
2. `docs/ui-decomp/01-dsh-ui-tree.md`、`docs/ui-decomp/03-gap-map.md`；
3. superagent 同源控件需要时读 `docs/ui-decomp/02-superagent-assets.md`。

执行顺序固定：**先查官方结构树和素材 → 能直接复用就直接复用 → 必须适配时只包一层 → 最后才允许最小 derived**。
官方已有的组件、DOM 结构、图标、颜色 token、弹层行为和交互方式不得手画替代；不得用截图猜层级，不得重复拆 asar。
只有官方确无同物时才可 derived，且必须在 `docs/ui-decomp/03-gap-map.md` 登记来源、理由、hash/版本与未验项。

验收不能只看“能渲染”：真实可编辑/可点击、键盘路径、焦点归还、深浅主题和窄屏都要验。测试桩通过不等于真机交互通过。

---

## 一、先定位你在哪一步

别从头读到尾。先看自己在哪一格，只读那一格指的文件。

| 你在做什么 | 必读（按顺序） | 做完的判据 |
|---|---|---|
| **刚接手**，只知道有这么一个插件 | [README](./README.md) → [MAINTENANCE](./MAINTENANCE.md) | 能说清「7 个工具各干什么」「服务端改动要重启才生效」 |
| **查现状 / 交接** | [MAINTENANCE](./MAINTENANCE.md) 的「二、当前状态」 | `git status` + `node --test` 复跑，数字与本文件对得上 |
| **改轮询 / 唤醒 / 水位逻辑** | [docs/01-架构.md](./docs/01-架构.md) → `lib/watch.js` → [docs/回归清单.md](./docs/回归清单.md) | `node --test` 全绿 + **至少加一条反向用例** |
| **改面板 / 弹层 / 状态栏 UI** | 本文件「〇、UI 硬约束」→ DSH 官方主库 → [docs/design-system.md](./docs/design-system.md) → [docs/面板文案.md](./docs/面板文案.md) | 原生结构/素材已复用 + `ui-audit` 100 分 + 深浅两套各一张图 + 文案快照已 `--write` |
| **改用户可见文案** | [docs/面板文案.md](./docs/面板文案.md) + `docs/kb/` 同类条目 | `render-panel-copy.mjs` / `first-run.mjs` 快照同步，preflight 绿 |
| **加文档 / 写知识库** | [docs/kb/README.md](./docs/kb/README.md) 的四段约定 | `check-docs` 四项 PASS（含**总数与板块合计一致**） |
| **发一个版本** | [UPDATING.md](./UPDATING.md) 全文 | 五处版本一致 + tag + Release（标题只写版本号）+ npm 已发布 |
| **用户报「不生效 / 看不到」** | [docs/真机验证清单.md](./docs/真机验证清单.md) → `watch_doctor` | 分清是「没重启」「样式没注入」还是「真的没数据」 |
| **处理外部 PR** | 本文件「三、处理外部 PR」 | 能复现 → 有测试 → 署名合入 → 关闭并回评 |

**最容易漏的是「发一个版本」和「改 UI」两行。** 两者的共同点：**代码改对了不等于用户看到了** ——
服务端要重启、样式表要注入、文案快照要重生成，缺一样，用户看到的就是旧界面。

---

## 二、十一条会静默出错的坑

「症状」列照着你看到的现象查；「判据」是正确做法；「出处」是完整论证。

| # | 症状（出问题时你看到什么） | 判据 | 出处 |
|---|---|---|---|
| 1 | 状态栏写「1 / 2 主理中」，点开面板却是 0 条 + 空态 + 「正在读取」 | 条件请求（304）**只有本地有可渲染 body 时**才能早退；否则清 etag 重取 | 0.9.167 |
| 2 | 会话正忙时开的 issue 再也不被处理，`cursor` 一直是 null | **ETag 只在真正消费这一轮之后前移**（无新增 / 仅观察记账后 / 唤醒发送成功后） | 0.9.168 |
| 3 | 每轮都报「返回内容不是合法 JSON：可能是代理干扰」，手工跑 `gh api` 却正常 | `--include` 的头体分隔**要认 CRLF**（真机是状态行 LF + 响应头 CRLF） | 0.9.167 |
| 4 | 弹层是一堆叠在一起的裸文字（没底色、没圆角、文字重影） | 样式表要在 `apply()` 注入一次，**弹层打开时再钉一遍**；别只挂在面板组件里 | 0.9.159–161 |
| 5 | 副行显示「76 秒前前」 | `ageText()` 自带「前」，拼接处不要再加 | 0.9.166 |
| 6 | 量行高量出奇怪数字（改完反而更高） | `querySelector` 取的是**第一个**匹配；要量「那一条」得指定 `nth-of-type` 或按下标取 | 0.9.151 |
| 7 | 门禁全绿，但功能是坏的 | **「包含某段文字」不算验证**：要严格相等，或断言结构（数量 / 连号 / 字段） | 0.9.167 |
| 8 | 某个主题下颜色不对 / 标签变成裸文字 | 只用 `--dsw-alias-*` token；`ui-audit` 的「写死颜色 / 自造 token」必须都是 0 | `docs/design-system.md` |
| 9 | 新增一个 `useState` 后一批用例同时红 | 面板 hook 队列按**位置**取值：只能在**末尾追加**，并同步 `deskQueue` / 预览 `deskHooks` | 0.9.157 |
| 10 | `git push --tags` 整批被拒（`already exists`） | 只推新建的那几个：`git push origin v0.9.x`；历史遗留同名 tag 会挡住整批 | 0.9.168 |
| 11 | 索引写「共 158 篇」，实际 176 篇没人发现 | 文档里的**总数**要与实际条目一致；`check-docs` 现在会拦 | 0.9.169 |

---

## 三、处理外部 PR

这个仓库是开源的，PR 会来自陌生人。规则四条：

1. **先复现，再合入** —— 作者说的根因要能在本地重现（写个十行探针即可）；
2. **对方的测试原样保留**，另补一条你自己的（防止只修了作者那一种输入）；
3. **署名 + 重编号** —— CHANGELOG 写明是谁的 PR、我改了什么、为什么改；
4. **有问题就不合** —— 把要改的点写成可直接抄的代码，让对方自己改（不代改、不关 PR）。

---

## 四、可以做 / 不可以做

**可以做**：读代码、跑 `node --test` 与全部门禁、改 `lib/` `test/` `client.js` `docs/`、在 issue 里讨论设计。

**不可以做**：关闭或重启宿主的 DSH；改用户 profile 的 `bundles`；提交 token / 私钥 / 本机绝对路径；
把没跑过的结论写成"通过"；代改别人的分支。

## 五、改动边界

| 目录 | 谁能动 |
|---|---|
| `lib/watch.js`、`lib/redact.js`、`lib/gh-format.js` | 纯函数，必须带测试 |
| `lib/index.js` | 插件装配与轮询主体，改动需说明影响面（可能要重启） |
| `client.js` | 面板 + 弹层 + 样式表，改完必须出图 |
| `cordis.patch.yml` | 改行 id 视为 major |
| 文档 | 跟随代码同步更新；**索引总数要跟着改** |

## 六、开发与验收

```sh
npm test                    # 全量单测（必须离线开关；裸 node --test 会真去 spawn gh）
node scripts/preflight.mjs  # 41 项门禁
node scripts/ui-audit.mjs   # UI 11 项
node scripts/render-preview.mjs preview.html
```

- 改 `client.js` 必须出图：`render-preview.mjs` 双主题；真实交互用 `scripts/verify-panel-chromium.mjs`（`ego-browser nodejs < ...`）。
- 新增 `useState` 只能在组件 hook 队列末尾追加，并同步 `deskQueue` / 预览 `deskHooks`。
- 改 UI 先读 `$DSH_HOME/DSH-UI-official.md` 与 `$DSH_HOME/dsh-ui-official/`；不要手画官方组件。
- 新增/删除文档后跑 `check-docs.mjs`；README 单测数由 `audit-readme-tests.mjs` 校验。

## 七、工具与 JSON 契约

- 工具输出默认文本；`format: 'json'` 返回 `{ schemaVersion: 1, ... }`。
- 字段稳定性见 `docs/json-契约.md` 与 `test/fixtures/contract-stability.json`；改字段两边一起改。
- 写操作必须 `confirm: true`；凭证只走 `gh` / Gitee token，不返回模型。

## 八、故障排查（agent 版）

- 面板空白 / 工具消失 / 路由 404：先看 profile 是否完整，`pnpm run sync:profile:check`；客户用 `dsh plugin ... add` 重装。
- 代码改了不生效：`file:` 硬链接可能断，`sync:profile:repair`；服务端改动要重载宿主。
- 轮询报 `inactive context`：旧实例未释放，重载宿主；不要用定时器直接读 `ctx.agents`。
- 会话已删除：`watch_status` 的 `lastError` 会写；不要盲目重建 watcher。
- 完整真机清单：`docs/真机验证清单.md`。

## 九、发布

`UPDATING.md` 是唯一流程：五处版本 + CHANGELOG + tag + `release-gh.mjs --latest` + npm；发布前 `preflight` 全绿。

## 十、当前基线

0.10.7；全量 **825/825**、preflight **41/41**、UI **11/11**、真实 Chromium **47/47**。
未验：真实 DSH WebView 重载后的读屏 / 触摸 / IME、真实 GitHub/Gitee 写操作。没有实测不得写成通过。

## 十一、Issue/PR 回复边界

评论只回答**当前 issue/PR 自身**：复现、根因、修复、验证、升级/回滚、需要对方补充的环境信息。

- 不写本机运行版本、后台任务、与当前条目无关的修复或发布计划。
- 客户不是 owner：不把 owner 本机状态写成客户状态，不替客户做决定，不承诺未发布版本。
- 编辑评论不撤回已发邮件；旧内容可能已被看到。发之前自检：「这条只属于当前 issue/PR 吗？」
