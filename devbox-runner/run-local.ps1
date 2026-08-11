# Local devbox emulation — run this (or let Claude pop it in a new window),
# then drag tickets into the Deploy to Agent lane and watch them get worked.
# Loops until Ctrl-C; each task gets its own workdir under ~\agent-work.
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

$env:AGENT_NAME = 'local-emu'
$env:ENGAGEMENT = 'execution-console'
$env:MCP_SERVER = Join-Path $repo 'mcp\server.mjs'

# Databricks CLI: PATH if available, else the WinGet install location.
if (-not (Get-Command databricks -ErrorAction SilentlyContinue)) {
  $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Databricks.DatabricksCLI_Microsoft.Winget.Source_8wekyb3d8bbwe\databricks.exe'
  if (Test-Path $winget) { $env:DATABRICKS_CLI = $winget }
}

# Validated permission set: file edits, git/gh/build commands, and the
# delivery-console MCP tools so Claude posts progress and can raise flags.
$env:CLAUDE_ARGS = '--permission-mode acceptEdits --allowedTools Write,Edit,Bash(git:*),Bash(gh:*),Bash(curl:*),Bash(node:*),Bash(npm:*),mcp__delivery-console__*'

Write-Host ''
Write-Host '  DELIVERY RUNNER — local devbox emulation' -ForegroundColor Cyan
Write-Host "  agent: local-emu   queue: execution-console" -ForegroundColor DarkGray
Write-Host '  Drag a ticket into the Deploy to Agent lane to hand this runner work. Ctrl-C stops it.' -ForegroundColor DarkGray
Write-Host ''
node devbox-runner\runner.mjs
