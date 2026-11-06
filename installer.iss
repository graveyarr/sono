; Установщик Sono (Inno Setup 6). Собирается командой: python build.py
; Ставит программу без прав администратора — как Spotify: в папку пользователя,
; с ярлыками в «Пуске» и на рабочем столе и с удалением через «Приложения» Windows.

#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#ifndef MyAppExeName
  #define MyAppExeName "SonoMusic"
#endif
#define MyAppName "Sono"
; Файл — SonoMusic.exe, а не Sono.exe: иначе Discord принимает программу за одноимённую игру (см. build.py)
#define MyAppExe MyAppExeName + ".exe"

[Setup]
; AppId — постоянный номер программы: по нему Windows узнаёт её при обновлении и удалении. Не менять!
; (Он остался от времён, когда программа называлась Player, — поэтому новая версия встаёт поверх старой.)
AppId={{F839D305-C7ED-4EE3-90C9-624E94F4823E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher=Sono
DefaultDirName={localappdata}\Programs\{#MyAppName}
; Не ставить в старую папку Programs\Player, а переехать в Programs\Sono (старую уберёт [InstallDelete])
UsePreviousAppDir=no
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=SonoSetup-{#MyAppVersion}
SetupIconFile=assets\sono.ico
UninstallDisplayIcon={app}\{#MyAppExe}
UninstallDisplayName={#MyAppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Если программа открыта — установщик сам предложит её закрыть (при обновлении)
CloseApplications=yes
; Журнал установки — в %TEMP%\Setup Log <дата>.txt (если обновление не встало, там видно почему)
SetupLogging=yes

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\{#MyAppExeName}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; При обновлении убираем файлы старой версии, чтобы не смешивались с новыми
Type: filesandordirs; Name: "{app}\_internal"
; В версии 0.2.0 файл назывался Sono.exe — Discord путал его с игрой; убираем
Type: files; Name: "{app}\Sono.exe"
; Раньше программа называлась Player: убираем её папку и ярлыки (медиатека лежит отдельно и не трогается —
; при первом запуске Sono сам перенесёт её из %LOCALAPPDATA%\Player в %LOCALAPPDATA%\Sono)
Type: filesandordirs; Name: "{localappdata}\Programs\Player"
Type: files; Name: "{autoprograms}\Player.lnk"
Type: files; Name: "{autodesktop}\Player.lnk"

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExe}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
; Автообновление (appupdate.py): программа запускает установщик тихо с /UPDATE=1 и закрывается — открываем новую версию
Filename: "{app}\{#MyAppExe}"; Flags: nowait; Check: IsAutoUpdate

[Code]
const
  WebView2Key = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2KeyUser = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

// Окно программы рисует движок Microsoft Edge WebView2. В Windows 11 он есть всегда,
// в Windows 10 — почти всегда. Если его нет — предлагаем скачать с сайта Microsoft.
function HasWebView2: Boolean;
var
  Version: String;
begin
  Result := (RegQueryStringValue(HKLM, WebView2Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'))
    or (RegQueryStringValue(HKCU, WebView2KeyUser, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
end;

// Перед заменой файлов закрываем все копии Sono. Обычное «закрыть» (его шлёт CloseApplications) Sono
// не слушается, если он спрятан в трей: окно прячется, программа работает дальше и держит свои файлы.
// Тихий установщик (автообновление) тогда молча сдавался — обновление не вставало (было 6 ноября 2026).
// Медиатека сохраняется сразу после каждого изменения, так что ничего не теряется.
// Закрываем только копии из папки, куда ставим (не трогаем Sono, запущенный из другого места).
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  AppDir: String;
begin
  AppDir := ExpandConstant('{app}');
  StringChangeEx(AppDir, '''', '''''', True);   // апостроф в имени папки пользователя — удваиваем для PowerShell
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
       '-NoProfile -ExecutionPolicy Bypass -Command "$n = 0; Get-Process -Name ''{#MyAppExeName}'' -ErrorAction SilentlyContinue | ' +
       'Where-Object { $_.Path -and $_.Path.StartsWith(''' + AppDir + '\'', ''OrdinalIgnoreCase'') } | ' +
       'ForEach-Object { Stop-Process -Id $_.Id -Force; $n++ }; exit $n"',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if ResultCode > 0 then
    Sleep(1000);   // дать Windows отпустить файлы закрытых процессов
  Result := '';
end;

// Установщик запустила сама программа, чтобы обновиться (параметр /UPDATE=1)
function IsAutoUpdate: Boolean;
begin
  Result := ExpandConstant('{param:UPDATE|0}') = '1';
end;

function InitializeSetup: Boolean;
var
  ErrorCode: Integer;
begin
  Result := True;
  if not HasWebView2 and not WizardSilent then
    if MsgBox('Для работы Sono нужен компонент Microsoft Edge WebView2, а на этом компьютере его нет.' + #13#10#13#10 +
              'Открыть страницу Microsoft, чтобы скачать его? (Установку Sono можно продолжить и поставить компонент потом.)',
              mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', WebView2Url, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
end;

// При удалении спрашиваем, стереть ли медиатеку и кэш (они лежат отдельно, в %LOCALAPPDATA%\Sono;
// у тех, кто ставил ещё Player и не запускал Sono, — в %LOCALAPPDATA%\Player)
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir, OldDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\Sono');
    OldDir := ExpandConstant('{localappdata}\Player');
    if (DirExists(DataDir) or DirExists(OldDir)) and not UninstallSilent then
      if MsgBox('Удалить также ваши плейлисты, избранное и скачанный кэш?' + #13#10 +
                'Если оставить — при повторной установке всё вернётся.',
                mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      begin
        DelTree(DataDir, True, True, True);
        DelTree(OldDir, True, True, True);
      end;
  end;
end;
