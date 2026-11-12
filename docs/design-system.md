# 设计系统速查（移植自官方 dsh-superagent）

「主理鱼」面板的样式来自官方插件，`client.js` 里的 `PORTED_CSS` 就是那份设计系统（约 40 KB、208 个类）。
这份速查的目的只有一个：**以后加页面/改样式时，别再自己发明一套**。

## 0. 唯一官方主库（先读再改 UI）

- DSH 结构树与素材：`D:/DeepSeek Harness/home/dsh-ui-official/`，入口说明 `D:/DeepSeek Harness/home/DSH-UI-official.md`。
- superagent 控件与 CSS：`docs/official-decomp/04-panel-tree.md`、`docs/ui-decomp/02-superagent-assets.md`。
- 主理鱼逐页差距：`docs/ui-decomp/03-gap-map.md`。

顺序固定：**先查官方结构树/素材 → 再改 client.js → 最后补测试与实施回写**。主库已有 SVG、模板或结构就直接复用；只有官方确无同物时才 derived，并记录来源。不要重复拆 asar，也不要从截图猜层级。

> 全部数字都是从 `PORTED_CSS` 里机械抽出来的，不是手抄。
> 想重新生成：`node -e` 里读 `client.js` 的 `PORTED_CSS`，抽 `.dt-*`、`var(--dsw-*)`、`@keyframes`。

## 一、颜色只许用 token，不许写死

一共 35 个 token，都是宿主注入的 `--dsw-alias-*` / `--dsw-elevation-*`。
按用途分四组：

| 组 | token | 用在哪 |
|---|---|---|
| 文字 | `label-primary` / `label-secondary` / `label-tertiary` / `label-caption` / `label-dimmed` | 标题 / 正文 / 次要 / 说明 / 禁用 |
| 背景 | `bg-base` / `bg-layer-1..3` / `bg-mask-1` / `bg-module-platform` | 页面底 / 卡片 / 输入框 / 遮罩 |
| 描边 | `border-l2` / `border-l3` / `border-l4` | 卡片边 / 分隔线 / 输入框 |
| 状态 | `state-success-primary` / `state-warn-primary` / `state-error-primary` / `state-idle-primary` / `state-business-primary` | 状态点、标签 tone、Toast 左边条 |
| 交互 | `interactive-bg-hover` / `interactive-bg-active` / `button-primary-fill` / `button-primary-hover` / `button-ghost-active-fill` / `button-ghost-active-border` / `link` / `brand-primary` | 按钮、链接、悬停 |

阴影只有两个：`elevation-soft`（卡片）、`elevation-prominent`（弹层）。另有两个工具类：
`dsw-shadow-lv3`、`dsw-static-neutral-bluish-00`（纯白）。

**反面例子（我们踩过）**：`--dsw-alias-state-*` 写错成 `--dsw-alias-success-500`，
token 不解析 → 标签全变成裸文字，页面看着"没样式"。

## 二、组件类（按用途分组，共 208 个）

常用的这些，新页面直接用：

| 用途 | 类名 |
|---|---|
| 页面骨架 | `dt-page`（`height:100%; overflow:auto; padding: 28px clamp(24px, 4vw, 48px) 0`）、`dt-page-head`、`dt-page-title`、`dt-section`、`dt-section-title` |
| 页签 | `dt-tabs`（`display:flex; gap:20px; border-bottom:.5px`）、`dt-tab`（`padding:0 8px; font-size:13px`） |
| 行列表 | `dt-rows`、`dt-row`、`dt-row-main`、`dt-row-title`、`dt-row-meta`、`dt-row-actions`、`dt-row-buttons` |
| 标签 | `dt-tag` + `data-tone="success\|warning\|error\|outline"` |
| 按钮 | `dt-btn`（基础 `border-radius:18px`）+ 尺寸 `dt-btn-md`（高 36px）/ `dt-btn-sm`（高 28px、圆角 14px、12px 字）+ 变体 `-primary` / `-outline` / `-ghost` / `-icon` / `-busy` |
| 表单 | `dt-form`、`dt-field`、`dt-input`、`dt-textarea`、`dt-select`、`dt-switch` + `dt-switch-row`、`dt-input-icon` |
| 反馈 | `dt-toast`（`position:fixed; top:40px; z-index:1100`）、`dt-modal-root`（`fixed; inset:0`）+ `dt-modal`、`dt-spinner`、`dt-error` |
| 数据 | `dt-stats` / `dt-stat` / `dt-stat-value`、`dt-kv`、`dt-table`、`dt-timeline`、`dt-count` |
| 术语表 | `dt-glossary`、`dt-glossary-group`、`dt-glossary-modal`、`dt-legend` |
| 空态 | `dt-empty`、`dt-hint`、`dt-link`、`dt-more-link` |

