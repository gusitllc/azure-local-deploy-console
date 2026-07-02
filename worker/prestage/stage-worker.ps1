<#
.SYNOPSIS
  Stage a Windows base image into the Azure Local deployment worker golden image.
  Installs the full toolchain, pre-seeds the Arc module chain, clones the engine, installs Claude
  Code + VPN clients. Does NOT bake any customer secret — the Claude Code OAuth token, VPN profile,
  and Azure sign-in are supplied by the customer at first run.

.NOTES
  Run elevated on a clean Windows Server 2022 / Windows 11 base, then sysprep + snapshot.
  Idempotent: safe to re-run. See PRESTAGE.md for the full manifest.
#>
[CmdletBinding()]
param(
  [string]$EngineRepo = 'https://github.com/gusitllc/azure-local-2node-factory',
  [string]$EngineRef  = 'main',
  [string]$Root       = 'C:\worker'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Step($m){ Write-Host "== $m ==" -ForegroundColor Cyan }

New-Item -ItemType Directory -Force -Path $Root, "$Root\iso", "$Root\runs", "$Root\bin" | Out-Null

Step '1. package manager (winget/choco) + base tools'
# winget is present on modern images; fall back to direct installers where needed.
$pkgs = @('Git.Git','OpenJS.NodeJS.LTS','Python.Python.3.12','Microsoft.AzureCLI','Microsoft.PowerShell',
          'WireGuard.WireGuard','OpenVPNTechnologies.OpenVPN')
foreach($p in $pkgs){
  try { winget install --id $p --silent --accept-source-agreements --accept-package-agreements -e | Out-Null; Write-Host "  installed $p" }
  catch { Write-Warning "  winget $p failed: $($_.Exception.Message.Split([char]10)[0]) (install manually)" }
}

Step '2. python libs (pycdlib for ISO extraction without Mount-DiskImage)'
python -m pip install --upgrade pip pycdlib 2>$null | Out-Null

Step '3. wimlib-imagex (user-mode WIM edit — no admin/DISM)'
$wimZip = "$env:TEMP\wimlib.zip"
try {
  Invoke-WebRequest 'https://wimlib.net/downloads/wimlib-1.14.4-windows-x86_64-bin.zip' -OutFile $wimZip
  Expand-Archive $wimZip -DestinationPath "$Root\bin\wimlib" -Force
  Write-Host "  wimlib-imagex -> $Root\bin\wimlib"
} catch { Write-Warning "  wimlib download failed — stage manually into $Root\bin\wimlib" }

Step '4. Claude Code CLI (customer plugs their OAuth token at first run — NOT baked)'
try { npm install -g '@anthropic-ai/claude-code' | Out-Null; Write-Host '  claude-code installed' }
catch { Write-Warning "  claude-code install failed: $($_.Exception.Message.Split([char]10)[0])" }

Step '5. pre-seed the Arc onboarding module chain (zero cold-install at deploy time)'
Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force | Out-Null
Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
# Az.StackHCI must NOT be present — it clobber-blocks the EnvironmentChecker (hard-won).
if (Get-Module -ListAvailable Az.StackHCI) { Uninstall-Module Az.StackHCI -AllVersions -Force -ErrorAction SilentlyContinue }
foreach($m in 'Az.Accounts','Az.Resources','AzStackHci.EnvironmentChecker','AzSHCI.ARCInstaller'){
  if (-not (Get-Module -ListAvailable $m)) {
    try { Install-Module $m -Force -AllowClobber -Scope AllUsers; Write-Host "  seeded $m" }
    catch { Write-Warning "  $m seed failed: $($_.Exception.Message.Split([char]10)[0])" }
  }
}

Step '6. clone the engine'
if (Test-Path "$Root\engine\.git") { git -C "$Root\engine" fetch --all -q; git -C "$Root\engine" checkout $EngineRef -q; git -C "$Root\engine" pull -q }
else { git clone --branch $EngineRef $EngineRepo "$Root\engine" }
Write-Host "  engine -> $Root\engine ($EngineRef)"

Step '7. WinRM / TrustedHosts for reaching node mgmt IPs after imaging'
Enable-PSRemoting -Force -SkipNetworkProfileCheck | Out-Null
Set-Item WSMan:\localhost\Client\TrustedHosts -Value '*' -Force

Step '8. mark image staged'
@{ staged = $true; engineRef = $EngineRef; tools = @('az','node','python+pycdlib','wimlib','git','claude-code','wireguard','openvpn')
   modules = @('Az.Accounts','Az.Resources','AzStackHci.EnvironmentChecker','AzSHCI.ARCInstaller')
} | ConvertTo-Json | Set-Content "$Root\prestage.json"

Write-Host "`nDONE. Worker staged. Customer supplies at first run: Claude Code OAuth token, VPN profile, Azure sign-in." -ForegroundColor Green
Write-Host "Next: generalize + snapshot as the golden image (sysprep /generalize /oobe /shutdown)." -ForegroundColor Green
