!ifndef BUILD_UNINSTALLER
  !include "nsDialogs.nsh"
  !include "LogicLib.nsh"

  Var ShortcutDialog
  Var DesktopShortcutCheckbox
  Var CreateDesktopShortcut

  !macro customInit
    StrCpy $CreateDesktopShortcut "${BST_CHECKED}"
  !macroend

  !macro customPageAfterChangeDir
    PageEx custom
      PageCallbacks ShortcutOptionsPageCreate ShortcutOptionsPageLeave
    PageExEnd

    Function ShortcutOptionsPageCreate
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "快捷方式选项" "选择需要创建的快捷方式"

      nsDialogs::Create 1018
      Pop $ShortcutDialog
      ${If} $ShortcutDialog == error
        Abort
      ${EndIf}

      ${NSD_CreateCheckbox} 0u 12u 100% 12u "创建桌面快捷方式"
      Pop $DesktopShortcutCheckbox
      ${NSD_SetState} $DesktopShortcutCheckbox $CreateDesktopShortcut

      nsDialogs::Show
    FunctionEnd

    Function ShortcutOptionsPageLeave
      ${NSD_GetState} $DesktopShortcutCheckbox $CreateDesktopShortcut
    FunctionEnd
  !macroend

  !macro customInstall
    ${If} $CreateDesktopShortcut == "${BST_CHECKED}"
      SetOutPath "$INSTDIR"
      CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$DESKTOP\${PRODUCT_NAME}.lnk" "${APP_ID}"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${EndIf}
  !macroend
!endif

!macro customUnInstall
  ${IfNot} ${isKeepShortcuts}
    WinShell::UninstShortcut "$DESKTOP\${PRODUCT_NAME}.lnk"
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend
