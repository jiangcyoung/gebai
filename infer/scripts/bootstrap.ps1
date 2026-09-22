# bootstrap.ps1 — infer 子项目环境自检
# 用法: powershell -File infer/scripts/bootstrap.ps1 [-Json]
# 输出本机硬件基线 + 引擎/模型就绪度；-Json 时写 config/hardware.json 并打印 JSON

param([switch]$Json)

$ErrorActionPreference = 'Continue'
$Root   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # infer/
$Repo   = Split-Path -Parent $Root                                              # 仓库根
$Models = Join-Path $Repo 'resources\models\infer'

function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red }

# ---------- GPU ----------
Section 'GPU'
$gpu = @{}
$smi = & nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version,compute_cap --format=csv,noheader 2>$null
if ($LASTEXITCODE -eq 0 -and $smi) {
    $f = ($smi | Select-Object -First 1) -split ',\s*'
    $gpu = [ordered]@{
        name        = $f[0]
        vram_total  = [int]($f[1] -replace '\D','')
        vram_used   = [int]($f[2] -replace '\D','')
        driver      = $f[3]
        compute_cap = $f[4]
    }
    Ok "$($gpu.name) | VRAM $($gpu.vram_total)MiB (已用 $($gpu.vram_used)MiB) | 驱动 $($gpu.driver) | CC $($gpu.compute_cap)"
} else {
    Bad 'nvidia-smi 不可用'
}

# ---------- CPU / 内存 ----------
Section 'CPU / 内存'
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$ramBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
$ramGB = [math]::Round($ramBytes / 1GB, 1)
Ok "$($cpu.Name.Trim()) | $($cpu.NumberOfCores)C/$($cpu.NumberOfLogicalProcessors)T"
Ok "物理内存 ${ramGB}GB"
if ($ramGB -lt 24) { Warn '内存偏小：35B MoE 异构推理建议 ≥24GB' }
$os = (Get-CimInstance Win32_OperatingSystem)
$freeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
Ok "当前可用内存 ${freeGB}GB"

# ---------- 磁盘 ----------
Section '磁盘'
$d = Get-PSDrive C
$free = [math]::Round($d.Free / 1GB, 1)
if ($free -lt 50) { Warn "C: 剩余 ${free}GB 偏紧（模型+量化工作区建议 ≥80GB）" } else { Ok "C: 剩余 ${free}GB" }

# ---------- 引擎 ----------
Section 'llama.cpp 引擎'
$engineExe = Get-ChildItem (Join-Path $Root 'vendor') -Recurse -Filter 'llama-server.exe' -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($engineExe) {
    Ok "llama-server: $($engineExe.FullName)"
    $ver = & $engineExe.FullName --version 2>&1 | Select-String -Pattern 'version|build' | Select-Object -First 2
    if ($ver) { $ver | ForEach-Object { Write-Host "         $($_.ToString().Trim())" } }
    # 后端能力探测
    $gpuInfo = & $engineExe.FullName --list-devices 2>&1
    $gpuInfo | Select-Object -First 12 | ForEach-Object { Write-Host "         $($_.ToString().Trim())" }
} else {
    Bad '未找到 llama-server.exe（先把预编译包解压到 infer/vendor/）'
}

# ---------- 模型 ----------
Section '模型权重'
if (Test-Path $Models) {
    $gguf = Get-ChildItem $Models -Filter '*.gguf' -ErrorAction SilentlyContinue
    if ($gguf) {
        foreach ($g in $gguf) { Ok ("{0}  {1:N2} GB" -f $g.Name, ($g.Length / 1GB)) }
    } else { Warn "尚无 .gguf：$Models" }
    $inc = Get-ChildItem $Models -Filter '*.incomplete' -ErrorAction SilentlyContinue
    if ($inc) { Warn "有未完成下载：$($inc.Count) 个（.incomplete）" }
} else { Bad "模型目录不存在：$Models" }

# ---------- 构建工具链（仅自建 fork 需要） ----------
Section '构建工具链（自建 fork 才需要）'
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $inst = & $vswhere -products * -format json 2>$null | ConvertFrom-Json
    foreach ($i in $inst) {
        $hasVCTools = Test-Path (Join-Path $i.installationPath 'VC\Tools\MSVC')
        $msvcVer = if ($hasVCTools) { (Get-ChildItem (Join-Path $i.installationPath 'VC\Tools\MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name } else { '-' }
        Ok "$($i.displayName) @ $($i.installationPath) | MSVC $msvcVer"
    }
} else { Warn 'vswhere 不可用' }
$nvcc = Get-Command nvcc -ErrorAction SilentlyContinue
if ($nvcc) {
    $nv = (& nvcc --version 2>&1 | Select-String 'release') -join ''
    Ok "nvcc: $($nv.Trim())"
    Warn 'CUDA 12.9 的 nvcc 仅支持 MSVC ≤2022；自建 CUDA 版需 VS2022 生成工具或免安装 clang-cl'
} else { Warn 'nvcc 不在 PATH' }

# ---------- 汇总 ----------
$report = [ordered]@{
    generated_at = (Get-Date).ToString('s')
    gpu          = $gpu
    cpu          = [ordered]@{ name = $cpu.Name.Trim(); cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors }
    ram_gb       = $ramGB
    disk_free_gb = $free
    engine_path  = if ($engineExe) { $engineExe.FullName } else { $null }
    models_dir   = $Models
}
$cfgDir = Join-Path $Root 'config'
if (-not (Test-Path $cfgDir)) { New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null }
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $cfgDir 'hardware.json')
if ($Json) { $report | ConvertTo-Json -Depth 6 }
else { Write-Host "`n硬件基线已写入 config/hardware.json" -ForegroundColor Cyan }
