$ErrorActionPreference = 'Stop'
$src     = 'D:\3d-desk-pet'
$app     = Join-Path $src 'pet-app'
$outRoot = 'C:\Users\Administrator\Desktop\其他'
$dest    = Join-Path $outRoot '3D桌宠'

Write-Host '==> 1/7 准备目录' -ForegroundColor Cyan
if (-not (Test-Path $outRoot)) { New-Item -ItemType Directory -Path $outRoot -Force | Out-Null }
if (Test-Path $dest) {
    $bak = $dest + '.old-' + (Get-Date -Format 'HHmmss')
    Rename-Item -LiteralPath $dest -NewName (Split-Path $bak -Leaf) -Force
    Write-Host "    旧版本已重命名为 $(Split-Path $bak -Leaf)" -ForegroundColor DarkGray
}
New-Item -ItemType Directory -Path $dest -Force | Out-Null

Write-Host '==> 2/7 复制 Electron 运行时 (259 MB)' -ForegroundColor Cyan
$null = robocopy (Join-Path $app 'node_modules\electron\dist') $dest /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1
if ($LASTEXITCODE -ge 8) { throw "复制 Electron 失败，代码 $LASTEXITCODE" }

Write-Host '==> 3/7 建立 resources\app' -ForegroundColor Cyan
$appDir = Join-Path $dest 'resources\app'
if (Test-Path (Join-Path $dest 'resources\default_app.asar')) {
    Remove-Item (Join-Path $dest 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $appDir -Force | Out-Null

Write-Host '==> 4/7 复制应用代码' -ForegroundColor Cyan
$null = robocopy $app $appDir /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 /XD node_modules '.shots' /XF make-icon.js package-lock.json
if ($LASTEXITCODE -ge 8) { throw "复制应用代码失败，代码 $LASTEXITCODE" }

Write-Host '==> 5/7 复制运行依赖' -ForegroundColor Cyan
$null = robocopy (Join-Path $app 'node_modules') (Join-Path $appDir 'node_modules') /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 /XD electron '.bin'
if ($LASTEXITCODE -ge 8) { throw "复制依赖失败，代码 $LASTEXITCODE" }

Write-Host '==> 6/7 复制网页资源' -ForegroundColor Cyan
foreach ($item in @('robot-pet-3d.html','robot-pet.html','index.html','styles.css','js','vendor','tray.png','README.md')) {
    $p = Join-Path $src $item
    if (Test-Path $p) {
        if ((Get-Item $p).PSIsContainer) {
            $null = robocopy $p (Join-Path $appDir $item) /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1
        } else {
            Copy-Item $p (Join-Path $appDir $item) -Force
        }
    } else {
        Write-Host "    跳过（不存在）: $item" -ForegroundColor DarkGray
    }
}

Write-Host '==> 7/7 重命名主程序' -ForegroundColor Cyan
$exe = Join-Path $dest 'electron.exe'
if (Test-Path $exe) { Rename-Item $exe '3D桌宠.exe' -Force }

$total = (Get-ChildItem $dest -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum)
Write-Host ''
Write-Host '--- 打包完成 ---' -ForegroundColor Green
Write-Host ("输出目录: " + $dest)
Write-Host ("总大小  : {0:N1} MB / {1} 个文件" -f ($total.Sum/1MB), $total.Count)
Write-Host ("主程序  : " + (Join-Path $dest '3D桌宠.exe'))
