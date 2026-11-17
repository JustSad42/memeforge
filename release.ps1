# Builds the app and installer, and publishes them as a GitHub release.
#   .\release.ps1              build + installer only (dist\)
#   .\release.ps1 -Publish     also tag v<version> and create the GitHub release
# The version comes from rust\Cargo.toml - bump it there (and in rust\tauri.conf.json) first.
param([switch]$Publish, [string]$Notes = "")
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$version = (Select-String -Path "$root\rust\Cargo.toml" -Pattern '^version\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value
$confVersion = (Get-Content "$root\rust\tauri.conf.json" -Raw | ConvertFrom-Json).version
if ($confVersion -ne $version) { throw "Version mismatch: Cargo.toml $version, tauri.conf.json $confVersion" }
Write-Host "Version $version"

Push-Location "$root\rust"
cargo test --release
if ($LASTEXITCODE) { throw "tests failed" }
cargo build --release
if ($LASTEXITCODE) { throw "cargo build failed" }
Pop-Location

$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 not found (winget install JRSoftware.InnoSetup)" }
& $iscc /Q "/DAppVersion=$version" "$root\installer\setup.iss"
if ($LASTEXITCODE) { throw "installer build failed" }

$setup = "$root\dist\MemeForge-$version-setup.exe"
$portable = "$root\dist\MemeForge-$version-portable.exe"
Copy-Item "$root\rust\target\release\memeforge.exe" $portable -Force
Write-Host "Built $setup"

if ($Publish) {
    if (-not $Notes) { $Notes = "MemeForge $version" }
    gh release create "v$version" $setup $portable --title "MemeForge $version" --notes $Notes
    if ($LASTEXITCODE) { throw "gh release create failed" }
}
