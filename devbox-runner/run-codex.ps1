# Local devbox emulation running the Codex harness — the same runner as
# run-local.ps1, pointed at a different coding agent (HARNESS=codex).
# Run this alongside run-local.ps1 to watch a mixed fleet: both poll the same
# queue, claims are atomic server-side, and the board brands each runner by
# its harness (a name containing "codex" resolves to the OpenAI mark).
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

if (-not $env:AGENT_NAME) { $env:AGENT_NAME = 'codex-1' }
$env:HARNESS = 'codex'
$env:ENGAGEMENT = 'execution-console'
$env:MCP_SERVER = Join-Path $repo 'mcp\server.mjs'

# Codex CLI: PATH if available, else the npm global bin (npm i -g @openai/codex).
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
  $npmBin = Join-Path $env:APPDATA 'npm\codex.cmd'
  if (Test-Path $npmBin) { $env:CODEX_BIN = $npmBin }
  else { Write-Host '  codex not found — run: npm install -g @openai/codex' -ForegroundColor Red; exit 1 }
}

# Databricks CLI: PATH if available, else the WinGet install location.
if (-not (Get-Command databricks -ErrorAction SilentlyContinue)) {
  $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Databricks.DatabricksCLI_Microsoft.Winget.Source_8wekyb3d8bbwe\databricks.exe'
  if (Test-Path $winget) { $env:DATABRICKS_CLI = $winget }
}

# Codex must be logged in (`codex login`, or `codex login --with-api-key`), and
# unlike Claude it reads MCP servers from its global config rather than the
# workdir — register the console's tools once per box with:
#   codex mcp add delivery-console -- node <repo>\mcp\server.mjs
$codexExe = if ($env:CODEX_BIN) { $env:CODEX_BIN } else { 'codex' }
& $codexExe login status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '  Codex is not logged in. Run `codex login` first, then re-run this script.' -ForegroundColor Red
  Write-Host ''
  exit 1
}

Write-Host ''
Write-Host '  DELIVERY RUNNER — Codex harness' -ForegroundColor Green
Write-Host "  agent: $env:AGENT_NAME   queue: execution-console   harness: codex" -ForegroundColor DarkGray
Write-Host '  Drag a ticket into the Deploy to Agent lane to hand this runner work. Ctrl-C stops it.' -ForegroundColor DarkGray
Write-Host ''
node devbox-runner\runner.mjs
