# AI 视频制作工作台

本地桌面工作台，支持漫剧／故事、知识讲解、代码视频和混合制作，按作品、集数和镜头组织剧本、参考素材与成片。

## 启动

需要 Node.js 24、npm 和图形桌面。将 FFmpeg 7.1 或更高版本的 `ffmpeg`、`ffprobe` 放入 PATH。FFmpeg 构建需包含 libx264、AAC 编码和 libass，并能找到中文字体。Windows 默认选用 Microsoft YaHei，Linux 默认选用 Noto Sans CJK SC。

```sh
npm ci
npm run dev
```

生产构建成功后可直接运行 `npm start`。使用 Windows 安装包或便携包也需另行安装 FFmpeg，并将 `ffmpeg` 和 `ffprobe` 加入系统 PATH。

## 1.2.0 发布说明

- 旧作品首次保存时迁移到格式 2。若需继续用 1.1.0 或更早版本打开，请先备份整个作品目录。
- 「制作简报 → AI 生成分镜草案」可通过本机 Magpie 网关拆分剧本，预览并确认后合并到作品。
- 可按作品配置生图和视频制作工具。工具名称会随提示词复制，生成的媒体可手工导入。
- 增加最近作品和上次导入路径。统一镜头预览和导出的画面选择，导出前提示静态图或黑底回退，长字幕按页显示。
- 修复并行保存覆盖、已失效的素材仍显示完成，以及更新包校验失败后无法重新下载等问题。

应用未签名，SHA-256 用于校验文件完整性。使用安装包或便携包时需另行安装 FFmpeg。

## 作品目录

```text
漫剧 一/
  project.json
  media/
    <版本 UUID>.<扩展名>
```

用「打开作品」选择包含 `project.json` 的文件夹。备份或迁移时复制整个作品目录。原始导入路径仅用于复制，项目保存各版本文件名、时间、类型、活动版本和必要元数据。剧本和镜头字段由对应的「保存」按钮提交。

新建作品采用格式 2。格式 1 作品仍可打开，首次保存时迁移，之后旧版工作台会拒绝打开。首页可直接打开最近作品，文件选择器会记住上次使用的目录。

## 简报与规划

在「制作简报」保存类型、主题、受众、目标时长、画面比例、风格、语言、工具和术语。每个作品可分别填写生图和视频制作工具，支持使用同一工具。可填 HTTP 或 HTTPS 网址，从制作步骤通过系统浏览器打开。使用本地软件时，可只填工具名并手工导入生成文件。ChatGPT 和 Google Flow 可选用作预填项。

可复制「总规划提示词」，并将返回的 UTF-8 JSON 粘贴到「导入外部规划」。外部规划使用 `image-video`、`video-only` 和 `details.video` 表示通用的视频制作方式和提示词。旧规划仍可导入。预览列出当前值和导入值，冲突默认保留已有内容。用提示词内给出的镜头标识匹配现有镜头，省略标识时新增。

也可以在「制作简报」选择「AI 生成分镜草案」。先启动 Magpie 的本机网关（`http://127.0.0.1:3425/v1`），默认使用 `group/never-stuck`，可填写网关中其他文本模型或路由的 ID。点击「生成草案」会提交所填的剧本文本、相关简报字段和目标集数的分镜信息。Magpie 可按路由转发给上游模型。检查「AI 分镜草案预览」后确认合并，已有镜头字段的冲突默认保留原值。若工作台中尚无集数，合并时可从草案创建集数。

镜头可以单独选择制作方式，包括生图 + 视频制作、仅生图、仅视频制作、仅代码成片或仅导入成片。复制详细提示词时附上作品共享设定和已填写的工具名称。换工具时，对应的提示词会提示复核，已有素材版本可继续使用。

## 素材与成片

- 参考图支持 JPG、JPEG、PNG、WebP。视频支持 MP4、MOV、WebM。配音支持 WAV、MP3、M4A、OGG、FLAC。
- 导入追加一个版本并设为活动版本。素材版本下拉框可切换到之前的版本。
- 顺序预览和导出按时间线顺序合成。按镜头制作方式选用活动视频或参考图，缺少适用画面时使用黑底。导出前会列出缺素材、需要使用静态图或黑底的镜头。外部配音从对应镜头起点播放。代码成片和仅导入成片在无独立配音且未标静默时可保留视频原声。超长素材按镜头时长裁切，短视频保持末帧，短配音补静音。台词烧录到该镜头画面，过长台词会在镜头内分段显示。
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
npm run pack:win:native -- /path/to/makensis release/win-unpacked release/Manju-Workbench-1.2.0-x64-Setup.exe
```

自定义安装程序按用户安装到 `%LOCALAPPDATA%\Programs\Manju Workbench`，目录中包含 `漫剧工作台.exe` 和 `Uninstall.exe`。使用以下命令生成 `release/Manju-Workbench-1.2.0-x64-Portable.exe`。

```sh
npm run build
npx electron-builder --win portable --x64
```

## 更新发布清单

标题栏的「检查更新」按需读取 `xjb1337/manju-workbench` 的正式 GitHub Release。1.2.0 的标签可使用 `1.2.0` 或 `v1.2.0`。随 Release 提供 `Manju-Workbench-1.2.0-win-x64.manifest.json`（UTF-8 JSON），所有更新附件的下载地址必须逐字匹配 `https://github.com/xjb1337/manju-workbench/releases/download/<tag>/<fileName>`。

便携版与其他打包的 Windows x64 目录可下载便携包并自行替换。已校验的便携包保留在系统临时目录。

- 根对象包含 `schemaVersion`（数字 `1`）、`version`（字符串 `"1.2.0"`）和 `assets`（1–2 项）。
- 每条附件包含 `fileName`、`size`（1 字节至 2 GiB，整数）、`sha256`（64 位十六进制）和 `kind`。每种类型最多一份，名称须与附件逐字匹配。
- `setup` 使用自定义 NSIS 产物 `Manju-Workbench-1.2.0-x64-Setup.exe`。`portable` 使用 `Manju-Workbench-1.2.0-x64-Portable.exe` 或 `Manju-Workbench-1.2.0-x64-Portable.zip`。

打包完成后，将最终附件路径传给本地脚本。清单写入第一个附件所在的目录。传入一份附件也可生成清单。`--sha256` 可另外生成 `Manju-Workbench-1.2.0-win-x64.sha256.txt`。

```sh
node scripts/write-update-manifest.cjs --sha256 release/Manju-Workbench-1.2.0-x64-Setup.exe release/Manju-Workbench-1.2.0-x64-Portable.exe
```
