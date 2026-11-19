# AI 视频制作工作台

本地桌面工作台，支持漫剧／故事、知识讲解、代码视频和混合制作，按作品、集数和镜头组织剧本、参考素材与成片。

## 启动

需要 Node.js 24、npm 和图形桌面。将 FFmpeg 7.1 或更高版本的 `ffmpeg`、`ffprobe` 放入 PATH。FFmpeg 构建需包含 libx264、AAC 编码和 libass，并能找到中文字体。Windows 默认选用 Microsoft YaHei，Linux 默认选用 Noto Sans CJK SC。

```sh
npm ci
npm run dev
```

生产构建成功后可直接运行 `npm start`。使用 Windows 安装包或便携包也需另行安装 FFmpeg，并将 `ffmpeg` 和 `ffprobe` 加入系统 PATH。

## 1.4.0 发布说明

- 扩展本机 / 局域网 OpenAI 兼容文本网关（默认 Magpie，内置 Ollama、LM Studio 预设与自定义地址），新增顶栏「AI 设置」、网关连接测试与模型列表探测，支持取消生成且不保存任何账户凭据。
- 在空舞台、步骤引导条、剧本编辑器与单镜详情弹窗前置开放 AI 入口，新增「AI 辅助写作」剧本草案生成与单镜提示词「AI 优化提示词」对比预览（均经确认后再写入）；进入规划操作前自动保存简报修改。
- 采用 Linear + Mercury 双主题融合规范（见 `DESIGN.md`）重塑亮/暗视觉层次、控件对比度、影棚监视器边框与高对比度模式适配。
- 安装包新增应用图标、自定义安装目录记忆与桌面/开始菜单快捷方式选项，应用内更新同时支持自定义安装目录识别。

## 1.3.0 发布说明

- 媒体协议改为基于项目索引的 O(1) 查找与 LRU 缓存；FFmpeg 预览/导出引入有限并发、会话级镜头分片缓存与平滑进度，改善中英混排字幕折行。
- 增强 Magpie 与外部规划 JSON 的容错提取；支持删除无效或多余的素材版本并清理孤儿素材文件。
- 生产工作区新增镜头快捷复制、拖拽导入参考图/视频/配音、单镜与配音独立试听以及常用快捷键；持久化窗口位置大小与深色/浅色主题。
- 拆分主进程会话管理、临时文件清理、窗口状态与渲染进程视图模块，提升可维护性。

应用未签名，SHA-256 用于校验文件完整性。使用安装包或便携包时需另行安装 FFmpeg。

## 作品目录

```text
漫剧 一/
  project.json
  media/
    <版本 UUID>.<扩展名>
```

用「打开作品」选择包含 `project.json` 的文件夹。备份或迁移时复制整个作品目录。原始导入路径仅用于复制，项目保存各版本文件名、时间、类型、活动版本和必要元数据。剧本和镜头字段由对应的「保存」按钮提交。

新建作品采用格式 2。格式 1 作品可打开和预览。首次尝试写入时会确认是否保留原件并升级副本。确认后在同一上级目录创建包含项目和素材的格式 2 副本，并切换到该副本继续操作。格式 1 原件可继续在旧版打开。首页可直接打开最近作品，文件选择器会记住上次使用的目录。

## 简报与规划

在「制作简报」保存类型、主题、受众、目标时长、画面比例、风格、语言、工具和术语。每个作品可分别填写生图和视频制作工具，支持使用同一工具。可填 HTTP 或 HTTPS 网址，从制作步骤通过系统浏览器打开。使用本地软件时，可只填工具名并手工导入生成文件。ChatGPT 和 Google Flow 可选用作预填项。

可复制「总规划提示词」，并将返回的 UTF-8 JSON 粘贴到「导入外部规划」。外部规划使用 `image-video`、`video-only` 和 `details.video` 表示通用的视频制作方式和提示词。旧规划仍可导入。预览列出当前值和导入值，冲突默认保留已有内容。用提示词内给出的镜头标识匹配现有镜头，省略标识时新增。

也可以在标题栏「AI 设置」配置本机或局域网 OpenAI 兼容文本网关（默认 Magpie `http://127.0.0.1:3425/v1`，可选 Ollama `http://127.0.0.1:11434/v1`、LM Studio `http://127.0.0.1:1234/v1` 或自定义地址），不保存任何 API Key 或账户凭据。点击「AI 生成分镜草案」会提交所填的剧本文本、相关简报字段和目标集数的分镜信息，检查「AI 分镜草案预览」后确认合并；剧本页面支持「AI 辅助写作」，单镜详情弹窗支持「AI 优化提示词」对比确认后应用。若工作台中尚无集数，合并分镜草案时可自动创建集数。

