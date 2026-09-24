param(
    [Parameter(Mandatory = $true)]
    [string]$DeviceIp,

    [ValidateRange(1, 65535)]
    [int]$Port = 5555,

    [string]$ApkPath = (Join-Path $PSScriptRoot "..\firetv\build\outputs\apk\debug\firetv-debug.apk"),

    [string]$AdbPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$resolvedApk = (Resolve-Path -LiteralPath $ApkPath).Path

if (-not $AdbPath) {
    $adbCommand = Get-Command adb.exe -ErrorAction SilentlyContinue
    if ($adbCommand) {
        $AdbPath = $adbCommand.Source
    }
}

if (-not $AdbPath) {
    $sdkCandidate = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
    if (Test-Path -LiteralPath $sdkCandidate) {
        $AdbPath = $sdkCandidate
    }
}

if (-not $AdbPath -or -not (Test-Path -LiteralPath $AdbPath)) {
    throw "ADB was not found. Install Android Platform Tools or pass -AdbPath with the full path to adb.exe."
}

$target = "${DeviceIp}:$Port"
Write-Host "Connecting to $target ..."
& $AdbPath connect $target
if ($LASTEXITCODE -ne 0) {
    throw "ADB could not connect to $target. Confirm ADB debugging is enabled and approve the prompt on the Fire TV."
}

$deviceLines = & $AdbPath devices
if (-not ($deviceLines -match ("^" + [regex]::Escape($target) + "\s+device$"))) {
    throw "The Fire TV did not authorize this computer. Approve the ADB prompt on the TV, then run the script again."
}

Write-Host "Installing Movie Room ..."
& $AdbPath install -r $resolvedApk
if ($LASTEXITCODE -ne 0) {
    throw "APK installation failed. If Android reports a signature mismatch, uninstall the older debug build on the Fire TV and run this once more."
}

Write-Host "Launching Movie Room ..."
& $AdbPath shell monkey -p com.movieroom.firetv -c android.intent.category.LEANBACK_LAUNCHER 1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Movie Room installed, but ADB could not launch it automatically. Open it from Apps on the Fire TV."
}

Write-Host "Movie Room is installed and launched on $target."
