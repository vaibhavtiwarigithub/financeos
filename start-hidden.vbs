Dim oShell
Set oShell = WScript.CreateObject("WScript.Shell")
oShell.CurrentDirectory = "C:\Users\vaibh\OneDrive\Documents\Startup\FinanceOS"
oShell.Run "cmd /c npm run dev -- --port 3000 > C:\Users\vaibh\AppData\Local\Temp\financeos-dev.log 2>&1", 0, False
Set oShell = Nothing
