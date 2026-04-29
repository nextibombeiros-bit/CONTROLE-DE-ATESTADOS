[CmdletBinding()]
param(
  [string]$RepoUrl = "https://github.com/nextibombeiros-bit/CONTROLE-DE-ATESTADOS.git",
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

function Assert-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Comando obrigatorio nao encontrado: $Name"
  }
}

function Invoke-Git {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
  )

  & git @Args
  if ($LASTEXITCODE -ne 0) {
    throw "Falha ao executar: git $($Args -join ' ')"
  }
}

Assert-Command git
Assert-Command node
Assert-Command npm

& git rev-parse --is-inside-work-tree | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Execute este script na raiz do repositorio."
}

& git remote get-url origin *> $null
if ($LASTEXITCODE -ne 0) {
  Invoke-Git remote add origin $RepoUrl
}

& git credential-manager configure | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Nao foi possivel configurar o Git Credential Manager."
}

Write-Host "Git Credential Manager configurado."
Write-Host "Usuario Git atual: $(git config user.name) <$(git config user.email)>"
Write-Host "Remote origin: $(git remote get-url origin)"

if (-not $SkipInstall) {
  & npm ci
  if ($LASTEXITCODE -ne 0) {
    throw "Falha ao instalar dependencias com npm ci."
  }
}

Write-Host ""
Write-Host "Comandos principais:"
Write-Host "  npm run dev"
Write-Host "  git pull"
Write-Host "  .\\scripts\\connect_git_and_push.ps1 -CommitMessage ""sua mensagem"""
