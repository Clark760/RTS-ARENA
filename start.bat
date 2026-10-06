@echo off
chcp 65001 >nul
setlocal
title RTS Arena
rem 一键安装并启动：检查 Node.js 和 Git，第一次运行时下载平台、装依赖、建 bot 目录，然后打开网页播放器。
rem 本文件放在平台文件夹里，或者单独放在任意文件夹（会把平台下载到旁边的 rts-arena 文件夹）都可以。

rem ---------- 检查 Node.js（23.6 以上）和 Git ----------
set NEED_NODE=0
set NEED_GIT=0
where node >nul 2>nul
if errorlevel 1 (set NEED_NODE=1) else (node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]*100+v[1]>=2306?0:1)" || set NEED_NODE=2)
where git >nul 2>nul
if errorlevel 1 set NEED_GIT=1
if not "%NEED_NODE%%NEED_GIT%"=="00" goto need_tools

rem ---------- 找平台文件夹，没有就下载 ----------
set "ROOT=%~dp0"
if exist "%ROOT%bin\rts-arena.js" goto have_root
set "ROOT=%~dp0rts-arena\"
if exist "%ROOT%bin\rts-arena.js" goto have_root
if exist "%ROOT%" goto broken_root
echo 第一次运行：从 gitee 下载平台到 %ROOT%
git clone https://gitee.com/mingomin/rts-arena.git "%~dp0rts-arena"
if errorlevel 1 goto clone_failed
:have_root
cd /d "%ROOT%"

rem ---------- 装依赖、构建播放器 ----------
if exist "node_modules\.package-lock.json" if exist "dist\viewer\index.html" goto installed
call :install
if errorlevel 1 goto install_failed
:installed

rem ---------- 注册 rts-arena 命令（给大模型 agent 和命令行用） ----------
where rts-arena >nul 2>nul
if not errorlevel 1 goto have_cmd
echo 注册命令 rts-arena ……
call npm install -g . --no-audit --no-fund
if errorlevel 1 echo 注册命令没成功，不影响网页使用；需要时在 %ROOT% 里手动运行 npm install -g .
:have_cmd

rem ---------- 自己的 bot 目录 ----------
if exist "my-bot\arena.json" goto have_bot
node bin\rts-arena.js init annihilation my-bot
if errorlevel 1 goto install_failed
:have_bot

echo.
echo ============================================================
echo  你的 bot 目录：%ROOT%my-bot
echo    bot.ts      你的 bot，交给大模型改，或者自己写
echo    PROMPT.md   给大模型看的说明书
echo  让大模型 agent 在这个目录里干活，它会用 rts-arena check、run 这些命令。
echo  更新平台：先关掉这个窗口，再双击 %ROOT%update.bat
echo ============================================================
echo.
echo 正在启动播放器，浏览器会自动打开 http://127.0.0.1:5180/
echo 用的时候别关这个窗口，关掉播放器就停了。
echo.
cd /d "%ROOT%my-bot"
node "%ROOT%bin\rts-arena.js" view --open
if not errorlevel 1 exit /b 0
pause
exit /b 1

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
echo 都装好以后关掉这个窗口，重新双击 start.bat。装过了还这么提示的话，重启电脑再试。
if not "%NEED_NODE%"=="0" start "" "https://nodejs.org/zh-cn/download"
if "%NEED_GIT%"=="1" start "" "https://git-scm.com/downloads/win"
echo.
pause
exit /b 1

:broken_root
echo.
echo 文件夹 %ROOT% 已经存在，但里面不是完整的平台，可能是上次下载中断了。
echo 把这个文件夹删掉，再重新双击 start.bat。
echo.
pause
exit /b 1

:clone_failed
echo.
echo 下载平台失败：检查网络能不能打开 https://gitee.com/mingomin/rts-arena ，然后重新双击 start.bat。
echo 如果下载了一半，先把 %~dp0rts-arena 文件夹删掉。
echo.
pause
exit /b 1

:install_failed
echo.
echo 安装失败，往上翻看具体的报错。多数是网络问题，检查网络后重新双击 start.bat 即可。
echo.
pause
exit /b 1

rem ---------- 子过程：装依赖并构建，默认源失败就换国内镜像 ----------
:install
echo 正在安装依赖并构建播放器，第一次大约要几分钟……
call npm ci --no-audit --no-fund
if not errorlevel 1 exit /b 0
echo.
echo 默认的 npm 源没装成功，换国内镜像 npmmirror 再试一次……
call npm ci --no-audit --no-fund --registry=https://registry.npmmirror.com
exit /b %errorlevel%
