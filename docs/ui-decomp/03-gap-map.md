# 主理鱼 UI 复用差距地图（可执行清单）

> 结论：当前 `dt-*` 外观已经覆盖大部分页面，但仍有四类实质差距：**手写官方已有交互件、同一语义在不同页面使用不同 DOM、该用复合件时退回裸 `div`、局部硬编码颜色与层级**。优先级不是继续补样式，也不是增加 Tab，而是把表单、确认、时间线、浮层和空/错态收回同一套官方结构。
>
> 本文件只做静态只读核对与后续实施清单；本次没有改 `client.js`、没有启动 GUI、没有 commit。

## 实施回写（0.9.264）

本批已落地：官方 16×16 SVG path（含独立图元与 viewBox）、补 `chevron-up`、Trace/运行事件一事件一 `li.dt-event`、运行事件使用 `ol.dt-timeline`、删除不再叠加原生确认框、设置按钮直达对应分区、更新失败不再误报最新、诊断复制失败不再假报成功。

全量测试 **448/448**；差距地图其余大项转入派单表 L84，不在本批宣称完成。

## 实施回写（0.9.265）

ConfirmButton 已统一为「触发 → Modal → 取消/确认」，主面板与卫星环同组件；Modal 补 description/footer、onClose ref 与 busy 防重入。判定日志按日期分组为 `Section + ul.dt-list`，每条使用 DecisionLine 的 `li.dt-row.dt-link.dt-ticket`；Trace/运行事件继续保持 Timeline，不混用结构。

子代理定向 9/9 + 主线独立验收 2/2，全量 **459/459**，UI 体检 **11/11=100**；浅色不达标修正后 **15 组 ≤ 基线 16**。真实浏览器焦点走查仍列入未验项。

## 实施回写（0.9.266）

新增与行内编辑已共用 `WatcherForm`：统一 Field/Fields/Disclosure/SaveBar、数字 min/max、完整快照放弃恢复与 touched-only 保存。独立验收 8/8、定向 11/11、宿主适配层 8/8，全量 **486/486**，UI 体检 **11/11=100**；浅色 **15 组 ≤ 基线 16**、深色 **12 组 ≤ 基线 13**；窄屏 36 个 frame 无横向溢出。

## 实施回写（0.9.267）

修复 `.dt-open::after` 覆盖展开表单导致的“只能看不能改”：表单 z-index 提升，外壳改 `form.dt-card`；Chromium A/B 证实命中、焦点与键盘输入均恢复。主面板接入 DSH Modal/Toast，Tooltip 适配补 scroll-close；AGENTS 写入原生 DSH 优先、最小自制硬约束。全量 **500/500**，UI 体检 **11/11=100**。

## 实施回写（0.9.268）

InfoTip 已接 DSH Tooltip（scroll-close、aria 映射与独立回退）；StatusOrbit 已接 OrbitPopover（锚点、外点、portal、Escape），删除确认先关 orbit、独立 ConfirmDialog、回焦圆环。全量 **524/524**，UI 体检 **11/11=100**，对比度不高于基线；真实 WebView 行为仍单列未验。

## 实施回写（0.9.269）

Tooltip scroll-close 在独立模块与主面板同步保留 trigger 焦点，合并函数/对象 ref；Orbit 触发按钮删除全部 inline style，改官方 ghost 与 token。全量 **535/535**，UI 体检 **11/11=100**，浅色 16 组 ≤ 基线、深色 13 组 ≤ 基线。

## 实施回写（0.9.270）

真实 Chromium 验收 27/27；Orbit 修复 visible 后聚焦、outside/confirm 不抢焦点、Escape 回焦与 confirm reason 桥接。新增 cloneElement 防线；适配器同源审计 84 项。全量 **544/544**。未验真实 DSH WebView 的宿主 slot、读屏与 watcher 请求。

## 实施回写（0.9.271）

设置页可直接安装更新（受守卫 POST、固定 argv、并发/超时与 needsReload）；真实 Chromium 39/39，Toast/Modal/响应式/双主题全过。Orbit 窄屏先缩到视口减 16 再 clamp，320/360 均零溢出。全量 **570/570**。

## 实施回写（0.9.274）

更新链路严格审核六项修复落地：待重载不重复安装、close 前不解锁、Desktop CLI、POST 不重放、SemVer/installed、先脱敏再截断。完整面板真实 UMD 验收 23/23，全量 **593/593**。

## 实施回写（0.9.275）

全部 primary 委托官方 DSH Button；真实对比度 23/23，dark 18.0823/light 18.8965。更新失败 settle 后失效缓存、error 脱敏、busy 禁止 dismiss。全量 **600/600**。

## 实施回写（0.9.277）

官方支持的 `primary/ghost/outline/toolbar` 全部委托 DSH Button，link 保留回退；真实对比度 23/23。完整 desk+Orbit 双 root、Modal 焦点圈与 Escape 验收 34/34。全量 **602/602**。

## 实施回写（0.9.278）

主页面迁移官方 SegmentedTabs，补 tab/panel 关联与回退；Orbit 行头迁移官方 DisclosureRow，watcher 详情保留 derived。真实 Chromium 组合验收全 PASS，全量 **606/606**。

## 实施回写（0.9.279）

共享 Input 与 Toggle 分别迁移官方 Input/Switch，保留 id、受控草稿与回退。真实输入与开关交互通过，全量 **612/612**。

## 实施回写（0.9.280）

高级区补 aria-controls/body id；Tooltip scroll 回焦同步抑制重开并同步 client 内联。深层 Chromium 47/47，模块键盘路径 27/27，全量 **613/613**。

## 实施回写（0.9.281）

共享 Pill、Tag、StateDot 迁移官方组件，静态/交互与独立回退完整。真实 Chromium 47/47，全量 **622/622**。

## 实施回写（0.9.282）

CollapsibleList 接入官方 DisclosureRow；首败不再冒充空态，Orbit 区分读取失败；表单校验 reportValidity 并聚焦。全量 **630/630**。

## 实施回写（0.9.283）

凭证/goal 以草稿版本与保存序号防止旧响应覆盖；回读成功才 Toast，null 清干净草稿。专项 Chromium 52/52，全量 **637/637**。

## 实施回写（0.9.284）

Orbit 写操作 busy 锁、轮询代际和删除失败当前 Modal 可见。专项 Chromium 52/52，全量 **643/643**。

## 实施回写（0.9.285）

主面板 `/state` 带 sessionId，goal/title/usage 正确返回且空 session 不串数据。真实 Chromium 47/47，全量 **645/645**。

## 实施回写（0.9.286）

dirty 折叠/切换复用确认 Modal，取消/Escape 保留，确认才丢弃；真实 Chromium 54/54，全量 **648/648**。

## 实施回写（0.10.0）

11 项必须修 + 18 项值得改 + N1/N2/N3 全部收口；ETag 分 scope、保存不假失败、删除错误不残留，事件/焦点/fallback/heading/alert 统一。全量 **675/675**，Chromium **47/47**。

