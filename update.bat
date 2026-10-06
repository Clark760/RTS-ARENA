@echo off
chcp 65001 >nul
setlocal
title RTS Arena 更新
rem 更新平台：从 gitee 拉最新版、重装依赖、重新构建播放器，再刷新 my-bot 里的说明书和接口。bot.ts 和回放不动。

rem ---------- 检查 Node.js（23.6 以上）和 Git ----------
set NEED_NODE=0
set NEED_GIT=0
where node >nul 2>nul
if errorlevel 1 (set NEED_NODE=1) else (node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]*100+v[1]>=2306?0:1)" || set NEED_NODE=2)
where git >nul 2>nul
if errorlevel 1 set NEED_GIT=1
if not "%NEED_NODE%%NEED_GIT%"=="00" goto need_tools

rem ---------- 找平台文件夹 ----------
set "ROOT=%~dp0"
if exist "%ROOT%bin\rts-arena.js" goto have_root
set "ROOT=%~dp0rts-arena\"
if exist "%ROOT%bin\rts-arena.js" goto have_root
echo.
echo 还没有安装平台，先双击 start.bat。
echo.
pause
exit /b 1
:have_root
cd /d "%ROOT%"

rem 播放器开着的时候重装依赖会让它出错
node -e "fetch('http://127.0.0.1:5180/api/arena').then(r=>r.json()).then(j=>process.exit(Array.isArray(j.rulesets)?1:0),()=>process.exit(0))"
if errorlevel 1 goto viewer_running

rem ---------- 拉最新版 ----------
if exist ".git" goto pull
rem 直接下载压缩包装的平台没有 git 记录：接上仓库，平台自带的文件换成最新版（my-bot、replays 不受影响）
echo 第一次更新：把这个文件夹接到 gitee 仓库上……
git init -q -b master
git remote add origin https://gitee.com/mingomin/rts-arena.git
git fetch origin master
if errorlevel 1 goto pull_failed
git reset -q --hard origin/master
if errorlevel 1 goto pull_failed
git branch -q -u origin/master
goto pulled
:pull
echo 正在从 gitee 拉最新版……
git pull --ff-only origin master
if errorlevel 1 goto pull_failed
:pulled

rem ---------- 重装依赖、重新构建 ----------
call :install
if errorlevel 1 goto install_failed

rem ---------- 刷新 bot 目录里的说明书和接口 ----------
if not exist "my-bot\arena.json" goto done
cd /d "%ROOT%my-bot"
node "%ROOT%bin\rts-arena.js" init
:done
echo.
echo 更新完成。双击 start.bat 启动。
echo.
pause
exit /b 0

rem ---------- 下面是出错时的提示 ----------
:need_tools
echo.
if "%NEED_NODE%"=="1" echo   × 没找到 Node.js
if "%NEED_NODE%"=="2" echo   × Node.js 版本太旧，需要 23.6 以上
if "%NEED_GIT%"=="1" echo   × 没找到 Git for Windows
echo.
echo 马上用浏览器打开官网下载页：
if not "%NEED_NODE%"=="0" echo   Node.js：下载「LTS」版本的 Windows 安装包，一路「下一步」装好
if "%NEED_GIT%"=="1" echo   Git：下载「64-bit Git for Windows Setup」，一路「Next」装好
echo 都装好以后关掉这个窗口，重新双击 update.bat。装过了还这么提示的话，重启电脑再试。
if not "%NEED_NODE%"=="0" start "" "https://nodejs.org/zh-cn/download"
if "%NEED_GIT%"=="1" start "" "https://git-scm.com/downloads/win"
echo.
pause
exit /b 1

:viewer_running
echo.
echo 播放器还开着：先关掉 start.bat 的那个窗口，再双击 update.bat。
echo.
pause
exit /b 1

:pull_failed
echo.
echo 更新失败。常见原因：
echo   1. 网络连不上 gitee：检查网络后重新双击 update.bat。
echo   2. 改过平台自带的文件：自己的 bot 请放在 my-bot 文件夹里。
echo      想放弃对平台文件的修改，可以先把 my-bot 文件夹拷出来，删掉整个平台文件夹，
echo      重新双击 start.bat 安装，再把 my-bot 拷回去。
echo.
pause
exit /b 1

:install_failed
echo.
echo 安装依赖失败，往上翻看具体的报错。多数是网络问题，检查网络后重新双击 update.bat 即可。
echo.
pause
exit /b 1

rem ---------- 子过程：装依赖并构建，默认源失败就换国内镜像 ----------
:install
echo 正在安装依赖并构建播放器……
call npm ci --no-audit --no-fund
if not errorlevel 1 exit /b 0
echo.
echo 默认的 npm 源没装成功，换国内镜像 npmmirror 再试一次……
call npm ci --no-audit --no-fund --registry=https://registry.npmmirror.com
exit /b %errorlevel%