官方那套「工单 / 派工 / 评估强度」的类（`dt-ticket*`、`dt-admission*`、`dt-changed-*`、`dt-prompt*`、
`dt-rule*` 等）保留在 CSS 里但**我们没有用**——它们是随官方 CSS 一起移植过来的，留着是为了将来真要加时不用重抄。

### 设置 → 来源的「页签名称」

会话头第二个 row 上那个 `conversation.view` 页签的名字可改。这一格**没有新增任何 CSS**，
全部复用已有原语：`Field`（`dt-field` + `dt-field-head`）、`Input`（`dt-input`）、`Btn`
（`dt-btn dt-btn-primary/ghost dt-btn-sm`）、`Hint`（`p.dt-hint`）。

为什么说明这一条：对比度体检按「选择器 + 颜色」分组计不达标组数，新造一个 `<small class="...">`
会多出一组（`.dt-field small` 的 `label-caption` 在白底只有 3.45）。复用 `p.dt-hint` 则组数不变 ——
浅色 16 组 / 深色 13 组与基线持平。以后往设置页加字段时，说明文字优先用 `Hint`，不要新造 `small`。

## 三、动效

| 名字 | 时长 | 用途 |
|---|---|---|
| `dt-spin` | 1s linear（`.dt-btn-busy .dt-btn-icon svg` 这个用法里是 1s） | spinner（不是轨道环，别混） |
| `dt-toast-in` / `dt-toast-fade` | — | Toast 出现与消失；`--dt-toast-hold` 控制停留（我们设 3600ms） |
| `dt-tooltip-in` | — | 悬停提示 |

轨道环的 `sa-orbit-spin`（3s）与 `sa-orbit-breathe`（1.6s）是我们自己写的，不在 `PORTED_CSS` 里。

## 四、加一个新页面时的检查清单

1. 壳子用 `dt-page` + `dt-page-head`，标题用 `dt-page-title`；
2. 内容分块用 `dt-section` + `dt-section-title`，别自己画卡片；
3. 列表用 `dt-rows` / `dt-row`（三线结构：标题 / meta / 操作），行高实测 102–122px；
4. 颜色一律 `var(--dsw-alias-*)`，**不许写 `#rrggbb`**（深色主题会烂）；
5. 状态一律用 `dt-tag[data-tone]` 或 `dt-dot`，不要自造颜色语义；
6. 空态给一句人话（`dt-empty`），不要留白；
7. 改完跑 `pnpm run preview`，在真浏览器里量一遍：`scrollWidth === clientWidth`（无横向滚动）、
   没有元素越界（`position:fixed` 的遮罩除外）。

## 五、这套东西怎么验的

- 真浏览器（Chromium）里读 computed style：模态 `position:fixed; inset:0` 且宽 380 居中；
  Toast `position:fixed; top:40px; z-index:1100`、299×46 深底白字；标签 success 绿 / warning 琥珀。
- 六个场景（总览 / 判定 / 触发 / 设置 / 两种 Toast / 术语表）全部无横向溢出、无越界元素。
- 细节见 HANDOFF「UI 走查」表与 `scripts/render-preview.mjs`。