## 实施回写（Issue #35 · 确认层 portal 到 document.body）

**根因**：卫星环删除确认层用的是 superagent 同源回退 `Modal`（`dt-modal-root` + `position: fixed; inset: 0`），但它渲染在 `StatusOrbit` 的子树里；`composer.dock` 槽位的祖先带 `transform` / `contain: layout paint` / `overflow: hidden` 时，`fixed` 以该祖先为包含块并被裁剪 —— footer 的「取消 / 确认删除」既不在视口里，也点不到。

**修复**：回退 `Modal` 的根节点改由宿主模块加载器可用的 `require('react-dom').createPortal(root, document.body)` 渲染；拿不到 `createPortal` 或 `body` 不可挂载时仍内联（不另造第三套 Modal、不建第二个 React root）。宿主 `DSH Modal` 路径不变（主面板删除仍走 `PanelModal`）。键盘/焦点语义完全复用原实现，未改 `dt-modal-*` CSS。

**验收**：非浏览器结构断言（`createPortal` 的 `containerInfo === document.body`）+ 真实 Chromium 在 `transform + contain:layout paint + overflow:hidden` 的 340×96 窄 dock 里量几何与 `elementFromPoint`，并真实鼠标点「取消 / 确认删除」、Tab 圈、Escape 回焦；深浅主题 390 窄屏与 1440 各出图。证据目录默认是仓库内 `tmp-artifacts/issue-35/`（`tmp-*` 已被 `.gitignore` 覆盖；需要落别处时设 `DSH_ISSUE35_ARTIFACTS=<绝对路径>`，`--print-paths` 会打印 `issue35Artifacts` 与来源），产物为 `dock-confirm-geometry.json`、`chromium-after.log`、`issue35-dock-confirm-*.png`。

**未验**：真实 DSH WebView 里的 composer dock 祖先组合、读屏与触摸；Chromium fixture 的 dock 是等价构造，不是真宿主 CSS。

## 0. 基线、口径与复用边界

