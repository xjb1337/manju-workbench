Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ManjuWorkbench"
!define APP_FOLDER "$LOCALAPPDATA\Programs\Manju Workbench"
!define APP_EXE "漫剧工作台.exe"
!define INSTALL_IDENTITY "local.manju.workbench"
Var UpdateTarget

!ifndef APP_ICON
  !define APP_ICON "..\resources\icon.ico"
!endif

Name "漫剧工作台"
OutFile "${SETUP_EXE}"
InstallDir "${APP_FOLDER}"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor zlib
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "漫剧工作台"
VIAddVersionKey /LANG=2052 "FileDescription" "漫剧工作台安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Manju Workbench"

!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_SMALLDESC
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 漫剧工作台"

!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipUpdateDirectory
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  SetRegView 32
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "此安装包需要 64 位 Windows。"
    Abort
  ${EndIf}
  ${GetParameters} $0
  ${GetOptions} $0 "/MANJUUPDATE=" $1
  IfErrors manual
  StrCmp $1 "${INSTALL_IDENTITY}" 0 invalid
  ${GetOptions} $0 "/MANJUDIR=" $UpdateTarget
  IfErrors invalid
  StrCmp $UpdateTarget "" invalid
  Call ConfirmUpdateTarget
  Return
manual:
  ${GetOptions} $0 "/MANJUDIR=" $1
  IfErrors done invalid
invalid:
  Call RejectUpdateTarget
done:
FunctionEnd

Function SkipUpdateDirectory
  StrCmp $UpdateTarget "" done
  Abort
done:
FunctionEnd

Function RejectUpdateTarget
  MessageBox MB_ICONSTOP "安装来源与目标目录无法匹配，请手动更新。"
  SetErrorLevel 2
  Abort
FunctionEnd

Function ConfirmUpdateTarget
  ReadRegStr $1 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  StrCmp $1 "$UpdateTarget" 0 invalid
  ReadRegStr $1 HKCU "${UNINSTALL_KEY}" "InstallIdentity"
  ; 1.4.0 registrations predate this value. Their registry key and file paths still identify Setup.
  StrCmp $1 "" legacy
  StrCmp $1 "${INSTALL_IDENTITY}" 0 invalid
legacy:
  ReadRegStr $1 HKCU "${UNINSTALL_KEY}" "DisplayIcon"
  StrCmp $1 "$UpdateTarget\${APP_EXE}" 0 invalid
  ReadRegStr $1 HKCU "${UNINSTALL_KEY}" "UninstallString"
  StrCmp $1 '$\"$UpdateTarget\Uninstall.exe$\"' 0 invalid
  IfFileExists "$UpdateTarget\${APP_EXE}" 0 invalid
  IfFileExists "$UpdateTarget\Uninstall.exe" 0 invalid
  ; Resolve directory aliases (including junctions) before allowing any writes.
  System::Call 'kernel32::CreateFileW(w "$UpdateTarget", i 0, i 7, p 0, i 3, i 0x02000000, p 0) p .r4'
  StrCmp $4 "-1" invalid
  System::Call 'kernel32::GetFinalPathNameByHandleW(p r4, w .r5, i ${NSIS_MAX_STRLEN}, i 0) i .r6'
  System::Call 'kernel32::CloseHandle(p r4)'
  IntCmp $6 0 invalid
  IntCmp $6 ${NSIS_MAX_STRLEN} invalid 0 invalid
  StrCmp $5 "\\?\$UpdateTarget" 0 invalid
  StrCpy $INSTDIR "$UpdateTarget"
  Return
invalid:
  Call RejectUpdateTarget
FunctionEnd

Function un.onInit
  SetRegView 32
FunctionEnd

Section "漫剧工作台（必需）" SecApp
  SectionIn RO
  ${If} $UpdateTarget != ""
    Call ConfirmUpdateTarget
  ${EndIf}
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${APP_SOURCE}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "漫剧工作台"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallIdentity" "${INSTALL_IDENTITY}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "创建桌面快捷方式" SecDesktop
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  CreateShortCut "$DESKTOP\漫剧工作台.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
SectionEnd

Section "创建开始菜单快捷方式" SecStartMenu
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  CreateShortCut "$SMPROGRAMS\漫剧工作台.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
SectionEnd

LangString DESC_SecApp ${LANG_SIMPCHINESE} "安装 漫剧工作台 主程序与运行资源。"
LangString DESC_SecDesktop ${LANG_SIMPCHINESE} "在桌面创建 漫剧工作台 快捷方式。"
LangString DESC_SecStartMenu ${LANG_SIMPCHINESE} "在开始菜单创建 漫剧工作台 快捷方式。"

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecApp} $(DESC_SecApp)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} $(DESC_SecDesktop)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartMenu} $(DESC_SecStartMenu)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\漫剧工作台.lnk"
  Delete "$SMPROGRAMS\漫剧工作台.lnk"
  !include "${UNINSTALL_FILES}"
  Delete "$INSTDIR\Uninstall.exe"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  RMDir "$INSTDIR"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
SectionEnd
