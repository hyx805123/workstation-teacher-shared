Option Explicit
' Local-only mode: bind to 127.0.0.1 so other computers on the LAN cannot reach it.
' Use this when you are on a public Wi-Fi or do not want to share data.

Dim fso, sh, root, nodeExe, edgeExe, url, i, env

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FileExists(root & "\sync-server.js") Then root = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\Apps\teacher-workbench"
url = "http://127.0.0.1:8080/"

Set env = sh.Environment("PROCESS")
env("HOST") = "127.0.0.1"

If Not IsUp(url) Then
  nodeExe = FindNode(fso, sh)
  If nodeExe = "" Then
    MsgBox "Node.js not found. Install Node.js 18+ from https://nodejs.org first.", 16, "Teacher Workbench"
    WScript.Quit 1
  End If
  sh.CurrentDirectory = root
  sh.Run """" & nodeExe & """ """ & root & "\sync-server.js"" 8080", 0, False
  For i = 1 To 40
    WScript.Sleep 200
    If IsUp(url) Then Exit For
  Next
End If

If Not IsUp(url) Then
  MsgBox "Local server did not start. See service.log in:" & vbCrLf & root, 16, "Teacher Workbench"
  WScript.Quit 1
End If

edgeExe = FindEdge(fso, sh)
If edgeExe <> "" Then
  sh.Run """" & edgeExe & """ --app=" & url & " --window-size=1500,950", 1, False
Else
  sh.Run url, 1, False
End If

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

Function FindEdge(fso, sh)
  Dim c, i
  c = Array( _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Microsoft\Edge\Application\msedge.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe")
  FindEdge = ""
  For i = 0 To UBound(c)
    If fso.FileExists(c(i)) Then
      FindEdge = c(i)
      Exit Function
    End If
  Next
End Function
