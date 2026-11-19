# 漫剧工作台 Design System（Linear + Mercury 双主题融合规范）

本规范由 [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) 中的 **`linear.app`**（四级暗色表面阶梯、1px 细描边、克制单一强调色）与 **`mercury`**（深墨紫夜色与清透纸白昼间双世界统一）提炼并适配为本地三栏桌面创作工作台。

## 1. Visual Theme & Atmosphere

- **核心气质**：冷静、精密的桌面后期与剧本创作台。色彩让位于视频画幅、分镜胶片与角色参考图，UI 仅以中性灰紫阶梯、1px 细边框与单一靛紫操作色承担结构层级。
- **双世界一致性**：
  - **浅色模式（Mercury Day World）**：偏冷纸白画布配纯白面板与淡薰衣草激活底色，适合长时间编剧与项目规划阅读。
  - **深色模式（Linear Four-Step Ladder + Mercury Night）**：深炭墨紫表面阶梯逐层抬升（`#0c0d12` → `#101118` → `#13141c` → `#1b1d28`），依靠明度差与 1px 细线区分层次，避免重阴影。
  - **常驻影棚视口（Monitor Cinema Surface）**：无论亮/暗模式，监视器（`.monitor`）与独立播放器（`.episode-player`）始终保持深色外观（`color-scheme: dark`），确保画面明暗与色彩判断不被亮色外框干扰。

## 2. Color Palette & Roles

实现位置：[style.css](src/renderer/style.css)。

| Semantic Token | Light (Mercury) | Dark (Linear + Mercury) | Role |
|---|---|---|---|
| `--canvas` | `#f8f9fc` | `#0c0d12` | 主画布与主舞台底色 |
| `--rail` | `#f4f5fa` | `#101118` | 侧边栏、制作步骤条、底部状态栏 |
| `--panel` | `#ffffff` | `#13141c` | 检查器、弹窗、卡片、时间线容器、顶部栏 |
| `--well` | `#eef0f7` | `#1b1d28` | 输入槽、悬停底色、折叠摘要与次级衬底 |
| `--line` | `#e4e6f0` | `#232533` | 1px 区域分割线与卡片描边 |
| `--line-strong` | `#8588a2` | `#666a85` | 控件/输入框边框（满足 WCAG ≥ 3:1 非文本对比度） |
| `--ink` | `#1c1b29` | `#f4f5f8` | 主正文与标题文字 |
| `--muted` | `#555273` | `#9b9fb2` | 辅助说明、计数、表单标签、次级导航 |
| `--accent` | `#5266eb` | `#5e6ad2` | 主操作按钮（`#fff` 文字 ≥ 4.5:1）、焦点框、品牌标识 |
| `--accent-hover` | `#4254d4` | `#515dc7` | 主操作按钮悬停态 |
| `--accent-ink` | `#4354cc` | `#a5b0ff` | 强调文字、图标、激活项文字 |
| `--accent-bg` | `#edecfb` | `#1e223d` | 导航与胶片剪辑激活背景（克制低饱和底） |
| `--ok` / `--ok-bg` | `#136c46` / `#e7f6ee` | `#8be0b8` / `#17352a` | 已完成 / 已连接 / 审核通过状态 |
| `--warn` / `--warn-bg` | `#85530d` / `#fdf4df` | `#f0cf80` / `#392d19` | 待审核 / 需更新 / 冲突提示 |
| `--danger` / `--danger-bg` | `#b42348` / `#fdf1f4` | `#ff9cb3` / `#3b202b` | 危险操作、校验错误、断开提示 |

## 3. Typography & Tabular Rhythm

- **系统无衬线字体栈**：`"Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Noto Sans CJK SC", system-ui, sans-serif`，默认 `14px / 1.5`。
- **等宽与数字对齐**：监视器时间码（`.monitor-bottom`）、胶片标尺（`.clip-ruler`）、计数器（`.counter` / `.guide-total` / `.stage-count`）统一启用 `font-variant-numeric: tabular-nums`。

## 4. Elevation, Shapes & Interaction Guardrails

- **圆角克制**：按钮与输入控件 `7px`，监视器与时间线 `10px`，弹窗 `12px`；不使用全胶囊主按钮或炫彩渐变。
- **单一主动作原则**：同一操作组内仅一个实心 `button.primary`，附带顶部 `1px` 内高光（`inset 0 1px 0 #ffffff29`）；其余次要动作保持幽灵态或柔和 `--panel`/`--well` 态。
- **系统集成与无障碍**：
  - [index.html](src/renderer/index.html) 声明 `<meta name="color-scheme" content="light dark">` 配合 `:root` / `:root[data-theme="dark"]` 的 `color-scheme`，同步原生控件与滚动条外观。
  - 遵循 `prefers-reduced-motion: reduce` 与 Windows 高对比度 `@media (forced-colors: active)`，激活态与状态点不依赖单一颜色传达信息。
