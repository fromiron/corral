param([string]$Configuration)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Configuration)) | ConvertFrom-Json
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-job.cs')
  $code = [CorralOwnedJob]::Run($config.executable, [string[]]$config.args, $config.cwd, $config.status, $config.ownerPid, [long]$config.ownerCreationTime)
  exit $code
} catch {
  [Console]::Error.WriteLine('Corral could not establish or complete owned process execution.')
  exit 1
}
