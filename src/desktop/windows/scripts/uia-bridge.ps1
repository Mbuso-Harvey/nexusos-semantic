# SPDX-License-Identifier: Apache-2.0

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("ListWindows", "DumpTree", "ReadText", "ReplaceText", "Click", "RightClick", "SendText", "SendHotkey", "Screenshot", "Focus", "WindowState")]
    [string]$Action,
    [string]$TitlePattern = "",
    [int]$ProcessId = 0,
    [string]$WindowHandle = "",
    [int]$MaxDepth = 8,
    [int]$MaxChildren = 250,
    [int]$X = 0,
    [int]$Y = 0,
    [string]$Text = "",
    [string]$ExpectedText = "",
    [string]$WindowState = "Restore"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$win32TypeDef = @"
using System;
using System.Runtime.InteropServices;
public class Win32BridgeNative {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
}
"@
if (-not ([System.Management.Automation.PSTypeName]'Win32BridgeNative').Type) {
    Add-Type -TypeDefinition $win32TypeDef -ErrorAction SilentlyContinue
}

function Get-WindowList {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $results = @()
    foreach ($w in $windows) {
        try {
            $cur = $w.Current
            if (-not [string]::IsNullOrWhiteSpace($cur.Name) -and -not $cur.IsOffscreen) {
                $rect = $cur.BoundingRectangle
                if ($rect.Width -gt 50 -and $rect.Height -gt 50) {
                    $pName = ""
                    try { $pName = ([System.Diagnostics.Process]::GetProcessById($cur.ProcessId)).ProcessName } catch {}
                    $results += [PSCustomObject]@{
                        windowId = "$($cur.NativeWindowHandle)"
                        title = $cur.Name
                        processName = $pName
                        processId = $cur.ProcessId
                        bounds = [ordered]@{
                            x = [Math]::Round($rect.Left)
                            y = [Math]::Round($rect.Top)
                            width = [Math]::Round($rect.Width)
                            height = [Math]::Round($rect.Height)
                        }
                    }
                }
            }
        } catch {}
    }
    $results | ConvertTo-Json -Depth 5 -Compress
}

function Get-UiaNodeHierarchy($element, [int]$depth, [int]$depthLimit) {
    if ($null -eq $element -or $depth -gt $depthLimit) { return $null }
    try {
        $cur = $element.Current
        # Skip Chromium D3D intermediate presentation surfaces which block cross-process COM
        if ($cur.ClassName -eq "Intermediate D3D Window") { return $null }

        $rect = $cur.BoundingRectangle
        $rectObj = $null
        if ($rect -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
            $rectObj = [ordered]@{
                x = [Math]::Round($rect.Left); y = [Math]::Round($rect.Top)
                width = [Math]::Round($rect.Width); height = [Math]::Round($rect.Height)
            }
        }

        $node = [ordered]@{
            automationId = $cur.AutomationId
            name = $cur.Name
            controlType = $cur.ControlType.ProgrammaticName
            localizedControlType = $cur.LocalizedControlType
            className = $cur.ClassName
            isEnabled = $cur.IsEnabled
            isOffscreen = $cur.IsOffscreen
            processId = $cur.ProcessId
            frameworkId = $cur.FrameworkId
        }
        if ($null -ne $rectObj) { $node["boundingRectangle"] = $rectObj }

        $children = @()
        if ($depth -lt $depthLimit) {
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            $child = $walker.GetFirstChild($element)
            $count = 0
            while ($null -ne $child -and $count -lt $MaxChildren) {
                $cNode = Get-UiaNodeHierarchy $child ($depth + 1) $depthLimit
                if ($null -ne $cNode) { $children += $cNode }
                $child = $walker.GetNextSibling($child)
                $count++
            }
        }
        if ($children.Count -gt 0) { $node["children"] = $children }
        return $node
    } catch { return $null }
}

function Find-TargetWindow {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($w in $windows) {
        try {
            $cur = $w.Current
            if ($WindowHandle -ne "" -and "$($cur.NativeWindowHandle)" -eq $WindowHandle) { return $w }
            if ($ProcessId -gt 0 -and $cur.ProcessId -eq $ProcessId) { return $w }
            if ($TitlePattern -ne "" -and $cur.Name -like "*$TitlePattern*") { return $w }
        } catch {}
    }
    return $null
}

