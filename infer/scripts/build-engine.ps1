# build-engine.ps1 — 自建 llama.cpp 引擎
# 用法:
#   powershell -File infer/scripts/build-engine.ps1 -Backend cpu
#   powershell -File infer/scripts/build-engine.ps1 -Backend cuda -Jobs 16
#
# 背景：本机无管理员权限，且 CMake 4.0.2 不识别 VS18(2026) generator → 统一走 Ninja + 显式 vcvars。
#       CUDA 后端另有约束：CUDA 12.9 的 nvcc 只接受 MSVC ≤2022，故 CUDA_HOST_COMPILER 需指向
#       VS2022 或 clang-cl（脚本自动探测并给出明确报错，不自作主张）。

param(
    [ValidateSet('cpu','cuda','vulkan')] [string]$Backend = 'cpu',
    [string]$SourceDir = '',
    [int]   $Jobs = 0,
    [switch]$Clean,
    [switch]$ConfigureOnly
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $SourceDir) {
    $cand = Get-ChildItem $Root -Directory -Filter 'llama.cpp-*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cand) { throw "未找到 llama.cpp 源码目录（engine/llama.cpp-*）" }
    $SourceDir = $cand.FullName
}
if (-not (Test-Path (Join-Path $SourceDir 'CMakeLists.txt'))) { throw "源码目录无效: $SourceDir" }
if ($Jobs -le 0) { $Jobs = [int]((Get-CimInstance Win32_Processor | Select-Object -First 1).NumberOfLogicalProcessors * 0.75) }

$buildDir = Join-Path $SourceDir "build-$Backend"
if ($Clean -and (Test-Path $buildDir)) { Remove-Item $buildDir -Recurse -Force }

# ---------- 工具链探测 ----------
function Find-VcVars {
    $cands = @()
    # 优先 VS2022（CUDA 兼容区间），再 VS2026
    foreach ($ver in @('2022','18')) {
        foreach ($base in @('C:\Program Files\Microsoft Visual Studio','C:\Program Files (x86)\Microsoft Visual Studio')) {
            $cands += Join-Path $base "$ver\*\VC\Auxiliary\Build\vcvars64.bat"
        }
        $cands += "C:\Program Files (x86)\Microsoft Visual Studio\$ver\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    }
    foreach ($c in $cands) {
        $hit = Get-Item $c -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}
function Find-Ninja {
    $n = Get-Command ninja -ErrorAction SilentlyContinue
    if ($n) { return $n.Source }
    foreach ($p in @("$env:LOCALAPPDATA\Programs\Python\Python312\Scripts\ninja.exe", "$env:APPDATA\Python\Python312\Scripts\ninja.exe")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

$vcvars = Find-VcVars
$ninja  = Find-Ninja
Write-Host "后端     : $Backend"       -ForegroundColor Cyan
Write-Host "源码     : $SourceDir"
Write-Host "构建目录 : $buildDir"
Write-Host "vcvars   : $(if ($vcvars) { $vcvars } else { '未找到！' })"
Write-Host "ninja    : $(if ($ninja) { $ninja } else { '未找到！' })"
$clHost = $null
if ($vcvars) {
    $vroot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $vcvars))   # .../VC/Auxiliary/Build -> VC
    $clx = Get-ChildItem (Join-Path $vroot 'Tools\MSVC\*\bin\Hostx64\x64\cl.exe') -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    $clHost = $clx.FullName
    Write-Host "宿主 cl  : $clHost"
}
if (-not $vcvars -or -not $ninja) { throw '构建工具链不完整（需要 vcvars64.bat 与 ninja）' }

# ---------- CUDA 兼容性门禁 ----------
$cmakeArgs = @(
    '-G','Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DLLAMA_CURL=OFF',
    '-DLLAMA_BUILD_TESTS=OFF',
    '-DLLAMA_BUILD_EXAMPLES=ON',
    '-DLLAMA_BUILD_SERVER=ON'
)
switch ($Backend) {
    'cpu'    { $cmakeArgs += '-DGGML_CUDA=OFF' }
    'vulkan' { $cmakeArgs += @('-DGGML_VULKAN=ON') }
    'cuda'   {
        # nvcc 宿主编译器门禁：MSVC 主版本必须在 2017..2022
        $msvcVer = ($clHost -split '\\MSVC\\')[1].Split('\')[0]
        $major = [int]($msvcVer.Split('.')[0])
        Write-Host "MSVC 版本: $msvcVer" -ForegroundColor Yellow
        if ($major -gt 14 -or ($major -eq 14 -and [int]($msvcVer.Split('.')[1]) -ge 50)) {
            Write-Host '  检测到 MSVC >= 14.50（VS2026）：CUDA 12.9 的 nvcc 会拒绝该宿主编译器。' -ForegroundColor Red
            Write-Host '  需要：① VS2022 生成工具（vcvars 指过去），或 ② clang-cl，或 ③ 升级 CUDA+驱动。' -ForegroundColor Red
            Write-Host '  继续将不可避免地失败；请先解决宿主编译器。' -ForegroundColor Red
            if (-not $env:GEBAI_INFER_FORCE_CUDA_BUILD) { throw 'CUDA 宿主编译器不兼容（设 GEBAI_INFER_FORCE_CUDA_BUILD=1 可强制尝试）' }
        }
        $cudaRoot = Join-Path $env:ProgramFiles 'NVIDIA GPU Computing Toolkit\CUDA'
        $cudaVer = Get-ChildItem $cudaRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
        if (-not $cudaVer) { throw '未找到 CUDA Toolkit' }
        $cmakeArgs += @(
            '-DGGML_CUDA=ON',
            '-DCMAKE_CUDA_ARCHITECTURES=89',
            "-DCMAKE_CUDA_COMPILER=$(Join-Path $cudaVer.FullName 'bin\nvcc.exe')",
            "-DCMAKE_CUDA_HOST_COMPILER=$clHost"
        )
        Write-Host "CUDA     : $($cudaVer.Name)" -ForegroundColor Cyan
    }
}

# ---------- 生成并执行 bat（vcvars 必须在 cmd 环境生效） ----------
$bat = Join-Path $env:TEMP "gebai-build-$Backend.bat"
$lines = @(
    '@echo off',
    "call `"$vcvars`" >nul 2>&1",
    "set PATH=%PATH%;$(Split-Path $ninja -Parent)",
    "cd /d `"$SourceDir`"",
    "cmake -B `"$buildDir`" $($cmakeArgs -join ' ')"
)
if (-not $ConfigureOnly) { $lines += "cmake --build `"$buildDir`" -j $Jobs" }
$lines += 'echo BUILD_EXIT=%ERRORLEVEL%'
$lines | Set-Content -Encoding ASCII $bat

Write-Host "`n执行: $bat" -ForegroundColor DarkGray
& cmd.exe /c $bat 2>&1 | ForEach-Object { Write-Host "  $_" }

$exe = Join-Path $buildDir 'bin\llama-server.exe'
if (Test-Path $exe) {
    Write-Host "`n构建成功: $exe" -ForegroundColor Green
    & $exe --version 2>&1 | Select-Object -First 3 | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "`n未产出 llama-server.exe（检查上方输出）" -ForegroundColor Red
    exit 1
}
