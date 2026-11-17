; MemeForge installer (Inno Setup 6).
; Built by release.ps1, which passes /DAppVersion=x.y.z
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "MemeForge"
#define AppExe "MemeForge.exe"
#define RepoUrl "https://github.com/JustSad42/memeforge"

[Setup]
AppId={{B3E1F0A7-6C2D-4E9B-8A51-7D3C9F2E4B18}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=JustSad42
AppPublisherURL={#RepoUrl}
AppSupportURL={#RepoUrl}/issues
AppUpdatesURL={#RepoUrl}/releases
; per-user install: no admin prompt, and the app keeps its library next to the .exe
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\{#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
UsePreviousAppDir=yes
OutputDir=..\dist
OutputBaseFilename=MemeForge-{#AppVersion}-setup
SetupIconFile=..\rust\icons\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "..\rust\target\release\memeforge.exe"; DestDir: "{app}"; DestName: "{#AppExe}"; Flags: ignoreversion
Source: "How to use.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
; register "start with Windows" (on by default, changeable in Settings)
Filename: "{app}\{#AppExe}"; Parameters: "--setup"; Flags: runhidden
Filename: "{app}\{#AppExe}"; Description: "Open {#AppName}"; Flags: nowait postinstall skipifsilent
; after an in-app update (silent install), open the app again
Filename: "{app}\{#AppExe}"; Flags: nowait skipifnotsilent

[UninstallRun]
Filename: "{app}\{#AppExe}"; Parameters: "--remove-integration"; Flags: runhidden; RunOnceId: "RemoveIntegration"

[UninstallDelete]
; the downloaded library and caches go; settings and your memes folder stay
Type: filesandordirs; Name: "{app}\library"
Type: filesandordirs; Name: "{app}\EBWebView"
Type: files; Name: "{app}\update_state.json"
Type: files; Name: "{app}\window_state.json"
