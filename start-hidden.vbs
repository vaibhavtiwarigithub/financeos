Dim oShell
Set oShell = WScript.CreateObject("WScript.Shell")
oShell.CurrentDirectory = "C:\Users\vaibh\OneDrive\Documents\Startup\FinanceOS"
oShell.Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\vaibh\OneDrive\Documents\Startup\FinanceOS\node_modules\next\dist\bin\next"" start", 0, False
Set oShell = Nothing
