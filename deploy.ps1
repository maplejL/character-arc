# CharacterArc Web — 远程部署脚本（参考 language-learning/tools/deploy.ps1）
# Usage:
#   .\deploy.ps1
#   .\deploy.ps1 124.222.218.97 ubuntu <password> [ssh-port]
#   .\deploy.ps1 -SkipBuild   # 仅上传 + 重启（已 build 过）

param(
    [string]$Ip = "",
    [string]$User = "",
    [string]$Password = "",
    [int]$Port = 0,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$toolsDir = Join-Path $root "tools"
$webDist = Join-Path $root "web\dist"
$serverDir = Join-Path $root "server"
$serverDist = Join-Path $serverDir "dist"
$serverMigrations = Join-Path $serverDir "migrations"
$serverPkg = Join-Path $serverDir "package.json"

# pscp/plink：优先本仓库 tools，其次 language-learning 仓库
$llTools = "E:\ai\aiStudy\languageLearning\tools"
$pscp = @(
    (Join-Path $toolsDir "pscp.exe"),
    (Join-Path $llTools "pscp.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$plink = @(
    (Join-Path $toolsDir "plink.exe"),
    (Join-Path $llTools "plink.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $pscp -or -not $plink) {
    throw "pscp/plink not found. Copy from languageLearning/tools/ to character-arc/tools/"
}

if (-not $Ip) { $Ip = Read-Host "Server IP (default 124.222.218.97)"; if (-not $Ip) { $Ip = "124.222.218.97" } }
if (-not $User) { $User = Read-Host "User (default ubuntu)"; if (-not $User) { $User = "ubuntu" } }
if (-not $Password) { $Password = Read-Host "Password" }
if ($Port -le 0) { $p = Read-Host "SSH Port (default 22)"; $Port = if ($p) { [int]$p } else { 22 } }

$conn = "${User}@${Ip}"
$remoteRoot = "/opt/character-arc"

function Invoke-Remote([string]$Cmd, [string]$Desc) {
    Write-Host "  $Desc" -ForegroundColor Gray
    & $plink -pw $Password -P $Port -batch $conn $Cmd 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw "Remote command failed ($LASTEXITCODE): $Desc" }
}

function Invoke-Remote-Soft([string]$Cmd, [string]$Desc) {
    Write-Host "  $Desc" -ForegroundColor Gray
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $plink -pw $Password -P $Port -batch $conn $Cmd 2>&1 | ForEach-Object { Write-Host $_ }
    $ErrorActionPreference = $prev
}

function Upload-File([string]$Local, [string]$Remote) {
    & $pscp -pw $Password -P $Port $Local "${conn}:${Remote}"
    if ($LASTEXITCODE -ne 0) { throw "Upload failed: $Local -> $Remote" }
}

function Upload-Dir([string]$LocalDir, [string]$RemoteDir) {
    & $pscp -pw $Password -P $Port -r "$LocalDir\*" "${conn}:${RemoteDir}/"
    if ($LASTEXITCODE -ne 0) { throw "Upload dir failed: $LocalDir -> $RemoteDir" }
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  CharacterArc Web Deploy -> ${Ip}:${Port}" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

if (-not $SkipBuild) {
    Write-Host ""
    Write-Host "[build] web..." -ForegroundColor Yellow
    Push-Location (Join-Path $root "web")
    pnpm run build:deploy
    if ($LASTEXITCODE -ne 0) { throw "web build failed" }
    Pop-Location

    Write-Host "[build] electron AI tasks (.js for server runtime)..." -ForegroundColor Yellow
    node (Join-Path $root "tools/emit-electron-ai.mjs")
    if ($LASTEXITCODE -ne 0) { throw "electron AI emit failed" }
    Write-Host "       OK" -ForegroundColor Green

    Write-Host "[build] server..." -ForegroundColor Yellow
    # 生产环境用 tsx 跑 server/src，本地 tsc 会因 electron 跨目录引用失败；仅确保占位 dist 存在
    if (-not (Test-Path $serverDist)) { New-Item -ItemType Directory -Force -Path $serverDist | Out-Null }
    if (-not (Test-Path (Join-Path $serverDist "index.js"))) {
        Set-Content -Path (Join-Path $serverDist "index.js") -Value "export {}"
    }
    Write-Host "       skipped (production uses tsx src/)" -ForegroundColor Green
}

if (-not (Test-Path $webDist)) { throw "Missing $webDist — run build first" }
if (-not (Test-Path $serverDist)) {
    New-Item -ItemType Directory -Force -Path $serverDist | Out-Null
    Set-Content -Path (Join-Path $serverDist "index.js") -Value "export {}"
}

Write-Host ""
Write-Host "[1/9] Remote directories..." -ForegroundColor Yellow
Invoke-Remote "sudo mkdir -p $remoteRoot/dist $remoteRoot/server/dist $remoteRoot/server/migrations $remoteRoot/data/users && sudo chown -R `$USER:`$USER $remoteRoot" "mkdir"
Write-Host "       OK" -ForegroundColor Green

Write-Host "[2/9] Server scripts..." -ForegroundColor Yellow
Upload-File (Join-Path $toolsDir "startup.sh") "$remoteRoot/startup.sh"
Upload-File (Join-Path $toolsDir "patch-nginx-character-arc.sh") "$remoteRoot/patch-nginx-character-arc.sh"
Upload-File (Join-Path $toolsDir "patch-nginx-character-arc.py") "$remoteRoot/patch-nginx-character-arc.py"
Upload-File (Join-Path $toolsDir "character_arc_nginx_snippet.py") "$remoteRoot/character_arc_nginx_snippet.py"
Upload-File (Join-Path $toolsDir "patch-nginx-character-arc-upgrade.py") "$remoteRoot/patch-nginx-character-arc-upgrade.py"
Upload-File (Join-Path $toolsDir "patch-nginx-character-arc-redirect.py") "$remoteRoot/patch-nginx-character-arc-redirect.py"
Invoke-Remote "chmod +x $remoteRoot/startup.sh $remoteRoot/patch-nginx-character-arc.sh" "chmod"
Write-Host "       OK" -ForegroundColor Green

Write-Host "[3/9] Web dist..." -ForegroundColor Yellow
Invoke-Remote "rm -rf $remoteRoot/dist/assets && mkdir -p $remoteRoot/dist/assets" "clean web assets"
Upload-File "$webDist\index.html" "$remoteRoot/dist/index.html"
if (Test-Path "$webDist\assets") {
    Get-ChildItem "$webDist\assets\*" | ForEach-Object {
        Upload-File $_.FullName "$remoteRoot/dist/assets/$($_.Name)"
    }
}
Write-Host "       OK" -ForegroundColor Green

Write-Host "[4/9] Server dist + migrations + AI runtime..." -ForegroundColor Yellow
Invoke-Remote "rm -rf $remoteRoot/server/dist $remoteRoot/server/src && mkdir -p $remoteRoot/server/dist $remoteRoot/server/migrations $remoteRoot/server/src $remoteRoot/electron/main $remoteRoot/electron/shared $remoteRoot/resources/skills" "clean server dirs"
Upload-File $serverPkg "$remoteRoot/server/package.json"
Upload-Dir $serverMigrations "$remoteRoot/server/migrations"
Upload-Dir $serverDist "$remoteRoot/server/dist"
Upload-Dir (Join-Path $serverDir "src") "$remoteRoot/server/src"
Upload-Dir (Join-Path $root "electron/main") "$remoteRoot/electron/main"
Upload-Dir (Join-Path $root "electron/shared") "$remoteRoot/electron/shared"
Upload-Dir (Join-Path $root "resources/skills") "$remoteRoot/resources/skills"
Write-Host "       OK" -ForegroundColor Green

Write-Host "[5/9] Restart API..." -ForegroundColor Yellow
& $plink -pw $Password -P $Port -batch $conn "bash $remoteRoot/startup.sh" 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { throw "startup.sh failed" }
Write-Host "       OK" -ForegroundColor Green

Write-Host "[6/9] API health (remote)..." -ForegroundColor Yellow
Invoke-Remote "curl -sf http://127.0.0.1:8010/health && echo" "health check"
Write-Host "       OK" -ForegroundColor Green

Write-Host "[7/9] Patch nginx (skip if already routed)..." -ForegroundColor Yellow
# 站点文件名历史为 language-learning，服务器重构后为 main.conf；自动探测
$sitePath = (& $plink -pw $Password -P $Port -batch $conn "for f in /etc/nginx/sites-enabled/language-learning /etc/nginx/sites-enabled/main.conf; do [ -f `$f ] && echo `$f && break; done" | Select-Object -First 1)
$sitePath = "$sitePath".Trim()
if (-not $sitePath) { throw "nginx site config not found (language-learning/main.conf)" }
# character-arc 路由已存在时跳过补丁（补丁脚本对 main.conf 结构非幂等，重复跑会破坏配置）
$routeCount = [int]((& $plink -pw $Password -P $Port -batch $conn "grep -c character-arc $sitePath || true") | Select-Object -First 1)
if ($routeCount -gt 0) {
    Write-Host "       already routed in $sitePath - skip" -ForegroundColor Green
} else {
    Invoke-Remote "sudo cp $sitePath /tmp/character-arc-site.bak.`$(date +%Y%m%d%H%M%S)" "backup nginx"
    Invoke-Remote "sudo bash $remoteRoot/patch-nginx-character-arc.sh $sitePath" "patch nginx"
    Invoke-Remote "sudo python3 $remoteRoot/patch-nginx-character-arc-upgrade.py $sitePath" "upgrade nginx limits/gzip"
    Invoke-Remote "sudo python3 $remoteRoot/patch-nginx-character-arc-redirect.py $sitePath" "patch nginx redirect"
    Write-Host "       patched" -ForegroundColor Green
}

Write-Host "[8/9] nginx -t..." -ForegroundColor Yellow
Invoke-Remote-Soft "sudo nginx -t" "nginx test"
Write-Host "       OK" -ForegroundColor Green

Write-Host "[9/9] Reload nginx..." -ForegroundColor Yellow
Invoke-Remote "sudo systemctl reload nginx" "reload nginx"
Write-Host "       OK" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Deploy complete!" -ForegroundColor Green
Write-Host "  https://${Ip}/character-arc/" -ForegroundColor Cyan
Write-Host "  API health: https://${Ip}/api/character-arc/v1/... (via nginx)" -ForegroundColor Gray
Write-Host "  Logs: $remoteRoot/app.log" -ForegroundColor Gray
Write-Host "  Admin: admin@characterarc.local / 123456" -ForegroundColor Gray
Write-Host "  Admin AI (OpenCode): deepseek-v4-flash @ https://opencode.ai/zen/go (seed on first login)" -ForegroundColor Gray
Write-Host "  Invite: CHARARC-BETA (seed)" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
