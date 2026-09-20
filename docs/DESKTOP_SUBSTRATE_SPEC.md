# NexusOS Desktop Substrate Specification

**Version:** 1.0.0-PROPOSAL  
**Author:** NexusOS Architecture Working Group  
**Status:** Approved for Implementation (Phases D1–D5)  
**Target Environments:** Microsoft Windows (10/11 x64/ARM64), Apple macOS (Sequoia/Sonoma)

---

## 1. Executive Overview

Web browsers and mobile phones represent only part of the modern enterprise surface. Mission-critical business operations—accounting spreadsheets (Microsoft Excel), Enterprise Resource Planning (SAP GUI, Oracle Desktop), development environments (VS Code), communication hubs (Slack, Microsoft Teams), and native system utilities (Google Copilot for Windows, Terminal, File Explorer)—live natively on the **Desktop Operating System**.

The **NexusOS Desktop Substrate** extends the Universal Substrate Interface (USI) to native desktop environments without falling back to screenshot OCR or coordinate guessing. AI agents interact with desktop applications via native OS accessibility frameworks with **sub-10ms response times**, deterministic element binding, and human-kinetic mouse/keyboard physics.

```
                    ┌────────────────────────────────────────────────────────┐
                    │               NexusOS Core State Engine                │
                    │      (FSM Automata, Kinetic Physics, State Graph)      │
                    └───────────────────────────┬────────────────────────────┘
                                                │
                                                ▼
                                  «interface» SubstrateSurface
          ┌─────────────────────────────┼─────────────────────────────┐
          ▼                             ▼                             ▼
   WebBiDiSurface                 MobileSurface                 DesktopSurface
   (Firefox / Chrome)          (iOS WDA / Android UIA2)      (Windows UIA / macOS AX)
```

---

## 2. Direct OS Automation Drivers (Zero-Overhead Architecture)

NexusOS interfaces directly with native OS automation APIs through high-performance local daemons:

### 2.1 Microsoft Windows: Direct UI Automation (UIA v3 COM)
- **Protocol:** High-speed native interface via C++/Rust/Node Win32 bindings directly to `IUIAutomation` and `IUIAutomationTreeWalker`.
- **Target Applications:** WinUI 3, WPF, Win32, Windows Forms, UWP, and Chromium Desktop apps (Electron/WebView2).
- **Latency:** **< 5ms** per full window accessibility tree scan.
- **Window Identity:** Composite identity using `ProcessName:ProcessId:WindowHandle(HWND):AutomationId`.

### 2.2 Apple macOS: Accessibility API (`AXUIElement`)
- **Protocol:** Direct integration with macOS CoreGraphics and ApplicationServices (`AXUIElementCopyAttributeValue`, `AXUIElementPerformAction`).
- **Target Applications:** SwiftUI, AppKit, Catalyst, and Electron apps.
- **Input Injection:** Low-level `CGEventPost` via macOS Quartz Event Taps.
- **Permissions:** Respects macOS System Preferences Accessibility entitlement (`AXIsProcessTrustedWithOptions`).

### 2.3 Cross-Platform Electron / Chromium Apps (Direct CDP Attachment)
- Applications like Slack, VS Code, Discord, and Microsoft Teams run on Chromium/Electron.
- When launched with `--remote-debugging-port=9222`, NexusOS connects directly via Chrome DevTools Protocol / BiDi without needing an OS-level accessibility wrapper.


---

## 3. The 4-Layer Desktop Translation Matrix

### Layer 1: Structural Semantics (Normalization to `AxTreeNode`)

The Desktop normalizer maps native OS controls directly into canonical `AxTreeNode`s:

| Windows UIA ControlType | macOS AXRole | Canonical NexusOS Role | Supported Interactions |
|---|---|---|---|
| `Button` / `50000` | `AXButton` | `"button"` | `click`, `press` |
| `Edit` / `50004` | `AXTextField` | `"textbox"` | `type`, `clear`, `focus` |
| `CheckBox` / `50002` | `AXCheckBox` | `"checkbox"` | `check`, `uncheck`, `toggle` |
| `RadioButton` / `50013` | `AXRadioButton` | `"radio"` | `select` |
| `ComboBox` / `50003` | `AXPopUpButton` | `"combobox"` | `open`, `select-option` |
| `Tab` / `50018` | `AXTabGroup` | `"tablist"` | `switch-tab` |
| `TabItem` / `50019` | `AXRadioButton` | `"tab"` | `select` |
| `DataGrid` / `50028` | `AXTable` | `"grid"` / `"table"` | `navigate-cell`, `select-row` |
| `Tree` / `50023` | `AXOutline` | `"tree"` | `expand`, `collapse` |
| `Window` / `50032` | `AXWindow` | `"dialog"` / `"window"` | `focus`, `minimize`, `close` |
| `Text` / `50020` | `AXStaticText` | `"text"` | `read` |
| `Menu` / `50009` | `AXMenu` | `"menu"` | `open`, `select-item` |

