Option Explicit
' Weekly Report Studio - double-click installer.
' ASCII only on purpose: Windows Script Host reads .vbs with the system code page,
' so keeping this file pure ASCII avoids any Chinese text corruption.
'
' What it does:
'   1. Locate a Node.js v20+ executable (DSH bundled / WorkBuddy / system / PATH)
'   2. Run install.mjs hidden (no console window, no command line to type)
'   3. Open the panel in the default browser on success
'   4. Show a diagnostic message only when something failed

Dim sh, fso, here, node, resultFile, cmd, rc, summary, f
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

node = FindNode(sh, fso)
If node = "" Then
  MsgBox "Node.js (v20+) was not found." & vbCrLf & vbCrLf & _
         "DeepSeek Harness ships its own Node runtime. Otherwise please install Node.js first.", _
         16, "Weekly Report Studio - Setup"
  WScript.Quit 1
End If

resultFile = here & "\.install-result.tmp"
If fso.FileExists(resultFile) Then fso.DeleteFile resultFile, True

cmd = """" & node & """ """ & here & "\install.mjs"" --result-file """ & resultFile & """"
rc = sh.Run(cmd, 0, True)

summary = ""
If fso.FileExists(resultFile) Then
  Set f = fso.OpenTextFile(resultFile, 1, False, 0)
  If Not f.AtEndOfStream Then summary = f.ReadAll
  f.Close
  fso.DeleteFile resultFile, True
End If

If rc = 0 Then
  ' Success: no extra dialog, just show the Chinese panel in the browser.
  sh.Run "http://127.0.0.1:8798/", 1, False
Else
  MsgBox "Setup finished with code " & rc & "." & vbCrLf & vbCrLf & summary & vbCrLf & vbCrLf & _
         "Check with: node install.mjs --verify" & vbCrLf & _
         "Panel: http://127.0.0.1:8798/", _
         48, "Weekly Report Studio - Setup"
End If
WScript.Quit rc

Function FindNode(sh, fso)
  Dim home, p, versions, subFolder, candidate, arr, i
  home = sh.ExpandEnvironmentStrings("%USERPROFILE%")

  ' 1. Explicit override
  p = sh.ExpandEnvironmentStrings("%WEEKLY_PANEL_NODE%")
  If Left(p, 1) <> "%" And fso.FileExists(p) Then
    FindNode = p
    Exit Function
  End If

  ' 2. DeepSeek Harness bundled Node
  p = home & "\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  If fso.FileExists(p) Then
    FindNode = p
    Exit Function
  End If

  ' 3. WorkBuddy versioned Node (pick the first existing one)
  versions = home & "\.workbuddy\binaries\node\versions"
  If fso.FolderExists(versions) Then
    For Each subFolder In fso.GetFolder(versions).SubFolders
      candidate = subFolder.Path & "\node.exe"
      If fso.FileExists(candidate) Then
        FindNode = candidate
        Exit Function
      End If
    Next
  End If

  ' 4. Common system installs
  arr = Array("C:\Program Files\nodejs\node.exe", _
              sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe", _
              "C:\Program Files (x86)\nodejs\node.exe")
  For i = 0 To UBound(arr)
    If fso.FileExists(arr(i)) Then
      FindNode = arr(i)
      Exit Function
    End If
  Next

  ' 5. Last resort: rely on PATH
  FindNode = "node"
End Function