| 来源 | 本次核对基线 | 用法 |
|---|---|---|
| 主理鱼 | `client.js` 的 `CLIENT_VERSION=0.9.264`，共 2397 行；行号按本次工作树快照 | 所有未带路径的 `client.js:N` 都指这一快照；后续实施先重新定位，避免行号漂移 |
| 主理鱼既有文档 | `docs/design-system.md`、`docs/ui-inventory.md`、`docs/official-decomp/04-panel-tree.md` | 文档中“已对齐”的说法均再与当前源码核对，不直接照抄结论 |
| 官方 superagent | `/tmp/sa-off`，commit `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | 复用 `controls.tsx / widgets.tsx / rows.tsx / settings-kit.tsx / draft.tsx` 和 `client.css` 的 DOM、行为、CSS |
| DSH 安装版 | `0.2.1-rc.5`；主库登记的 asar SHA-256 为 `e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915` | 以 `D:/DeepSeek Harness/home/dsh-ui-official/` 为结构/素材主库；当前 Web 导出另核到 `@deepseek-ai/dsh-client-ui-primitives` 可由宿主 `require` |

### 0.1 三种“复用”不能混写

| 类型 | 可以直接拿什么 | 不能怎么拿 |
|---|---|---|
| **DSH 宿主原语** | `Modal / Toast / Tooltip / DisclosureRow / SegmentedTabs / Button / Tag / Pill / Input / Switch / StateDot`；当前安装版还导出 `InlineEditor / SettingsForm / SettingsValueField / SettingsSecretField / RiskConfirmation / MenuSurface / useAnchoredPosition / useDismissOnOutsidePointer` | 不再手写第三套焦点、定位、计时器；但先把 `require('@deepseek-ai/dsh-client-ui-primitives')` 在真实宿主做 smoke，再逐件替换，不能只凭同名改完全站 |
| **superagent 自包含复合件** | `Section / Hint / LabelValue / KeyValues / StageMark / ConfirmButton / Field / Fields / SaveBar / LoadState / ProblemLine / DecisionLine / TicketLine / Glossary / dt-timeline` 的源码结构与样式 | 这些件不依赖 DSH 私有包，适合移植；不要把 Ticket、Assignment、Provider 等领域对象一起搬来 |
| **主理鱼 derived（官方确无同物）** | 卫星环、watcher 状态映射、`Stat` 筛选、`HoursField`、仓库徽章、三步 Onboarding、版本诊断、AGENTS 规则建议 | 必须标 derived、继续用 `--dsw-alias-*`；不得把自绘结构称为“官方已有”，也不得为了凑官方而删掉真实能力 |

**混用规则**：一个组件要么走 DSH 的 CSS-module DOM，要么走 superagent 的 `dt-*` DOM；不要在同一件上拼一半 `dt-modal`、一半 DSH `Modal` 后假设原 CSS 仍生效。例如 DSH `Modal` 不会自动带 `.dt-modal`，术语表的宽类需要同步改成适配器自己的类。宿主原语不可用时，回退到 superagent 的同源移植件，不另造第三套。

### 0.2 官方对应件速查

| 需求 | 官方来源 |
|---|---|
| 普通控件、折叠、Modal、Tooltip | superagent `src/client/controls.tsx:54-249`；DSH `dsh-client-ui-primitives` |
| `Section / KeyValues / ConfirmButton / StageMark / LoadState` | superagent `src/client/widgets.tsx:24-43,75-89,104-116` |
| 总览问题行 | superagent `src/client/overview.tsx:11-59` 的 `ProblemLine`：`.dt-list.dt-cards > li.dt-row.dt-link.dt-att` |
| watcher 行 | superagent `src/client/rows.tsx:10-43` 的 `TicketLine`，只借两列行与动作结构 |
| 判定日志 | superagent `src/client/rows.tsx:78-101` 的 `DecisionLine`，不是把 Decision 硬塞进 Timeline |
| 编号追溯、运行事件 | superagent `src/client/thread.tsx:28-56,156-168`、`settings-kit.tsx:123-160`：一事件一 `li.dt-event` |
| 表单字段与高级折叠 | superagent `src/client/settings-kit.tsx:44-69`、`source.tsx:14-58` |
| 草稿保存 | superagent `src/client/draft.tsx:135-203` 的 `useDraft / SaveBar`；先做 dirty/busy/error/discard，服务端没有 revision 时不伪造 merge3 |
| 术语表 | superagent `src/client/app.tsx:27-55`：`Modal + table.dt-glossary + dt-legend + dt-values` |
| Toast | superagent `src/client/provider.tsx:65-70,82-107`；DSH `Toast` 另提供 portal、key 重挂载、动作和自动消退 |

## 1. 最高收益 5 项

| 排名 | 必改位置（`client.js`） | 直接复用什么 / 怎么改 | 可验收结果 |
|---|---|---|---|
| **1. 新增与行内编辑共用官方表单套件** | `1453-1501`、`1904-1923`、`1965-1977`、`2040-2046`、`2231-2236` | 抽一个 `WatcherForm`，用 superagent `Field / Fields / DisclosureRow / SaveBar`；`field()` 从外层 `<label>` 改为 `div.dt-field + label[htmlFor]`，高级项进 Disclosure；凭证和 goal 同样接 dirty/busy/error/discard。**不要用 DSH `InlineEditor` 替多字段 watcher 表单**，它只是单文本域 Enter/Escape 编辑器 | 新增/编辑同名字段 DOM 完全一致；干净时不显示 SaveBar，修改后出现；保存中 fieldset 禁用，放弃恢复原值；高级项默认收起；仍只提交 touched 字段；窄屏无横向滚动 |
| **2. 删除确认从二段按钮统一为同一 Modal 动线** | `443-514`、`822-839`、`890-893`、`1449-1452` | 当前两处都已用 `ConfirmBtn` 二段按钮（0.9.264 已去掉卫星环原生 `window.confirm`），仍不同于 superagent `ConfirmButton` 的“按钮 → Modal → footer 取消/确认”；用 DSH `Modal` 承载统一确认。普通删除不使用带勾选 acknowledgment 的 DSH `RiskConfirmation` | 主面板和卫星环都是“点删除一次 + Modal 确认一次”；取消/Escape/背板不发请求；busy 防重复；关闭后焦点回触发按钮；两处 DOM 相同；原生 confirm 保持为 0 |
| **3. 三类记录各回正确结构：DecisionLine 与两个 Timeline** | `984-1006`、`1714-1852` | **判定日志**改 superagent `DecisionLine` 的 `.dt-list > .dt-ticket`；**TraceTimeline** 已改为逐事件 `li`，但每个 trace 仍额外塞一个只有标题的伪事件 `li`，且时间未用 `When`；**运行时事件** 已是 Timeline，但 head 的相对时间与 footer 的 ISO 重复。抽共享 `TimelineEvent + When / Tag / KeyValues`，不要搬 DSH Trajectory 缩放图 | N 条真实 trace 事件=N 个事件 `li`，组标题不冒充事件；Trace/Runtime 时间都是 `<time>` 且不重复；判定行有状态列、标题、原因/编号、时间；日期分组不破坏列表语义 |
| **4. 浮层行为交给宿主原语，删除手写定位/计时逻辑** | `422-431`、`698-923`、`960-981` | `InfoTip` 用 DSH `Tooltip` 适配器；Toast 用带 `key` 的 DSH `Toast`；卫星环保留领域内容，但锚定、视口夹取、外部关闭优先复用 DSH `useAnchoredPosition / useDismissOnOutsidePointer`（API smoke 后接），非 Modal 弹层行为参照 superagent `SearchResults` | Tooltip 支持 hover/focus/touch/Escape，边缘不越界；连续两条 Toast 都重新出现且自动消退；弹层在 resize/scroll 后不飞出视口，Escape/外点关闭并还焦点；不再有任意超大 z-index |
| **5. 总览三类行收回官方复合结构** | `372-382`、`1326-1510`、`1652-1679` | “最近被过滤”改 Source 的 `DisclosureRow + dt-disclosure-body + dt-list`；“需要关注”改 `ProblemLine`；watcher 行固定声明 `TicketLine` 两列与直属 actions，删除 `rowBody.props.children` 改写，并共享 `StageMark/watcherMark` | 折叠项含 repo/编号/原因/时间；问题有现象/原因/修复动作；动作不被 meta 裁切；主面板与弹层同状态同 tone；不再运行时修改 React element props |

## 2. 全局壳与共享组件

| 区域 | 当前 DOM / 组件 | 官方对应件 | 应该直接复用什么 | 需要改哪一行 / 哪一段 | 验收方式 |
|---|---|---|---|---|---|
| 页面壳 | `div.dt-page` 直接放 head、Tabs、banner、页面数组（`2238-2300`）；另在 `PORTED_CSS` 加 `.dt-page > * + *` 补间距 | superagent `app.tsx:161-168`：`.dt-page > .dt-column > Header + Tabs + main.dt-main[role=tabpanel]` | 官方壳 DOM 和 `.dt-main` 间距，不要靠全局相邻选择器补救 | `2238-2300` 增加 `.dt-column` 与唯一 `main#dt-page`；`client.js:120` 删除自加的相邻 margin 规则后再验间距 | 4 个页签都在同一 `main[role=tabpanel]` 内切换；`aria-labelledby` 指向当前 tab；无双份 margin、无横向滚动 |
| 一级 Tabs | 自写 `SegTabs`（`254-282`），调用只给 value/label（`2271-2279`）；缺 tab id、`aria-controls`、溢出 `data-more` | superagent `SegmentedTabs`（`controls.tsx:72-112`）；DSH 同名原语 | 优先补全 superagent 版本的 id/panelId、ResizeObserver、键盘焦点跟随；如换 DSH 版需单独做视觉验收 | `254-282`、`2271-2279`；只改实现，**items 仍是总览/判定/触发/设置四项** | ←/→/Home/End 循环且焦点不丢；当前 tab 与 panel 关联；窄屏可横滚并显示正确渐隐；数量恒为 4 |
| Section | `div.dt-section-title`；`hint` 另起一段 `Hint`（`332-343`） | superagent `Section` 是 `h2.dt-section-title`，hint 为标题内 `InfoTip`，action 右置（`widgets.tsx:24-35`） | 官方 Section DOM；`subtitle` 是主理鱼扩展，可保留为独立说明 | `332-343`；不要同时把 hint 在标题和正文各渲染一次 | 每 Section 只有一个 h2；action 在右侧；InfoTip 键盘可达；“需要关注”的两种 count 口径仍可读 |
| Disclosure 图标 | 0.9.264 已补 16×16 derived `chevron-up`（`188-189`），不会再回退 question；但 filtered 仍用 question 作 lead（`372-382`） | superagent 的 up/down chevron 与 Source filtered 的 `filter` 图标 | 保留已补 chevron；只把 filtered 的领域图标换成官方 `filter`，不再重复造箭头 | `377` 把 question 改 filter；`183-228` 的现有箭头不动 | 展开/收起方向正确；filtered 一眼可识别为过滤区；图标 viewBox 与来源保持一致 |
| 状态映射 | 卫星环与主面板分别写 tone 三元式（`868-877`、`1304-1328`），paused 在两处是 neutral/warning 两色 | superagent `marks.ts` 集中映射领域状态到 label/tone/dot/icon | 建一个 `watcherMark(state)`，供 StageMark、Tag、Dot 共用；语义是否 paused=warning 只定一次 | `868-877`、`1304-1328`、`1507-1508` | 同一 watcher 在主面板和弹层的 label/tone/dot 一致；active/paused/error/dormant 四态各有断言 |
| KeyValues | `dl.dt-kv` 直接平铺 dt/dd（`435-441`） | superagent `widgets.tsx:40-43` 每行一个 `div[style=display:contents]` | 官方 `KeyValues` 行包装；事实表继续用它，事件列表不要用它 | `435-441` | 每行 key/value 对齐；窄屏仍按官方 container query 变单列；无重复 React key |
| 未使用旧样式与控件 | `S` 整套旧 inline 样式（`94-114`）、`BORDER`（`698`）无引用；`SegmentedControl`（`392-401`）也无调用，且键盘/DOM 与官方不同 | 官方已有完整控件，死代码不是“已完成复用” | 删除死代码；将来真需要互斥选择时再接官方 SegmentedControl | `94-114`、`392-401`、`698`；先用引用搜索复核再删 | 构建无未定义引用；静态扫描无这些旧 rgba 样式；不把“文件里有组件名”当作页面已使用 |
| CSS 硬编码 | `client.js:120` 的 `.dt-btn-primary` 使用 `color-mix(... #ffffff)`；`806` open 背景为 `rgba(128,128,128,.16)`；`905` z-index 为 `2147483000` | 官方按钮 `var(--dsw-alias-label-primary-foreground)`；交互态与浮层层级由宿主原语/token 管理 | 恢复原 token；open 用 `interactive-bg-active` 或 ghost-active token；层级交给原语 | `120`、`793-809`、`903-906`；官方 mask 里的 `#000` 不算业务硬编码，不误删 | 扫描业务 CSS 无 `#ffffff/rgba(...)` 残值；双主题对比度达标；Modal/Toast/popover 层级正确且无任意极大值 |

