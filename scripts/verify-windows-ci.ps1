$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This account setup is limited to the disposable GitHub Windows runner.' }
$workspace = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
if ($workspace -ne (Get-Location).Path) { throw 'Expected the checked-out repository workspace.' }
$account = 'lassopgverify'
$password = [Guid]::NewGuid().ToString('N') + 'aA1!'
Write-Output ('::add-mask::' + $password)
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force
$nodePath = (Get-Command node.exe).Source
$workerPath = Join-Path $workspace 'scripts\verify-windows-worker.ps1'
$credential = [PSCredential]::new(($env:COMPUTERNAME + '\' + $account), $securePassword)
$logDirectory = Join-Path $workspace 'output\verify'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stdoutFile = Join-Path $logDirectory 'windows-ci.stdout.log'
$stderrFile = Join-Path $logDirectory 'windows-ci.stderr.log'
try {
  New-LocalUser -Name $account -Password $securePassword -AccountNeverExpires -PasswordNeverExpires | Out-Null
  $usersGroup = Get-LocalGroup -SID 'S-1-5-32-545'
  Add-LocalGroupMember -Group $usersGroup -Member $account
  & icacls.exe $workspace /grant ($account + ':(OI)(CI)M') /T /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot grant verification access to the owned checkout.' }
  $arguments = @('-NoProfile', '-File', ('"' + $workerPath + '"'), '-NodePath', ('"' + $nodePath + '"'))
  $process = Start-Process -FilePath 'powershell.exe' -Credential $credential -LoadUserProfile -WorkingDirectory $workspace -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
  if ($process.ExitCode -ne 0) { throw ('Ordinary-user PostgreSQL verification failed: ' + $process.ExitCode) }
} finally {
  if (Test-Path -LiteralPath $stdoutFile) { Get-Content -LiteralPath $stdoutFile }
  if (Test-Path -LiteralPath $stderrFile) { Get-Content -LiteralPath $stderrFile }
  if (Get-LocalUser -Name $account -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $account }
}
