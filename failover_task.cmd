@echo off
rem BB-ScrapeFailover — 本機備援排程包裝（雲端爬蟲被 WAF 擋時自動接手，詳見 local_failover.js 檔頭）
rem 註冊（系統管理不需要，一般使用者權限即可）：
rem   schtasks /Create /F /SC MINUTE /MO 5 /TN "BB-ScrapeFailover" /TR "wscript.exe \"D:\Sportbetting-PLUS\failover_task_hidden.vbs\""
rem 移除：
rem   schtasks /Delete /F /TN "BB-ScrapeFailover"
rem 檢視 log：type "D:\Sportbetting-PLUS\.runtime\bb_failover.log"
cd /d %~dp0
set "SBP_RUNTIME=%~dp0.runtime"
set "BB_FAILOVER_WORKSPACE=%SBP_RUNTIME%\failover-workspace"
if not exist "%SBP_RUNTIME%\tmp" mkdir "%SBP_RUNTIME%\tmp"
set "TEMP=%SBP_RUNTIME%\tmp"
set "TMP=%SBP_RUNTIME%\tmp"
node local_failover_workspace.js >> "%SBP_RUNTIME%\bb_failover.log" 2>&1