function Get-TextCandidates($WindowElement) {
    $candidates = @()
    try {
        $type = $WindowElement.Current.ControlType
        if ($type -eq [System.Windows.Automation.ControlType]::Document -or $type -eq [System.Windows.Automation.ControlType]::Edit) {
            $candidates += $WindowElement
        }
    } catch {}

    $editCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit
    )
    $documentCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Document
    )
    $condition = New-Object System.Windows.Automation.OrCondition($editCondition, $documentCondition)
    $descendants = $WindowElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    foreach ($candidate in $descendants) { $candidates += $candidate }
    return $candidates
}

function Get-TextElement($WindowElement, [bool]$RequireEditable) {
    $fallback = $null
    foreach ($candidate in @(Get-TextCandidates $WindowElement)) {
        try {
            if (-not $candidate.Current.IsEnabled -or $candidate.Current.IsOffscreen) { continue }
            $valuePattern = $null
            if ($candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
                if (-not $valuePattern.Current.IsReadOnly) { return $candidate }
                if (-not $RequireEditable -and $null -eq $fallback) { $fallback = $candidate }
            }
            $textPattern = $null
            if ($candidate.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
                if (-not $RequireEditable -or $candidate.Current.IsKeyboardFocusable) { return $candidate }
                if ($null -eq $fallback) { $fallback = $candidate }
            }
        } catch {}
    }
    if (-not $RequireEditable) { return $fallback }
    return $null
}

function Read-UiaElementText($Element) {
    $textPattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
        return [PSCustomObject]@{ method = "TextPattern"; text = $textPattern.DocumentRange.GetText(-1) }
    }
    $valuePattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        return [PSCustomObject]@{ method = "ValuePattern"; text = $valuePattern.Current.Value }
    }
    throw "Target Document/Edit element supports neither TextPattern nor ValuePattern"
}

function Normalize-UiaText([string]$Value) {
    if ($null -eq $Value) { return "" }
    return ($Value -replace '\r\n?', "`n") -replace '\n+$', ''
}

function Get-EditableTextElementByExpected($WindowElement, [string]$Expected) {
    $matches = @()
    foreach ($candidate in @(Get-TextCandidates $WindowElement)) {
        try {
            if (-not $candidate.Current.IsEnabled -or $candidate.Current.IsOffscreen) { continue }
            $valuePattern = $null
            $writableValue = $candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern) -and -not $valuePattern.Current.IsReadOnly
            $textPattern = $null
            $focusableText = $candidate.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern) -and $candidate.Current.IsKeyboardFocusable
            if (-not $writableValue -and -not $focusableText) { continue }
            $current = Read-UiaElementText $candidate
            if ((Normalize-UiaText $current.text) -eq (Normalize-UiaText $Expected)) { $matches += $candidate }
        } catch {}
    }
    if ($matches.Count -ne 1) {
        throw "Expected exactly one editable Document/Edit element matching the current text; found $($matches.Count)"
    }
    return $matches[0]
}

function Focus-UiaElement($WindowElement, $Element) {
    $hwnd = [IntPtr][int64]$WindowElement.Current.NativeWindowHandle
    $null = [Win32BridgeNative]::ShowWindow($hwnd, 9)
    $null = [Win32BridgeNative]::BringWindowToTop($hwnd)

    # Windows restricts SetForegroundWindow for background processes. Use the
    # documented "ALT tickle + AttachThreadInput" technique across retries, then
    # validate against the real foreground owner. Retry a bounded number of times
    # before failing closed (do not type into the wrong window).
    $focused = $false
    for ($attempt = 1; $attempt -le 6 -and -not $focused; $attempt++) {
        $null = [Win32BridgeNative]::SetForegroundWindow($hwnd)

        # ALT key up/down clears the foreground lock before a second attempt.
        if ($attempt -le 5) {
            [Win32BridgeNative]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)  # ALT down
            [Win32BridgeNative]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)  # ALT up
        }

        $foregroundPid = [uint32]0
        $thread1 = [Win32BridgeNative]::GetCurrentThreadId()
        $thread2 = [Win32BridgeNative]::GetWindowThreadProcessId($hwnd, [ref]$foregroundPid)
        if ($thread1 -ne $thread2) {
            $null = [Win32BridgeNative]::AttachThreadInput($thread1, $thread2, $true)
            $null = [Win32BridgeNative]::SetForegroundWindow($hwnd)
            $null = [Win32BridgeNative]::AttachThreadInput($thread1, $thread2, $false)
        }
        $null = [Win32BridgeNative]::BringWindowToTop($hwnd)
        Start-Sleep -Milliseconds 80
        $focused = ([Win32BridgeNative]::GetForegroundWindow() -eq $hwnd)
    }

    if (-not $focused) { throw "Could not set target window foreground" }

    $elementFocused = $false
    for ($attempt = 1; $attempt -le 4 -and -not $elementFocused; $attempt++) {
        $Element.SetFocus()
        Start-Sleep -Milliseconds 75
        $elementFocused = $Element.Current.HasKeyboardFocus
    }
    if (-not $elementFocused) { throw "Target editor does not own keyboard focus" }
}

