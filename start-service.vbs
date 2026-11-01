Option Explicit
' Teacher Workbench background service: start local server silently if not running.
' Used by the Startup shortcut. ASCII only.

Dim fso, sh, root, nodeExe, url, i

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FileExists(root & "\sync-server.js") Then root = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\Apps\teacher-workbench"
url = "http://127.0.0.1:8080/"

If IsUp(url) Then WScript.Quit 0

nodeExe = FindNode(fso, sh)
If nodeExe = "" Then WScript.Quit 1

sh.CurrentDirectory = root
sh.Run """" & nodeExe & """ """ & root & "\sync-server.js""", 0, False

Function IsUp(u)
  Dim h
  IsUp = False
  On Error Resume Next
  Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If Err.Number <> 0 Then
    Err.Clear
    Set h = CreateObject("MSXML2.XMLHTTP")
    Err.Clear
  End If
  If h Is Nothing Then Exit Function
  h.setTimeouts 400, 400, 800, 800
  Err.Clear
  h.open "GET", u, False
  h.send
  If Err.Number = 0 Then
    If h.status = 200 Then IsUp = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

Function FindNode(fso, sh)
  Dim c, i
  c = Array( _
    "C:\Program Files\nodejs\node.exe", _
    "C:\Program Files (x86)\nodejs\node.exe", _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe")
  FindNode = ""
  For i = 0 To UBound(c)
    If fso.FileExists(c(i)) Then
      FindNode = c(i)
      Exit Function
    End If
  Next
End Function
