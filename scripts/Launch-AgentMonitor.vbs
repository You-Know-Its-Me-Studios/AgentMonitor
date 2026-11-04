Option Explicit
Dim shell, fs, root, launchPath, powerShellPath, command, index, argument
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
launchPath = fs.BuildPath(root, "scripts\Launch-AgentMonitor.ps1")
powerShellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = Chr(34) & powerShellPath & Chr(34) & " -NoLogo -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & launchPath & Chr(34)
For index = 0 To WScript.Arguments.Count - 1
    argument = LCase(WScript.Arguments(index))
    If argument <> "-nobrowser" And argument <> "-noninteractive" Then
        MsgBox "Unsupported launch option. Use -NoBrowser or -NonInteractive.", vbExclamation, "Agent Monitor"
        WScript.Quit 1
    End If
    command = command & " " & WScript.Arguments(index)
Next
On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then
    MsgBox "Agent Monitor could not launch PowerShell: " & Err.Description, vbCritical, "Agent Monitor"
    WScript.Quit 1
End If
