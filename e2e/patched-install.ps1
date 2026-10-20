# Runs the README "可选：启用核心补丁" commands verbatim except for $dir (a disposable e2e directory),
# then checks that the patched source entry loads the plugin in full mode.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

$ver = ((omp --version) -split '/')[1]
$dir = Join-Path $PSScriptRoot "run-patched-$ver"
if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
New-Item -ItemType Directory -Force $dir | Out-Null
Set-Location $dir
'{ "name": "omp-patched", "private": true }' | Set-Content package.json
bun add "@oh-my-pi/pi-coding-agent@$ver" --backend=copyfile
$patch = "$repo\core-patch\omp-$ver-session-model-roles.patch"
$env:GIT_CEILING_DIRECTORIES = $dir
Push-Location node_modules\@oh-my-pi\pi-coding-agent
git apply --check $patch
git apply $patch
if (-not (Select-String -Quiet -Path src\config\settings.ts -Pattern 'setSessionModelRoles')) { throw '补丁未生效' }
Pop-Location

bun "$repo\e2e\full-mode-check.ts" "$dir\node_modules\@oh-my-pi\pi-coding-agent\src\cli.ts"
