@echo off
rem BB-ScrapeFailover — 本機備援排程包裝（雲端爬蟲被 WAF 擋時自動接手，詳見 local_failover.js 檔頭）
rem 註冊（系統管理不需要，一般使用者權限即可）：
rem   schtasks /Create /F /SC MINUTE /MO 30 /TN "BB-ScrapeFailover" /TR "cmd /c start \"\" /min \"C:\Users\User\Downloads\Sportbetting-PLUS\failover_task.cmd\""
rem 移除：
rem   schtasks /Delete /F /TN "BB-ScrapeFailover"
rem 檢視 log：type "%USERPROFILE%\bb_failover.log"
cd /d %~dp0
node local_failover.js >> "%USERPROFILE%\bb_failover.log" 2>&1