## 3. 总览

| 分区 | 当前 DOM / 组件 | 官方对应件 | 应该直接复用什么 | 需要改哪一行 / 哪一段 | 验收方式 |
|---|---|---|---|---|---|
| 统计与筛选 | 自定义 `Stat`，可点统计是 `button.dt-stat-btn`，单位是 `dt-stat-unit`（`319-329,1624-1651`） | superagent `overview.tsx:66-70` 的 `.dt-stat / .dt-stat-label / .dt-stat-value`，可点值用 `.dt-textlink` | `dt-stats` 和数值样式直接保留；交互筛选属于 derived，不必为了同名强行删除 | `319-329` 可将 unit 对齐官方 label；保留 `aria-pressed`，不要把筛选改成无状态链接 | 四态计数之和等于 watcher 总数；点击/再点击筛选正确；按钮有 pressed 状态； dock 与总览仍共用同一 Stat |
| 最近被过滤 | `CollapsibleList` 把所有 watcher 的记录压成字符串列表，无 repo/time，展开内容没有 `.dt-disclosure-body`（`372-382,1652-1658`） | superagent `source.tsx:125-135` 的 filtered `DisclosureRow + dt-disclosure-body + ul.dt-list + Dot + dt-row-main` | 整个 filtered Disclosure 结构；每项保留结构化 entry，不先拼字符串 | `372-382` 改为接收结构化 entries；`1652-1658` 传 repo/number/title/reason/at；`377` 把 question 改成 filter 图标 | 展开每条能看到仓库、编号、标题、原因、时间；Enter/Space 可开合；多条 watcher 不串仓库；折叠摘要不超过一行 |
| 需要关注 | `ul.dt-plain-list > li.dt-danger`，动作是自定义 `Btn variant=link`（`1674-1679`） | superagent `ProblemLine`：`ul.dt-list.dt-cards > li.dt-row.dt-link.dt-att(.dt-att-error)`，动作用 `.dt-row-buttons` | `ProblemLine` 行结构、warning/error 边条和标准 outline Button | `1674-1679`；把 item.kind 映射到官方 att/error 类，不要给全部问题一律同一红色 | 每个问题有“现象/原因/下一步”；动作可点且不触发整行；kind 与颜色一致；去重和排序结果不变 |
| watcher 行 | 已是 `.dt-ticket`，但通过读写 `rowBody.props.children` 把 actions 移进 `dt-ticket-meta`（`1485-1501`）；StageMark 又是另一份手写 span（`1507-1508`） | superagent `TicketLine` 的固定两列、`StageMark`、body 直属 `dt-ticket-actions` | 固定声明式行结构、`StageMark`、共享 watcherMark；不要运行时改 React element props | `1326-1510`，重点删除 `1485-1501`；actions 作为 body 直属子节点，编辑区仍是另一直属节点 | DOM 不再依赖 props 内部形状；窄屏动作不被 `.dt-ticket-meta{overflow:hidden}` 裁掉；标题点击与动作点击不互相穿透 |
| 等待首次唤醒 | 在主页面复用卫星环页脚 `.sa-dock-foot`（`1681-1687`） | superagent 状态说明用 `Hint`，需要强调的进行中状态用 `.dt-banner` | 主页面只用一个 `.dt-banner`，不要借弹层 footer 类 | `1681-1687` | computed style 不再出现 dock 的 border-top/padding；只在没有过唤醒时出现；文案与试跑入口保留 |
| 按仓库汇总 | `div.dt-rows > div.dt-row`，指标全为裸 span（`1854-1902`） | superagent 通用列表 `ul.dt-list > li.dt-row > Dot + dt-row-main`；指标用 `LabelValue` | 通用 list 与 `LabelValue`；`dt-rows` 留给官方 RowsField，不当万能列表 | `1856-1902` | 每组是语义列表项；label/value 层次一致；仓库名过滤仍有效；空筛选有清除动作 |
| 问题修复去向 | 0.9.264 已有 `openSettings(section)`，token→creds、诊断→diagnose、升级→update（`1070-1073,1421-1431,2282-2286`） | superagent `settingsRoute(group)` 的同时定位 Tab 与分区语义 | **已对齐，保留现状**，不要再退回单独 `setTab('settings')` | 只回归 `1070-1073` 及三个调用点，无需重写 | 从任意设置分区触发后都落在按钮所称分区；升级入口使用 button，不再使用 `a[href="#"]` |
| 首次 Onboarding | `dt-card.sa-onboarding + ol.dt-steps`（`349-369,1695-1700`） | 官方只有 `Hint` 空态，没有三步向导同物 | 保留 derived；复用 `dt-card / Btn / Hint`，不添加插画或新 Tab | 仅随 LoadState 修正渲染条件；真实 `watchers.length===0` 且无读取错误时才显示 | 真空显示三步；断网、读取中、404 不显示；点击只切到现有“触发”页 |

## 4. 判定（含刚加的 TraceTimeline）