function ConvertTo-SendKeysLiteral([string]$Value) {
    $builder = New-Object System.Text.StringBuilder
    foreach ($ch in $Value.ToCharArray()) {
        $escaped = switch ([string]$ch) {
            "+" { "{+}"; break }
            "^" { "{^}"; break }
            "%" { "{%}"; break }
            "~" { "{~}"; break }
            "(" { "{(}"; break }
            ")" { "{)}"; break }
            "[" { "{[}"; break }
            "]" { "{]}"; break }
            "{" { "{{}"; break }
            "}" { "{}}"; break }
            default { [string]$ch }
        }
        $null = $builder.Append($escaped)
    }
    return $builder.ToString()
}

switch ($Action) {
    "ListWindows" { Get-WindowList }
    "DumpTree" {
        $win = Find-TargetWindow
        if ($null -eq $win) {
            Write-Error "Window not found matching TitlePattern='$TitlePattern', ProcessId=$ProcessId, WindowHandle='$WindowHandle'"
            exit 1
        }
        $hierarchy = Get-UiaNodeHierarchy $win 0 $MaxDepth
        $hierarchy | ConvertTo-Json -Depth 25 -Compress
    }
    "ReadText" {
        $win = Find-TargetWindow
        if ($null -eq $win) {
            Write-Error "Target window not found"
            exit 1
        }
        $element = Get-TextElement $win $false
        if ($null -eq $element) {
            Write-Error "No readable Document/Edit element found in target window"
            exit 1
        }
        try {
            $read = Read-UiaElementText $element
            [PSCustomObject]@{
                status = "ok"
                windowId = "$($win.Current.NativeWindowHandle)"
                method = $read.method
                text = $read.text
            } | ConvertTo-Json -Compress
        } catch {
            Write-Error $_
            exit 1
        }
    }
    "ReplaceText" {
        Add-Type -AssemblyName System.Windows.Forms
        $win = Find-TargetWindow
        if ($null -eq $win) {
            Write-Error "Target window not found"
            exit 1
        }
        $element = Get-EditableTextElementByExpected $win $ExpectedText
        if ($null -eq $element) {
            Write-Error "No editable Document/Edit element found in target window"
            exit 1
        }
        try {
            Focus-UiaElement $win $element
            $replaceMethod = $null
            $valuePattern = $null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern) -and -not $valuePattern.Current.IsReadOnly) {
                try {
                    $valuePattern.SetValue($Text)
                    $replaceMethod = "ValuePattern"
                } catch {}
            }
            if ($null -eq $replaceMethod) {
                $priorClipboard = $null
                $hadClipboard = $false
                try {
                    $priorClipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
                    $hadClipboard = $null -ne $priorClipboard
                } catch {}
                try {
                    [System.Windows.Forms.Clipboard]::SetText($Text)
                    [System.Windows.Forms.SendKeys]::SendWait("^a")
                    [System.Windows.Forms.SendKeys]::SendWait("^v")
                    $replaceMethod = "Clipboard"
                } finally {
                    try {
                        if ($hadClipboard) {
                            [System.Windows.Forms.Clipboard]::SetDataObject($priorClipboard, $true)
                        } else {
                            [System.Windows.Forms.Clipboard]::Clear()
                        }
                    } catch {}
                }
            }
            Start-Sleep -Milliseconds 75
            $actual = Read-UiaElementText $element
            # Flake guard (F-008/F-009): Notepad's RichEdit can materialize the paste
            # after a fast read-back. Re-read a bounded number of times before treating
            # a mismatch as fatal — still fail closed if the text genuinely didn't land.
            for ($attempt = 1; $attempt -le 5 -and (Normalize-UiaText $actual.text) -ne (Normalize-UiaText $Text); $attempt++) {
                Start-Sleep -Milliseconds 120
                $actual = Read-UiaElementText $element
            }
            if ((Normalize-UiaText $actual.text) -ne (Normalize-UiaText $Text)) {
                throw "Replacement read-back did not match requested text"
            }
            [PSCustomObject]@{
                status = "ok"
                windowId = "$($win.Current.NativeWindowHandle)"
                method = $replaceMethod
                text = $actual.text
            } | ConvertTo-Json -Compress
        } catch {
            Write-Error $_
            exit 1
        }
    }
    "Screenshot" {
        Add-Type -AssemblyName System.Drawing
        Add-Type -AssemblyName System.Windows.Forms
        $win = Find-TargetWindow
        $rect = if ($win) { $win.Current.BoundingRectangle } else { [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }
        $w = [Math]::Max(100, [Math]::Round($rect.Width))
        $h = [Math]::Max(100, [Math]::Round($rect.Height))
        $x = [Math]::Max(0, [Math]::Round($rect.Left))
        $y = [Math]::Max(0, [Math]::Round($rect.Top))
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $b64 = [Convert]::ToBase64String($ms.ToArray())
        $g.Dispose(); $bmp.Dispose(); $ms.Dispose()
        [PSCustomObject]@{ base64 = $b64 } | ConvertTo-Json -Compress
    }
    "Click" {
        $null = [Win32BridgeNative]::SetCursorPos($X, $Y)
        Start-Sleep -Milliseconds 30
        [Win32BridgeNative]::mouse_event(0x02, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 40
        [Win32BridgeNative]::mouse_event(0x04, 0, 0, 0, 0)
        [PSCustomObject]@{ status = "ok"; x = $X; y = $Y; action = "click" } | ConvertTo-Json -Compress
    }
    "RightClick" {
        $null = [Win32BridgeNative]::SetCursorPos($X, $Y)
        Start-Sleep -Milliseconds 30
        [Win32BridgeNative]::mouse_event(0x08, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 40
        [Win32BridgeNative]::mouse_event(0x10, 0, 0, 0, 0)
        [PSCustomObject]@{ status = "ok"; x = $X; y = $Y; action = "rightClick" } | ConvertTo-Json -Compress
    }
    "SendText" {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-SendKeysLiteral $Text))
        [PSCustomObject]@{ status = "ok"; text = $Text } | ConvertTo-Json -Compress
    }
    "SendHotkey" {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait($Text)
        [PSCustomObject]@{ status = "ok"; hotkey = $Text } | ConvertTo-Json -Compress
    }
    "Focus" {
        $win = Find-TargetWindow
        if ($win) {
            $hwnd = [IntPtr][int64]$win.Current.NativeWindowHandle
            $null = [Win32BridgeNative]::ShowWindow($hwnd, 9)
            $null = [Win32BridgeNative]::SetForegroundWindow($hwnd)
            $null = [Win32BridgeNative]::BringWindowToTop($hwnd)
            [PSCustomObject]@{ status = "ok"; windowId = "$hwnd" } | ConvertTo-Json -Compress
        } else {
            Write-Error "Target window not found"
            exit 1
        }
    }
    "WindowState" {
        $win = Find-TargetWindow
        if ($win) {
            $hwnd = [IntPtr][int64]$win.Current.NativeWindowHandle
            $cmd = switch ($WindowState) {
                "Minimize" { 6 }
                "Maximize" { 3 }
                default { 9 }
            }
            [Win32BridgeNative]::ShowWindow($hwnd, $cmd)
            [PSCustomObject]@{ status = "ok"; windowId = "$hwnd"; state = $WindowState } | ConvertTo-Json -Compress
        } else {
            Write-Error "Target window not found"
            exit 1
        }
    }
}
