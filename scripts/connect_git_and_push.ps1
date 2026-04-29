[CmdletBinding()]
param(
  [string]$Branch,
  [string]$CommitMessage,
  [string]$RepoUrl = $env:GITHUB_REPO_URL,
  [string]$GitHubUsername = $env:GITHUB_USERNAME,
  [string]$GitHubToken = $env:GITHUB_TOKEN
)

$ErrorActionPreference = "Stop"

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

& git rev-parse --is-inside-work-tree | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Execute este script dentro de um repositorio Git."
}

if ([string]::IsNullOrWhiteSpace($Branch)) {
  $Branch = (& git rev-parse --abbrev-ref HEAD).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Nao foi possivel detectar a branch atual."
  }
}

if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
  $CommitMessage = "update $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
}

if (-not [string]::IsNullOrWhiteSpace($RepoUrl)) {
  & git remote get-url origin *> $null
  if ($LASTEXITCODE -eq 0) {
    Invoke-Git remote set-url origin $RepoUrl
  } else {
    Invoke-Git remote add origin $RepoUrl
  }
}

Invoke-Git add --all

& git diff --cached --quiet
$hasChanges = $LASTEXITCODE -ne 0

if ($hasChanges) {
  Invoke-Git commit -m $CommitMessage
} else {
  Write-Host "Nenhuma alteracao nova para commit."
}

if (-not [string]::IsNullOrWhiteSpace($GitHubToken)) {
  if ([string]::IsNullOrWhiteSpace($GitHubUsername)) {
    throw "Defina GITHUB_USERNAME para usar GITHUB_TOKEN."
  }

  if ([string]::IsNullOrWhiteSpace($RepoUrl)) {
    throw "Defina GITHUB_REPO_URL para usar GITHUB_TOKEN."
  }

  $authUrl = "https://$GitHubUsername`:$GitHubToken@$($RepoUrl -replace '^https://', '')"
  Invoke-Git push $authUrl "HEAD:$Branch"
} else {
  Invoke-Git push -u origin $Branch
}
