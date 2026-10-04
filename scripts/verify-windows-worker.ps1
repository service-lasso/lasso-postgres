param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'PostgreSQL verification must use an ordinary Windows token.' }
$env:TARGET_PLATFORM = 'win32'
$env:POSTGRES_VERSION = '15.17'
& $NodePath scripts/verify.mjs
exit $LASTEXITCODE