| 分区 | 当前 DOM / 组件 | 官方对应件 | 应该直接复用什么 | 需要改哪一行 / 哪一段 | 验收方式 |
|---|---|---|---|---|---|
| 追溯入口 | `Section` 里放 `div.dt-row-meta + button.dt-textlink`，结果直接挂后面（`1714-1745`） | superagent Eval 的 `.dt-filters` 与 Thread 深链；加载/错误用 `LoadState` | 保留“顶部搜索编号 → 当前判定页追溯”的轻动线；筛选行用 `.dt-filters`，结果状态用 LoadState | `1714-1745`；不新增详情 Tab，不强制改整页路由 | GitHub 数字和 Gitee 字符串编号都可追溯；重复点击不会旧响应盖新响应；按钮名与查询仓库范围一致 |
| **TraceTimeline** | 0.9.264 已是一事件一 `li.dt-event`，但每个 trace 还多一个只有标题的 head `li`，时间仍原样输出 ISO（`984-1006`） | `Thread TriggerItem` 与 `ConfigHistory`：事件 `li` 有 actor/time/正文/footer；组标题不属于事件；`When` 输出 `<time>` | 保留逐事件改进，抽出组级 repo/number/verdict 标题，复用 `When / Tag`；不要回退成一个 trace 一个事件 | 调整 `989-1005`：trace 组标题移出事件 `li`，事件继续 `flatMap`；保留现有时间排序和 traces 数据契约 | N 个真实事件=N 个事件 li，不多出 head 伪事件；filtered/absorbed/wake/seen/reported 不错乱；同编号多仓库仍分组；每项时间是 `<time datetime>`；无事件走 Hint |
| 判定日志 | 当前已是 `ol.dt-timeline`，`eventRow` 只有 repo/time 与结果/编号（`1783-1829`） | 官方 Eval 的真正对应是 `DecisionLine`（`rows.tsx:78-101`），不是 Timeline | `ul.dt-list > li.dt-row.dt-ticket + StageMark + title/quote/meta`；日期分组如需保留，用分组 Section 包多个 ul | `1783-1829`；把 `eventRow` 改 DecisionLine，不再复用 Trace 的 Timeline | 每条判定能看到结果、仓库、编号、原因和时间；没有 `li.dt-timeline-day` 与事件混作同类；跳过原因不会被quiet样式淡到不可读 |
| 暂停/跳过筛选 | 两个 `div.dt-row-meta` 放 Pill，命中条目为 `ul.dt-plain-list`（`1746-1775`） | 官方 Eval 的 `.dt-filters + Pill`；filtered 明细可复用 Source filtered 行 | 筛选条统一 `.dt-filters`；命中明细复用结构化行 | `1746-1775` | 两类筛选都可键盘操作、当前条件明确、可一键清除；筛选后计数与列表一致；条目含 repo/number/reason/at |
| 运行时事件 | 0.9.264 已是 `ol.dt-timeline > li.dt-event`，但 head 同时放 `ageText`，footer 又放原 ISO（`1831-1852`） | superagent Thread Timeline / ConfigHistory 的 `When` 与统一事件层次 | 与 Trace 共用 `TimelineEvent + When`；保留 Tag、repo/text 和持续时长，不再重复两套时间 | `1840-1852` 收敛时间显示；保持“判定结果”和“运行事件”两个 Section | 每项只有一个 `<time>`；count>1 的持续时长保留；事件顺序与当前一致；两个 Section 标题不合并 |
| 空/加载/错误 | Trace 用普通 p；判定空态是自写 `dt-empty`（`985-988,1776-1782`） | `LoadState / Hint`；主理鱼 CTA 空态可作 derived 扩展 | Trace 错误用 `LoadState`（错误自身 `role=alert`）+ 重试，空态用 Hint；判定空态抽共享 EmptyState | `985-988`、`1776-1782` | 失败可重试且不显示“没有结果”；加载不闪烁旧结果；真正无记录才显示“去添加第一条” |

## 5. 触发与行内编辑器

| 分区 | 当前 DOM / 组件 | 官方对应件 | 应该直接复用什么 | 需要改哪一行 / 哪一段 | 验收方式 |
|---|---|---|---|---|---|
| 新增表单 | `Section > div.dt-form` 全字段平铺，底部普通 actions（`1904-1923`） | `SourceCard`：`form.dt-card > Fields + 高级 Disclosure + SaveBar` | 官方 form/fieldset 语义、Field、Disclosure、SaveBar；新增时 SaveBar 的主动作可命名为“添加” | `1904-1923` 与 `2231-2236`；基础字段保留，限额/隔离等高级项默认折叠 | 表单可 native submit；必填/数值约束生效；高级字段折叠后首屏明显缩短；添加成功后只重置既定字段 |
| 行内编辑器 | `div.dt-fieldset` 而不是 fieldset，所有字段平铺，保存/放弃永远显示（`1453-1482`） | 与新增同一个 `WatcherForm`；`Fields(disabled=busy)` 与 `SaveBar` | 复用同一字段 schema 和组件，不复制第二套；保留行内展开，不改官方整页详情 | `1453-1482`、`1904-1923`；不要在两个调用点分别修字段 | 新增/编辑的 label/hint/note/control 顺序一致；保存中禁用；放弃恢复打开时快照；编辑不增加路由或 Tab |
| 字段可访问性 | `field()` 返回 `<label>`，内部还嵌 InfoTip button、HoursField buttons（`2231-2236`） | superagent `Field`：`div.dt-field + useId + label[htmlFor]`（`settings-kit.tsx:56-63`） | 官方 Field；Switch 另用官方 `SwitchRow` 的 div 结构 | `2231-2236`，以及 `1463-1475,1915-1917` 的 switch 行 | 每个 input 有唯一 id，label 点击聚焦正确控件；label 内无交互按钮嵌套；InfoTip 不意外聚焦输入 |
| 数字字段 | 多数限额只是默认 text input，范围只写 placeholder（如 `1465-1467,1907-1910`） | `SourceField(type=number)`：`type=number/min/max/required`（`settings-kit.tsx:253-256`） | 官方数字 Input 属性与 `numberOf` 的空值语义 | 所有 interval/batch/maxWakes/keepDays/maxIsolated 字段；不要在 UI 把空值偷偷变 0 | min/max 原生校验有效；空 optional 字段保持空；非法值不能保存；键盘与读屏能读出数值类型 |
| 高级隔离字段 | isolated 切换后才插入三个字段，全部与基础字段同层（`1474-1478,1917-1920`） | `SourceCard` 的高级 `DisclosureRow(icon=settings)` | 高级 Disclosure + `.dt-disclosure-body`；`HoursField` 是 derived 复合 Field，可保留 | `1474-1478`、`1917-1920` | 默认收起；开启 isolated 后展开区字段完整；关闭 isolated 不静默提交未触字段；跨夜提示仍准确 |
| DSH InlineEditor 边界 | 当前 watcher 是多字段行内表单 | DSH `InlineEditor` 只有 value/label/onChange/onSave/onCancel 的自动增高 textarea | **本处不直接复用**；只有未来做单条 goal 的快速文本编辑且明确需要 Enter 保存时才评估 | 不改 `1453-1482` 为 InlineEditor | 验收清单必须防止“为了用官方件而丢掉过滤、限额、隔离字段” |

## 6. 设置总壳与各分区

