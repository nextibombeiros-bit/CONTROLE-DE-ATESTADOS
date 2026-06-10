[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [string]$User = "root",
  [int]$Port = 22,
  [string]$RemotePath = "/opt/controle-de-atestados",
  [string]$IdentityFile = "",
  [switch]$SkipBootstrap,
  [switch]$SkipComposeUp
)

$ErrorActionPreference = "Stop"

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Comando obrigatorio nao encontrado: $Name"
  }
}

Assert-Command ssh
Assert-Command scp
Assert-Command tar

$archive = Join-Path $env:TEMP "controle-de-atestados-vps.tar.gz"
if (Test-Path -LiteralPath $archive) {
  Remove-Item -LiteralPath $archive -Force
}

$sshTarget = "$User@$HostName"
$sshArgs = @("-p", "$Port")
$scpArgs = @("-P", "$Port")

if ($IdentityFile) {
  $sshArgs += @("-i", $IdentityFile)
  $scpArgs += @("-i", $IdentityFile)
}

Write-Host "Gerando pacote local..."
tar `
  --exclude=".git" `
  --exclude="node_modules" `
  --exclude="dist" `
  --exclude="dist-server" `
  --exclude=".env" `
  --exclude=".env.local" `
  --exclude=".env.development" `
  --exclude=".env.production" `
  --exclude=".env.hostinger" `
  -czf $archive .

Write-Host "Preparando diretorio remoto $RemotePath..."
ssh @sshArgs $sshTarget "mkdir -p '$RemotePath'"

Write-Host "Enviando pacote..."
scp @scpArgs $archive "${sshTarget}:/tmp/controle-de-atestados-vps.tar.gz"

Write-Host "Extraindo no VPS..."
ssh @sshArgs $sshTarget "cd '$RemotePath' && tar -xzf /tmp/controle-de-atestados-vps.tar.gz && rm -f /tmp/controle-de-atestados-vps.tar.gz"

if (-not $SkipBootstrap) {
  Write-Host "Rodando bootstrap do VPS..."
  ssh @sshArgs $sshTarget "cd '$RemotePath' && bash scripts/hostinger/bootstrap_vps.sh"
}

if (-not $SkipComposeUp) {
  Write-Host "Subindo Docker Compose..."
  ssh @sshArgs $sshTarget "cd '$RemotePath' && if [ ! -f .env ]; then cp .env.hostinger.example .env; echo 'Arquivo .env criado em $RemotePath. Preencha os segredos e rode docker compose up -d --build.'; exit 2; fi && docker compose up -d --build"
}

Write-Host "Deploy enviado para ${sshTarget}:$RemotePath"
