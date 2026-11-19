---
name: manju-release-verify
description: >-
  Use when verifying code changes, running Playwright Electron E2E tests, or
  building Windows Setup/Portable installers and release manifests in the 漫剧工作台
  (manju-workbench) workspace.
---

# Manju Workbench Verification & Windows Packaging

## PowerShell Rules (Windows)
- Do NOT chain commands with `&&` in Windows PowerShell 5.1; use `; if ($LASTEXITCODE -eq 0) { ... }`.
- Invoke npm binaries with `npx.cmd` instead of bare `npx`.

## 1. Standard Code Verification
Run typecheck, production bundle build, and unit tests first:
```powershell
npm run typecheck; if ($LASTEXITCODE -eq 0) { npm run build }; if ($LASTEXITCODE -eq 0) { npm test }
```
Then run real Electron E2E verification (includes FFmpeg render/subtitle/update-fixture/AI flows):
```powershell
npm run verify:desktop
```

### Known Pitfalls When Editing Renderer & E2E Tests
- **Single-flight `run()` mutex (`src/renderer/App.tsx`)**: `run()` drops overlapping calls while `running.current` is true. Never wrap background preference writes (such as saving model/gateway config) inside `run()` right before triggering a user action that also calls `run()`.
- **Playwright accessible names with `<Badge>`**: Buttons containing `<Badge>` append the badge text to their accessible name (e.g., `代码任务书 手改`). Match buttons in `tests/desktop.cjs` with regexes like `/代码任务书/` when badges may be present.

## 2. Full Windows Release Packaging (Setup + Portable + Manifest)
Run only after user authorization or explicit packaging request:
1. Build production assets and unpacked `release/win-unpacked` directory (which also populates cached `makensis.exe`):
   ```powershell
   npm run build; if ($LASTEXITCODE -eq 0) { npx.cmd electron-builder --win --dir --x64 }
   ```
2. Locate cached `makensis.exe` under `release\.builder-cache`:
   ```powershell
   $makensis = (Get-ChildItem "release\.builder-cache" -Filter "makensis.exe" -Recurse | Select-Object -First 1).FullName
   ```
3. Build custom NSIS Setup installer, Portable executable, and SHA-256 update manifest:
   ```powershell
   npm run pack:win:native -- "$makensis" release/win-unpacked release/Manju-Workbench-1.3.0-x64-Setup.exe; if ($LASTEXITCODE -eq 0) { npx.cmd electron-builder --win portable --x64 }; if ($LASTEXITCODE -eq 0) { node scripts/write-update-manifest.cjs --sha256 release/Manju-Workbench-1.3.0-x64-Setup.exe release/Manju-Workbench-1.3.0-x64-Portable.exe }
   ```
   *(Adjust `1.3.0` to match `package.json` version when bumping releases.)*
4. Confirm expected outputs in `release/`: `*-Setup.exe`, `*-Portable.exe`, `*-win-x64.manifest.json`, and `*-win-x64.sha256.txt`.