| 分区 | 当前 DOM / 组件 | 官方对应件 | 应该直接复用什么 | 需要改哪一行 / 哪一段 | 验收方式 |
|---|---|---|---|---|---|
| 设置总壳 | `.dt-settings > nav + dt-settings-body`，按数组下标取 Section（`1932-2071`）；右栏没有独立 `h2.dt-settings-title` | superagent `settings.tsx:26-37` 同壳，右栏先有分组 h2，再渲染内容 | 左 nav + 右 body 保持不变；补官方分组标题层，Section 作为内容，不重复两个标题 | `2050-2071`；每分区只保留一个可见 h2，标题与 nav 文案一致 | 五个分区仍是来源/凭证/版本与更新/分诊信号/会话 goal；右栏始终随 nav 切换；窄屏 nav 横排无溢出 |
| 来源 | 已用 `KeyValues` 展示仓库/gh/token/scope/隔离（`1933-1964`）；错误长文都在普通 dd | 官方 `KeyValues` + Source problem 的可修复错误行 | 保留事实表；错误用 `dt-error` 与去 creds 的动作，不再只写一句指引 | `1933-1964`；`435-441` 同步官方 KeyValues | 三态 gh（可用/不可用/不需要）不互相误报；scope 错误可见；点击修复准确落 creds；长路径/错误不撑破 grid |
| 凭证 | `KeyValues + 三个自写 field + 永久保存按钮`（`1965-1977`） | superagent `Field/SaveBar`；DSH 另有 `SettingsSecretField` 的密码字段与 configured 状态 | token/Gitee 可用 DSH `SettingsSecretField` 做展示层；ghDir 用 Field；保存接现有 `/credentials`，不要硬套 DSH `SettingsFormModel` | `1965-1977`；加块级 dirty/busy/error/discard；解绑仍是显式独立动作 | secret 永不回显；留空不改；只改 token 不清 ghDir；解绑需明确动作；干净时无保存条，失败保留输入 |
| 版本与更新 | 0.9.264 已在 error 时显示“检查失败”，初始/手动共用 `checkUpdate`，诊断复制失败也会 error Toast 并 return（`1978-2025,2073-2088`） | 官方 `KeyValues / Hint / LoadState` 的真实错误语义 | **错误处理已对齐，保留现状**；`KeyValues + code + Btn` 结构也不需重画 | 只保留回归，不再把这三处列为待改 | error 不误报最新；初始失败可重试；复制失败不假报成功；升级命令只在 hasUpdate 时出现 |
| 分诊信号 | `div.dt-rows/div.dt-row + 自定义 dt-signal-* grid`（`2026-2038`） | 官方同类“名称/属性/数值/说明”事实矩阵用 `table.dt-table`；普通列表才用 dt-list | `table.dt-table` 直接替换；删除 `client.js:120` 的 `dt-signal-*` 补丁 | `2026-2038` 与 `120`；列建议为信号/类型/默认/权重/说明 | 表头与单元格语义可读；权重等宽右对齐；事实/判断仍用 Tag；窄屏可换行或滚动但不撑破页面 |
| 会话 goal | 裸 `textarea.dt-textarea + 永久保存按钮`（`2040-2046`） | superagent `Field + SaveBar`；不是官方 Prompt 编辑器 | 保留单个 goal 文本域，接 dirty/busy/error/discard；不要搬 Prompt edit/full/history | `2040-2046` | 未修改无 SaveBar；服务端值回读不覆盖 touched 草稿；保存/放弃/失败反馈正确；无 sessionId 时明确禁用原因 |
| 不兼容的 DSH SettingsForm | 当前是 `/watch /credentials /goal` 自定义 API | DSH `SettingsFormModel` 面向 ConfigForm scope + set/unset path ops + revision | 只复用展示控件和 superagent 草稿状态机；没有对应 scope/revision 时不直接套 SettingsFormModel | 不在本批强行改 `1147-1289` 的 API 契约 | 不出现“UI 假报 merged/saved”的情况；保存仍走真实 API；将来有 revision 再评估 merge3 |

## 7. 卫星环弹层

| 分区 | 当前 DOM / 组件 | 官方对应件 | 应该直接复用什么 | 需要改哪一行 / 哪一段 | 验收方式 |
|---|---|---|---|---|---|
| 圆环本身 | 自绘 SVG 轨道与卫星，16×16，含 reduced-motion（`543-645`） | 官方没有卫星环；Composer dock 有 20px 高、12px 字的状态 pill 规范 | 保留 derived SVG、动画和四态；按钮 20px 高与 dock 对齐，颜色继续用 token | 只把 `793-809` inline 视觉移到 `DOCK_CSS` 的专用类，open 色改 token；不改轨道算法 | 0/1/6+ watchers、active/paused/error/dormant 均正确；减少动态效果生效；按钮 aria-label/expanded 完整 |
| 弹层定位 | 手算 left/bottom/width，fixed + 任意 z-index（`698,784-820,903-906`） | DSH `useAnchoredPosition / useDismissOnOutsidePointer / MenuSurface`；superagent SearchResults 的非 Modal 关闭模式 | 复用锚定、视口夹取和外部 dismiss；宽 368/空态 252 是 derived，可保留并夹视口 | `698-923`；API smoke 后接 hook，不自创另一套定位常量 | 上下空间不足时位置合理；窗口缩放/滚动不越界；外点/Escape 关闭；焦点回圆环；不裁在 composer 容器内 |
| 行结构 | 手写 `.sa-dock-row`，状态点是裸 `span.dt-state-dot`，tone 另算（`868-893`） | superagent `Dot / Tag / Btn`；共享 marks 思路 | 保留紧凑两行摘要，状态改用 `Dot` 与 watcherMark；动作复用 Btn | `868-893` | 与主面板同状态同语义；错误不被单行 ellipsis 完全吞掉，至少可聚焦看全文；触摸设备动作可见 |
| 删除与 busy | 删除仍是 ConfirmBtn 二段按钮；写操作没有按钮级 busy（`822-839,886-893`） | 官方 ConfirmButton + useAction | 同 ROI-2 统一 Modal；act 用每行 busy 防重入 | `822-839`、`886-893` | 连续点击只发一次；成功刷新；失败在行/弹层可见；取消不发请求 |
| 空态与读取错误 | 首次读取 catch 把 null 改 []，于是显示“还没有主理鱼”（`730-737,773-782,912-914`） | 官方 `LoadState / Hint`，错误不伪装空态 | null=未知/加载，[]=真空，error=失败三态分开；空文案用 Hint 包装，错误用 `p.dt-error[role=alert]` | `730-737`、`773-782`、`912-914` | 首次断网不显示“还没有”；已有列表时读取失败保留旧列表并提示；真正空列表才有添加指引；错误提供重试 |
| 页脚 | `.sa-dock-foot` 只用于弹层底部说明（`917-919`） | 官方无同物，derived | 保留，但不得再拿它做主页面等待卡 | 只改总览 `1681-1687`，本处不动 | 弹层页脚与主页面 banner 不再共用类 |

## 8. 确认弹层与 AGENTS 建议弹层

