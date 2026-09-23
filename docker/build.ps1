# 歌白（GEBAI Agent）· 服务模式镜像构建脚本（Windows PowerShell）
#
# 与 docker/build.sh 同参数、同一 Dockerfile。Docker Desktop 已就绪时直接可用。
# Dockerfile 不依赖 BuildKit；但构建器本身得可用（Docker 23+ 已废弃经典构建器、Docker 29 已移除，
# 未装 buildx 的老 Docker 需先装：Ubuntu 下 apt-get install -y docker-buildx）。
#
# 用法：
#   pwsh -File docker/build.ps1                                  # 构建 gebai:<package.json 版本>
#   pwsh -File docker/build.ps1 -Tag gebai:dev -Smoke            # 指定标签 + 冒烟自检
#   pwsh -File docker/build.ps1 -WithBrowser -NoCv               # 装浏览器、不内嵌本地 CV
#   pwsh -File docker/build.ps1 -Push -Tag registry.example.com/gebai:0.1.0
[CmdletBinding()]
param(
  [string]$Tag = "",
  [switch]$WithBrowser,
  [switch]$NoCv,
  [string]$CvModelBase = "",
  [string]$Target = "",
  [string]$Platform = "",
  [switch]$NoCache,
  [switch]$Push,
  [switch]$Smoke
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "未找到 docker 命令" }

  if (-not $Tag) {
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $Tag = "gebai:$version"
  }

  $withCv = if ($NoCv) { "0" } else { "1" }
  $withBrowser = if ($WithBrowser) { "1" } else { "0" }

  $buildArgs = @(
    "--build-arg", "WITH_CV=$withCv",
    "--build-arg", "WITH_BROWSER=$withBrowser"
  )
  if ($Target) { $buildArgs += @("--build-arg", "BUN_TARGET=$Target") }
  if ($CvModelBase) { $buildArgs += @("--build-arg", "CV_MODEL_BASE=$CvModelBase") }
  if ($Platform) { $buildArgs += @("--platform", $Platform) }
  if ($NoCache) { $buildArgs += "--no-cache" }

  # buildx 优先（同时支持 --platform/--push）；未装则退回 docker build
  $builder = @("buildx", "build")
  docker buildx version *> $null
  if ($LASTEXITCODE -ne 0) {
    $builder = @("build")
    Write-Host "提示：未检测到 buildx。若本机 Docker 已移除经典构建器，需先安装 buildx（Ubuntu: apt-get install -y docker-buildx）"
  } elseif (-not $Push) {
    $buildArgs += "--load"      # buildx 默认只构建不入库
  }
  if ($Push) { $buildArgs += "--push" }

  Write-Host "==> 构建镜像 $Tag"
  Write-Host "    上下文：$repoRoot（.dockerignore 已排除 node_modules/dist/resources/infer/vendor 等）"
  Write-Host "    参数：WITH_CV=$withCv WITH_BROWSER=$withBrowser"

  & docker @builder -f Dockerfile -t $Tag @buildArgs .
  if ($LASTEXITCODE -ne 0) { throw "docker build 失败（退出码 $LASTEXITCODE）" }

  Write-Host "==> 完成：$Tag"
  docker images --filter "reference=$Tag" --format "    大小：{{.Size}}（{{.Repository}}:{{.Tag}}）"

  if ($Smoke) {
    $name = "gebai-smoke-$PID"
    $vol = "gebai-smoke-$PID"
    try {
      Write-Host "==> 冒烟自检：起容器（卷 $vol → /data）"
      docker volume create $vol | Out-Null
      docker run -d --name $name -e GEBAI_SCHEDULER=off -v "${vol}:/data" $Tag | Out-Null

      Write-Host -NoNewline "    健康检查 /api/health … "
      $ok = $false
      foreach ($i in 1..30) {
        $out = docker exec $name curl -fsS http://127.0.0.1:3000/api/health 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { Write-Host "OK  $out"; $ok = $true; break }
        Start-Sleep -Seconds 1
      }
      if (-not $ok) {
        Write-Host "失败"
        Write-Host "----- 容器日志（末尾 60 行）-----"
        docker logs --tail 60 $name 2>&1
        Write-Host "-------------------------------"
        throw "冒烟自检失败"
      }

      $code = docker exec $name curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/
      Write-Host "    Web UI / … HTTP $code"

      Write-Host -NoNewline "    脚本文件系统隔离（user namespace）… "
      docker exec $name unshare --user --map-root-user echo ok *> $null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "可用（bwrap 文件系统隔离生效）"
      } else {
        Write-Host "不可用（自动降级为环境收敛，见 docker/README.md）"
      }
      Write-Host "==> 冒烟通过；容器与卷将清理"
    } finally {
      docker rm -f $name *> $null
      docker volume rm $vol *> $null
    }
  }

  Write-Host ""
  Write-Host "后续步骤："
  Write-Host "  docker run -d --name gebai -p 3000:3000 -v gebai-data:/data -e GEBAI_LLM_API_KEY=… $Tag"
  Write-Host "  配置/登录/能力边界见 docker/README.md"
} finally {
  Pop-Location
}