### Layer 2: Geometry, Multi-Monitor & DPI Reconciliation
- **Per-Monitor DPI Virtualization:** Desktop systems regularly feature mixed-DPI multi-monitor setups (e.g., 4K primary at 150% scaling alongside 1080p secondary at 100%). NexusOS normalizes all coordinates to physical screen points before calculating mouse trajectories.
- **Occlusion & Clipping Detection:** Verifies whether a target window or element is obscured by overlapping application windows before executing clicks.
- **System Taskbar & Dock Insets:** Tracks Windows Taskbar and macOS Dock bounds to prevent misclicks on system chrome.

### Layer 3: Desktop Design Tokens (DTCG Desktop)
- Extracts system theme variables:
  - **Windows:** Fluent Design System tokens (Mica material, Acrylic opacity, Accent Color `#0078D4`, Segoe UI font ramps).
  - **macOS:** Human Interface Guidelines tokens (SF Pro typography, Vibrancy materials, system accent color).

### Layer 4: Desktop Interaction Automata (State FSM)
- **Desktop State Identification:**
  $$\text{StateId} = \text{Hash}(\text{AppName} \parallel \text{ActiveWindowTitle} \parallel \text{FocusedElementId} \parallel \text{ModalDialogHash})$$
- **Desktop Action Set:**
  - `click`, `double-click`, `right-click` (context menu invocation).
  - `drag-and-drop` (file movement, canvas reordering).
  - `hotkey-combination` (`Ctrl+C`, `Ctrl+V`, `Cmd+Space`, `Alt+Tab`).
  - `window-control` (`minimize`, `maximize`, `restore`, `snap-left`, `snap-right`).



---

## 4. Human-Kinetic Mouse Dynamics for Desktop

Mouse movement across high-resolution desktop canvases is non-linear. The Desktop substrate adapts the **NexusOS Human-Kinetic Input Engine**:

1. **Multi-Monitor Bézier Trajectories:**
   - Curves mouse paths across virtual display coordinates with velocity-dependent curvature.
2. **Sinusoidal Fitts' Law Deceleration:**
   - Decelerates pointer speed as the cursor approaches small desktop targets (e.g., 16x16 icon buttons in ribbons or toolbars).
3. **Micro-Overshoot & Correction:**
   - Models human hand physics with slight 1–3px overshoots followed by sub-10ms corrective micro-adjustments.

---

## 5. Security & Elevation Barriers (UAC & Permissions)

1. **Windows UAC (User Account Control):**
   - When an application requests administrative elevation, Windows switches to the Secure Desktop.
   - NexusOS detects UAC transition, classifies the event as an **`AuthBarrier`** with `kind: "uac-elevation"` and security tier **`CONFIRM`**, pausing autonomous execution and awaiting operator approval.
2. **macOS System Permissions:**
   - Detects system permission dialogs (Camera, Microphone, Disk Access, Accessibility) and emits a structured `HITLHandshake`.

---

## 6. Execution Roadmap (Phases D1–D5)

| Phase | Milestone | Deliverables |
|---|---|---|
| **Phase D1** | **Universal Desktop Types & Normalizers** | Add `"desktop-windows"` and `"desktop-macos"` to `SubstrateKind`. Implement `src/substrate/desktop-normalizer.ts` with unit tests. |
| **Phase D2** | **Windows Direct UIA Daemon** | High-performance Windows UI Automation walker in `src/desktop/windows/` with window discovery and element enumeration. |
| **Phase D3** | **macOS AX Daemon Adapter** | Native macOS accessibility adapter in `src/desktop/macos/` utilizing `AXUIElement` bindings. |
| **Phase D4** | **Multi-Monitor Geometry & Window Focus** | Multi-screen coordinate translation, per-monitor DPI scaling, and active window switching. |
| **Phase D5** | **Desktop MCP Integration** | Expose desktop surfaces via the standard 6 MCP tools (`graph_query`, `graph_invoke`, etc.) for Claude Desktop and agent environments. |