| 弹层 | 当前 DOM / 组件 | 官方对应件 | 应该直接复用什么 | 需要改哪一行 / 哪一段 | 验收方式 |
|---|---|---|---|---|---|
| 通用 Modal | 自写 root/mask/dialog 留在面板 DOM 内；**Issue #35 起回退 Modal 也 portal 到 `document.body`**（`createPortal`）；标题是 span；effect 依赖 inline `onClose`（`443-496`） | superagent `Modal` 与 DSH `Modal`：body portal、h2、description/footer、`onClose` ref、焦点圈与归还 | 优先 DSH Modal；若保留 superagent 版，至少补 portal、`onClose` ref 和 h2 | `443-496`；调用点 `2301-2340` 同步 description/footer | 5 秒轮询时焦点不被重置；Tab 圈在 dialog 内；Escape/背板关闭； opener 还焦点；Portal 到 body |
| 删除确认 | 两个入口均为 `ConfirmBtn` 二段按钮，不是 Modal；0.9.264 已移除卫星环原生 confirm（`498-514,822-839`） | superagent `ConfirmButton` footer 两键 | 同 ROI-2；普通删除不使用 RiskConfirmation | `498-514`、`822-839` 与两个调用点 | 两个入口同 Modal DOM、同文案、同 busy；原生 `window.confirm` 调用数保持为 0 |
| AGENTS 建议 | Modal body 中放说明、pre、复制/关闭 actions（`2301-2321`） | DSH/superagent `Modal(description, footer)`；superagent `dt-pre` | 保留主理鱼规则内容，说明移 description，按钮移 footer，代码块仍 `dt-pre` | `2301-2321` | 长规则在 body 内滚动；footer 不随代码滚走；复制成功/失败各有 Toast；关闭焦点回“看建议规则” |

## 9. 术语表

| 分区 | 当前 DOM / 组件 | 官方对应件 | 应该直接复用什么 | 需要改哪一行 / 哪一段 | 验收方式 |
|---|---|---|---|---|---|
| 术语表 Modal | 普通宽 Modal + `KeyValues` 平铺 16 项（`2322-2340`） | superagent `Glossary`：`Modal(className=dt-glossary-modal) + table.dt-glossary + dt-legend + dt-values`（`app.tsx:27-55`） | 直接移植 Glossary DOM 与 CSS；术语仍只放主理鱼真实概念，可分“绑定/判定/执行/凭证”组 | `2322-2340`；若用 DSH Modal，把宽度类改为其 className 可命中的适配类，不能依赖 `.dt-modal.dt-glossary-modal` | 宽度约 680 且不超视口；表格有表头/分组；body 可滚动；状态 legend 使用 Dot；无 Ticket/Assignment 等主理鱼没有的术语 |
| 状态与枚举速查 | 当前缺 | 官方 `dt-legend`（done/ongoing/warning/error/idle）和 `dt-values` | 只增加主理鱼已有的 active/paused/error/dormant 映射及 observe/isolated 等真实枚举 | 同 `2322-2340`；不为凑官方增加虚假状态 | legend 与 watcherMark 完全一致；点击关闭、Escape、键盘焦点均正确 |

## 10. Toast 与即时反馈

| 分区 | 当前 DOM / 组件 | 官方对应件 | 应该直接复用什么 | 需要改哪一行 / 哪一段 | 验收方式 |
|---|---|---|---|---|---|
| Toast 本体 | `useToast` 在面板内渲染 `div.dt-toast`；item.id 未作为 key；错误另加红左边（`960-981`） | superagent `Toast` portal + `key=toast.id`；DSH `Toast` 另有 icon/tone/actions/onDone | DSH `Toast` 或完整 superagent Toast；保留“同时只有最新一条”；错误 icon 用官方 alert，不自造第三种皮肤 | `960-981`、`1036`、`2287`；成功/错误不要共用含混 tone | 连续 notify 两次，第二条也完整播放动画并消退；位置顶部居中；portal 到 body；不抢焦点；双主题文字清晰 |
| 重要结果与轻反馈 | `run` 同时 `notice` 和 error Toast（`1124-1144`），保存成功只有 Toast | 官方模式：重要错误留在对应 Section，Toast 给轻确认；`ui-inventory.md` 已作此取舍 | 保留 notice/banner，避免同一句错误在两个位置重复；成功 Toast 不变 | `1124-1144`、`2280` | 错误在切到相关分区后仍可找到；不出现同文 banner+Toast 双闪；保存/复制等轻确认仍即时可见 |
| 剪贴板反馈 | 0.9.264 三处均为 await + 错误 Toast；诊断复制失败已 return（升级 `1984-2001`、诊断 `2006-2025`、规则 `2301-2321`） | DSH/superagent 的 await 后 notify、失败给错误反馈 | **行为已对齐，保留三个调用点**；是否再抽 helper 只是可选去重，不算复用差距 | 不需要为本项改代码 | 禁止剪贴板时三处都不显示“已复制”；成功消息带真实行数；失败保留可选中文本 |

## 11. 空态、加载态、错误态总表

| 场景 | 当前实现与位置 | 差距 | 需要改哪一行 / 哪一段 | 验收方式 |
|---|---|---|---|---|
| 主面板首次加载 | `snap.loading && !snap.body` 才 Hint（`2294`） | 基本符合官方 LoadState，但和后续空态要互斥 | `2294-2300` 增加明确的 `!snap.body` 分支 | 加载中只有加载提示，没有 Onboarding/空列表；拿到 body 后一次性替换 |
| 主面板首次失败 | error 卡存在，但 `body={}` 仍驱动 overview 渲染 Onboarding（`2288-2300`） | **错误被同时说成零配置** | 无 body + error 只渲染错误卡与重试，不渲染四个页面内容 | 断网首访只有“读不到面板数据”；没有“三步添加”；恢复后正常显示 |
| 主面板 stale 数据失败 | `setSnap` 保留 prev.body（`1092-1106`） | 方向正确，符合官方保留最后成功数据 | 保留 `1092-1106`；只修顶部错误 `role=alert` 与内容互斥条件 | 旧数据继续可见，顶部说明可能过期；重试成功清错误，不清空列表 |
| 卫星环首次失败 | catch 把 null 改 []（`730-737`） | **错误被说成没有 watcher** | `730-737,773-782,912-914` 三态分离 | null/[]/error 三态各自文案正确；不错误显示灰环“还没有” |
| 总览筛选无结果 | `visible.length===0` 固定写“没有匹配「search」”（`1698-1699`）；按仓库另有通用提示（`1886`） | 非搜索筛选时可能出现空引号，且没有统一清除动作 | 抽 `FilteredEmpty`，根据 search/badge/state/problems/defer 生成原因，给“全部清除” | 每种筛选单独或叠加时文案准确；一键清空后列表恢复；真正零 watcher 仍走 Onboarding |
| 判定空态 | 自写 `dt-empty` + CTA（`1776-1782`） | 可保留 CTA，但应与总览/弹层共享空态原语 | 抽 `EmptyState(title, hint, action)`，内部用 `dt-empty/Hint/Btn` | 三种空态结构一致；无记录才出现； action 只去现有触发页 |
| Trace 空/错/加载 | 三个普通 p（`985-988`） | 错误无 role/重试，失败与无结果视觉区分不足 | 用 `LoadState` + retry + Hint | 失败可重试；空结果不显示错误色；加载时不清掉输入编号 |
| 运行时事件空态 | `Hint`（`1838-1839`） | 已符合官方，不需要改结构 | 保留，仅随 Timeline 调整容器 | 空时不渲染空 `ol`；添加后事件正常出现 |
| 更新检查错误 | 0.9.264 已修：状态显式分支出错，初始调用 `checkUpdate(false)`（`1979-1983,2073-2088`） | 已对齐，不再有待改差距 | 保留现状并加入回归，不重复实施 | 首次/手动失败均显示检查失败+重试；成功后才判断 hasUpdate |
| 凭证/goal 保存错误 | 全局 notice + Toast（`1124-1144`） | 有反馈但不是块级草稿错误，切分区后上下文弱 | 随 SaveBar 将错误留在 creds/goal 所在块；全局 Toast 只作补充或去掉重复 | 错误块保留输入和重试入口；切分区再回来仍能看到；成功后错误清除 |

