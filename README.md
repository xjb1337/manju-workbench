# 漫剧工作台

本地桌面工作台，按作品、集数和镜头组织剧本、参考素材与成片。

## 启动

需要 Node.js 24、npm 和图形桌面。将 FFmpeg 7.1 或更高版本的 `ffmpeg`、`ffprobe` 放入 PATH。FFmpeg 构建需包含 libx264、AAC 编码和 libass，并能找到中文字体。Windows 默认选用 Microsoft YaHei，Linux 默认选用 Noto Sans CJK SC。

```sh
npm ci
npm run dev
```

生产构建成功后可直接运行 `npm start`。Windows x64 安装包可用 `npm run pack:win` 构建，默认保存到 `release/`。安装包内的应用仍从系统 PATH 查找 FFmpeg。当前安装包尚未在 Windows 真机上验证安装、启动与导出。

## 作品目录

```text
漫剧 一/
  project.json
  media/
    <版本 UUID>.<扩展名>
```

用「打开作品」选择包含 `project.json` 的文件夹。备份或迁移时复制整个作品目录。原始导入路径仅用于复制，项目保存各版本文件名、时间、类型、活动版本和必要元数据。剧本和镜头字段由对应的「保存」按钮提交。

## 素材与成片

- 参考图支持 JPG、JPEG、PNG、WebP。视频支持 MP4、MOV、WebM。配音支持 WAV、MP3、M4A、OGG、FLAC。
- 导入追加一个版本并设为活动版本。素材版本下拉框可切换到之前的版本。
- 顺序预览和导出按时间线顺序合成。画面优先选活动视频，依次回退到活动参考图和黑底。外部配音从对应镜头起点播放。超长素材按镜头时长裁切，短视频保持末帧，短配音补静音。台词烧录到该镜头画面。
- 输出为 1280×720、30 fps、H.264 + AAC MP4。ChatGPT 和 Google Flow 按钮通过系统打开网页，生成和下载素材由用户手动完成。
- 「创建虚构示例」写入四镜头原始插画与合成音调，标有「示例 / 虚构」。

## 验证

```sh
npm test
npm run typecheck
npm run build
xvfb-run -a -s '-screen 0 1600x1050x24' npm run verify:desktop
```

桌面验收在独立 Electron 配置中运行。可用 `MANJU_RUN_DIR` 修改验收输出路径。

### Linux 原生 NSIS 构建

标准 NSIS 目标可在具备可用 Windows 环境或 Wine 的主机运行。Linux 上也可用原生 `makensis` 编译本仓库的中文安装脚本。

```sh
npm run build
npx electron-builder --win --dir --x64
npm run pack:win:native -- /path/to/makensis release/win-unpacked release/Manju-Workbench-1.0.0-x64-Setup.exe
```

这个安装程序按用户安装到 `%LOCALAPPDATA%\Programs\Manju Workbench`，并创建开始菜单入口和卸载项。也可用 Electron Builder 的 `portable` 目标生成免安装版本。
