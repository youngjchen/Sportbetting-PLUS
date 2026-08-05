' BB-ScrapeFailover 完全隱藏啟動器（2026-08-05 使用者拍板：黑窗一直跳出打斷工作＋被關掉會腰斬長任務）
' 用 wscript 以視窗模式 0（完全隱藏）執行原本的 failover_task.cmd，行為不變、只是看不見。
Dim shell, fso, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
cmd = fso.GetParentFolderName(WScript.ScriptFullName) & "\failover_task.cmd"
shell.Run """" & cmd & """", 0, False