## 12. 明确不该动的部分

| 不该动 | 原因与允许改的边界 |
|---|---|
| **4 个一级页签：总览 / 判定 / 触发 / 设置** | 用户任务对象未变；不得为对齐官方增加 Source/Execution/Provider/Ticket/Versions/Search Tab。只能改 `2271-2279` 的组件实现，不改 items 数量和顺序 |
| **设置的 5 个现有分区** | 来源、凭证、版本与更新、分诊信号、会话 goal 都是真实主理鱼配置；不要把 DSH 的 5 sections 或 superagent 的 5 groups 原名照搬过来 |
| **卫星环领域模型与轨道视觉** | 官方没有同物；watcher 四态、卫星数量、reduced-motion、20px dock 入口是有效 derived。只换弹层定位、dismiss、token、确认和共享状态映射 |
| **watcher 行内展开的轻动线** | 官方 Ticket 是整页详情，但主理鱼既有文档已明确保留行内编辑；只统一表单/动作 DOM，不强制改路由 |
| **Trace 数据契约、编号格式与时间排序** | 本次差距是展示结构，不是 `/trace` API；GitHub/Gitee 编号、seen/filtered/absorbed/wake 数据和排序不能为套 Timeline 而改 |
| **判定与运行事件两个 Section 的边界** | 一个记判定结果，一个记轮询运行；可以分别换 DecisionLine/Timeline，不能合并成一条大杂烩时间线 |
| **`Stat` 的有动作率、仓库徽章、`HoursField`、三步 Onboarding** | 官方没有完全同物且都由真实数据驱动；保留 derived，复用底层 token/Field/Button/Hint，不删除功能 |
| **版本诊断、升级命令、AGENTS 建议规则、会话 goal** | 都是真实主理鱼能力；只修错误反馈、Modal footer、SaveBar，不移植官方 Prompt 编辑器或 Deployment 整页 |
| **DSH Trajectory 的 Overview/Timeline 缩放图** | 它面向 token/TTFT/时间跨度和拖选，不是 issue 追溯；`TraceTimeline` 应使用 superagent 的轻量 `dt-timeline` |
| **DSH `InlineEditor / RiskConfirmation / SettingsFormModel` 的强套** | 多字段 watcher 不适合单文本 InlineEditor；普通删除不需要 acknowledgment checkbox；当前 API 不是 ConfigForm path-op/revision，不能为“用了官方件”牺牲正确性 |
| **现有 API、轮询、ETag、状态计算与过滤规则** | 本任务是 UI 复用差距，不重写 `/state /watch /trace /credentials /goal`，不改 `orbitStateOf` 的业务判断，只集中其展示映射 |
| **全局 `PORTED_CSS` 一次性推翻重写** | 仍有很多 superagent 复合件依赖 `dt-*`；应逐组件迁移并保留 token，禁止同时引入第二套 reset 或把官方静态 hex 回写到组件 |

## 13. 建议实施顺序与总验收

### 13.1 顺序（每步独立可回滚）

1. **先做宿主 smoke 与共享适配层**：确认 primitives require、Modal/Toast/Tooltip 的 props 和 CSS-module 类，保留 superagent 回退；不在此步改页面数量。
2. **ROI-2 + ROI-4**：先收确认、Modal、Tooltip、Toast、卫星环浮层，消除重复交互与焦点问题。
3. **ROI-3**：分别落 DecisionLine、Trace Timeline、Runtime Timeline，防止“所有记录都叫 Timeline”造成二次返工。
4. **ROI-1**：抽 WatcherForm，再接凭证和 goal 的 SaveBar；最后迁移数字约束与高级 Disclosure。
5. **ROI-5 + 总览/设置 P1**：LoadState、ProblemLine、filtered Disclosure、repo/triage 列表、术语表、硬编码与死代码。
6. **双主题与键盘回归通过后，才删除旧 `ConfirmBtn`、旧 InfoTip、旧 Toast、旧行拼接和无用 CSS**；不要先删回退再修新组件。

### 13.2 总验收清单

| 层 | 必须通过的检查 |
|---|---|
| 静态结构 | Tabs 恰好 4；`window.confirm` 保持为 0；Trace 组标题不冒充 `dt-event`，Trace/Runtime 时间使用 `<time>`；watcher 行不再读写 `rowBody.props.children`；业务色不再出现 `#ffffff/rgba(128,128,128,...)`；`S/BORDER` 无残留 |
| DOM 对照 | 判定=DecisionLine，Trace/Runtime=Timeline；问题=ProblemLine；过滤=Disclosure；事实=KeyValues；分诊矩阵=dt-table；术语=Glossary；没有“同名两套 DOM” |
| 键盘/读屏 | Tabs 方向键/Home/End；Disclosure Enter/Space；Modal Tab 圈/Escape/焦点归还；Tooltip hover/focus/touch/Escape；Field label-htmlFor；错误 role=alert |
| 状态矩阵 | 首次加载、首次失败、stale+失败、真正空、筛选空、trace 空/错/加载、更新失败、保存失败、复制失败全部有唯一且真实的展示 |
| 双主题/尺寸 | 浅色与深色文字/边框/状态色对比；主面板与卫星环在窄容器无横向溢出；Toast/Modal/popover 不越视口；动作不被 meta 裁切 |
| 行为回归 | touched-only 保存、ghDir 不被误清、GitHub/Gitee 编号追溯、过滤/计数、卫星环写操作、升级检查与复制反馈全部保持真实 API 行为 |

> 本文列出的“验收方式”是后续改代码后的验收要求，不表示本次只读核对已经执行或通过。
