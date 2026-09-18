param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$GeoArgs
)

$requiredVersion = [Version]'22.19.0'
$projectRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $projectRoot 'src\cli.mjs'
$nodeExecutable = $null
$systemNode = Get-Command node -ErrorAction SilentlyContinue
if ($systemNode) {
  $systemVersion = [Version]((& $systemNode.Source --version).TrimStart('v'))
  if ($systemVersion -ge $requiredVersion) { $nodeExecutable = $systemNode.Source }
}
if (-not $nodeExecutable) {
  $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $bundledNode) {
    $bundledVersion = [Version]((& $bundledNode --version).TrimStart('v'))
    if ($bundledVersion -ge $requiredVersion) { $nodeExecutable = $bundledNode }
  }
}
if (-not $nodeExecutable) { throw 'Geo-Agent requires Node.js 22.19.0 or newer.' }
& $nodeExecutable $entry @GeoArgs
exit $LASTEXITCODE