镜头可以单独选择制作方式，包括生图 + 视频制作、仅生图、仅视频制作、仅代码成片或仅导入成片。复制详细提示词时附上作品共享设定和已填写的工具名称。换工具时，对应的提示词会提示复核，已有素材版本可继续使用。

## 素材与成片

- 参考图支持 JPG、JPEG、PNG、WebP。视频支持 MP4、MOV、WebM。配音支持 WAV、MP3、M4A、OGG、FLAC。
- 导入追加一个版本并设为活动版本。素材版本下拉框可切换到之前的版本。
- 顺序预览和导出按时间线顺序合成。素材内容变化或镜头缓存损坏时会自动重编受影响的镜头。「重新生成预览」清空当前会话的镜头缓存并重新生成当前集预览。按镜头制作方式选用活动视频或参考图，缺少适用画面时使用黑底。导出前会列出缺素材、需要使用静态图或黑底的镜头。外部配音从对应镜头起点播放。代码成片和仅导入成片在无独立配音且未标静默时可保留视频原声。超长素材按镜头时长裁切，短视频保持末帧，短配音补静音。台词烧录到该镜头画面，过长台词会在镜头内分段显示。
- 在单镜「配音与字幕稿」保存稿件后，选择「预览台词差异」，按当前镜头确认需要烧录的内容。自由格式稿件可在预览中编辑，保留配音标注时请只把要显示的文本留在「拟应用台词」。镜头编辑器显示当前烧录台词。分镜工具栏可导出当前集 UTF-8 SRT，和 MP4 使用同一套台词、分页与 30 fps 帧边界，兼容横屏和竖屏。
- 输出为 30 fps、H.264 + AAC MP4。16:9 为 1280×720，9:16 为 720×1280，旧项目默认 16:9。实际时长取镜头总帧数，修改比例会将已有导出记录标为过期。
- 「创建虚构示例」包含四镜原始插画与合成音调。「创建竖屏代码示例」包含两段本地代码动画。两者均标有「示例 / 虚构」。

## 验证

```sh
npm test
npm run typecheck
npm run build
xvfb-run -a -s '-screen 0 1600x1050x24' npm run verify:desktop
```

桌面验收在独立 Electron 配置中运行。可用 `MANJU_RUN_DIR` 修改验收输出路径。

## Windows x64 打包

`npm run pack:win` 调用 Electron Builder 的标准 NSIS 目标。在当前 Linux 环境中，该目标因缺少可用 Wine 而无法完成。用于应用内覆盖更新的 Setup 由本仓库的自定义 NSIS 脚本生成。Linux 上先构建解包目录，再使用缓存中的 Linux 版 `makensis` 编译该脚本。

```sh
npm run build
npx electron-builder --win --dir --x64
npm run pack:win:native -- /path/to/makensis release/win-unpacked release/Manju-Workbench-1.4.0-x64-Setup.exe
```

自定义安装程序默认按用户安装到 `%LOCALAPPDATA%\Programs\Manju Workbench`，支持在安装向导中修改安装位置并选择是否创建桌面快捷方式，目录中包含 `漫剧工作台.exe` 和 `Uninstall.exe`。使用以下命令生成 `release/Manju-Workbench-1.4.0-x64-Portable.exe`。

```sh
npm run build
npx electron-builder --win portable --x64
```

## 更新发布清单

标题栏的「检查更新」按需读取 `xjb1337/manju-workbench` 的正式 GitHub Release。1.4.0 的标签可使用 `1.4.0` 或 `v1.4.0`。随 Release 提供 `Manju-Workbench-1.4.0-win-x64.manifest.json`（UTF-8 JSON），所有更新附件的下载地址必须逐字匹配 `https://github.com/xjb1337/manju-workbench/releases/download/<tag>/<fileName>`。

便携版与其他打包的 Windows x64 目录可下载便携包并自行替换。已校验的便携包保留在系统临时目录。

- 根对象包含 `schemaVersion`（数字 `1`）、`version`（字符串 `"1.4.0"`）和 `assets`（1–2 项）。
- 每条附件包含 `fileName`、`size`（1 字节至 2 GiB，整数）、`sha256`（64 位十六进制）和 `kind`。每种类型最多一份，名称须与附件逐字匹配。
- `setup` 使用自定义 NSIS 产物 `Manju-Workbench-1.4.0-x64-Setup.exe`。`portable` 使用 `Manju-Workbench-1.4.0-x64-Portable.exe` 或 `Manju-Workbench-1.4.0-x64-Portable.zip`。

打包完成后，将最终附件路径传给本地脚本。清单写入第一个附件所在的目录。传入一份附件也可生成清单。`--sha256` 可另外生成 `Manju-Workbench-1.4.0-win-x64.sha256.txt`。

```sh
node scripts/write-update-manifest.cjs --sha256 release/Manju-Workbench-1.4.0-x64-Setup.exe release/Manju-Workbench-1.4.0-x64-Portable.exe
```
