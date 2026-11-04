[CmdletBinding()]
param(
    [string] $FlutterSdk = '',
    [ValidateRange(1, 65535)] [int] $Port = 5290,
    [switch] $ServeOnly
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw '请使用 PowerShell 7：pwsh.exe -NoProfile -File scripts/preview.ps1'
}
$appDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $appDirectory

function Invoke-Checked {
    param([string] $Program, [string[]] $Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Program 执行失败（$LASTEXITCODE）"
    }
}

if (-not $ServeOnly) {
    if ($FlutterSdk) {
        $flutterCommand = Join-Path ([IO.Path]::GetFullPath($FlutterSdk)) 'bin/flutter.bat'
    } elseif (Get-Command flutter -ErrorAction SilentlyContinue) {
        $flutterCommand = (Get-Command flutter).Source
    } else {
        $flutterCommand = Join-Path ([IO.Path]::GetFullPath((Join-Path $appDirectory '../..'))) 'flutter-sdk/bin/flutter.bat'
    }
    if (-not (Test-Path -LiteralPath $flutterCommand -PathType Leaf)) {
        throw '未找到 Flutter SDK。传入 -FlutterSdk D:\dev\flutter-sdk，或把 flutter 加入 PATH。'
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '需要 Node.js 22.18 或更高版本。' }
    $webDependencies = Join-Path $appDirectory '../web/node_modules/vite/package.json'
    if (-not (Test-Path -LiteralPath $webDependencies -PathType Leaf)) {
        Push-Location -LiteralPath (Join-Path $appDirectory '../web')
        try { Invoke-Checked npm @('ci') } finally { Pop-Location }
    }
    Invoke-Checked node @('scripts/prepare-assets.mjs', '--web')
    Invoke-Checked node @('scripts/build-web-bridge.mjs')
    Invoke-Checked $flutterCommand @('pub', 'get')
    Invoke-Checked $flutterCommand @('build', 'web', '--release', '--no-web-resources-cdn')
}
Invoke-Checked node @('scripts/serve.mjs', '--port', "$Port")
