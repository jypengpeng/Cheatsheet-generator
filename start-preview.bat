@echo off
setlocal enabledelayedexpansion

rem 切换到脚本所在目录（项目根）
cd /d "%~dp0"

rem 检查 Node.js / npm 是否可用
where node >nul 2>&1
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 https://nodejs.org/
  pause
  exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
  echo 未检测到 npm，请确认 Node.js 安装包含 npm。
  pause
  exit /b 1
)

echo 安装依赖（如已安装将跳过）...
call npm install
if errorlevel 1 (
  echo 依赖安装失败。
  pause
  exit /b 1
)

echo 构建生产产物...
call npm run build
if errorlevel 1 (
  echo 构建失败。
  pause
  exit /b 1
)

echo 预览构建结果（Vite Preview，默认端口 4173）...
rem 并行延迟 2 秒后自动打开浏览器
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:4173"

call npm run preview

echo 预览服务器已退出。按任意键关闭窗口...
pause >nul


