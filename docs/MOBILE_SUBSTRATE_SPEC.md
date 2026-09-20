# NexusOS Mobile Substrate — Architectural Specification & Execution Blueprint

## 1. Executive Summary & Purpose

NexusOS is a **Universal Semantic Operating System (SOS)**. While the Web implementation uses WebDriver BiDi over genuine Firefox, the core mathematical abstraction—the **4-Layer Relational Semantic Graph and Finite State Automata (FSM)**—is substrate-agnostic.

This specification details the **NexusOS Mobile Substrate**, extending deterministic, anti-bot state extraction and autonomous navigation to **Native iOS (Swift / SwiftUI / UIKit)** and **Native Android (Kotlin / Jetpack Compose / Views)**.

---

## 2. High-Level Substrate Decoupling: The Universal Substrate Interface (USI)

Rather than forcing mobile into a fake browser abstraction, NexusOS defines a unified **`SubstrateSurface`** interface that both Web BiDi and Native Mobile implement.

```
                          ┌────────────────────────────────────────────────────────┐
                          │               NexusOS Core State Engine                │
                          │   (Relational Graph, FSM Automata, Kinetic Physics)    │
                          └───────────────────────────┬────────────────────────────┘
                                                      │
                                                      ▼
                                       «interface» SubstrateSurface
                                 ┌────────────────────┴────────────────────┐
                                 │                                         │
                   ┌─────────────┴──────────────┐           ┌──────────────┴─────────────┐
                   │       WebBiDiSurface       │           │        MobileSurface       │
                   │  (BiDi / WebSocket / DOM)  │           │   (Touch / W3C / ViewTree) │
                   └─────────────┬──────────────┘           └──────────────┬─────────────┘
                                 │                                         │
                    ┌────────────┴────────────┐             ┌──────────────┴─────────────┐
                    ▼                         ▼             ▼                            ▼
             Firefox BiDi               Chrome BiDi     iOS Substrate             Android Substrate
             (Geckodriver)              (Chromedriver)  (WDA / XCUITest)          (UIAutomator2 / ADB)
```

### `SubstrateSurface` Contract
```ts
export interface SubstrateSurface {
  /** Unique surface identifier (tab id or mobile window handle) */
  readonly surfaceId: string;
  /** Current route or screen identifier (URL on Web; Activity/SwiftUI view on Mobile) */
  getRoute(): Promise<string>;
  /** Screen or document title / header */
  getTitle(): Promise<string>;
  /** Capture pixel-truth screenshot */
  captureScreenshot(): Promise<{ data: Buffer; mimeType: string }>;
  /** Extract native accessibility tree */
  extractAccessibilityTree(): Promise<AxTreeNode[]>;
  /** Perform kinetic pointer or touch actions */
  performActions(actions: SubstrateActionBatch[]): Promise<void>;
  /** Retrieve active viewport / display bounds and safe-area insets */
  getDisplayMetrics(): Promise<DisplayMetrics>;
}
```

---

## 3. Zero-Overhead Mobile Driver Architecture (Direct Daemon Connection)

Traditional mobile automation via standard Appium creates unacceptable 200–800ms latency per command and introduces brittle Node.js proxy layers.

**NexusOS connects directly to native OS automation daemons via persistent sockets:**

### A. Android Direct Daemon: `UIAutomator2 Server` (over ADB)
1. NexusOS installs and launches the lightweight Android instrumentation APK (`io.appium.uiautomator2.server`).
2. Establishes a direct local port forward via ADB:
   `adb forward tcp:6790 tcp:6790`
3. Communicates via direct HTTP/REST and WebSocket to port `6790` on `127.0.0.1`.
4. **Latency:** Under **8ms** per state query (compared to ~250ms through full Appium stacks).
5. Supports physical hardware devices (Pixel, Samsung Galaxy) and Android Studio headless emulators.

### B. iOS Direct Daemon: `WebDriverAgentRunner (WDA)` (over USB / iproxy)
1. Signs and runs Apple's native `WebDriverAgentRunner.xctrunner` via `xcodebuild` or Facebook's `idb` (iOS Development Bridge).
2. Forwards communication over USB using `iproxy 8100 8100` (or connects directly to iOS Simulator HTTP port).
3. Directly sends W3C WebDriver commands to the native XCUITest runtime.
4. **Zero Jailbreak Required:** Operates 100% within Apple's official developer testing and XCTest security framework.

---

## 4. The 4-Layer Mobile Translation Engine

### Layer 1: Structural Semantics (Canonical AxNode Normalization)
Native mobile elements are automatically mapped into the unified `AxNode` schema:

| Semantic Attribute | W3C Web (Current) | iOS Native (XCUITest / WDA) | Android Native (UIAutomator2) |
| :--- | :--- | :--- | :--- |
| **Button** | `<button>`, `role="button"` | `XCUIElementTypeButton` | `android.widget.Button`, `clickable=true` |
| **Input Field** | `<input type="text">` | `XCUIElementTypeTextField`, `SecureTextField` | `android.widget.EditText` |
| **Toggle / Switch** | `<input type="checkbox">` | `XCUIElementTypeSwitch` | `android.widget.Switch`, `android.widget.CheckBox` |
| **Navigation List** | `<ul>`, `<nav>`, `role="list"` | `XCUIElementTypeTable`, `XCUIElementTypeCollectionView` | `android.widget.ListView`, `androidx.recyclerview.widget.RecyclerView` |
| **List Item / Cell** | `<li>`, `role="listitem"` | `XCUIElementTypeCell` | Child view of RecyclerView |
| **Modal / Dialog** | `<dialog>`, `role="dialog"` | `XCUIElementTypeSheet`, `XCUIElementTypeAlert` | `android.app.Dialog`, `androidx.appcompat.app.AlertDialog` |
| **Tab Bar** | `role="tablist"` | `XCUIElementTypeTabBar`, `XCUIElementTypeSegmentedControl` | `com.google.android.material.tabs.TabLayout` |
| **Accessible Name** | ARIA `name` computation | `label` ?? `title` ?? `identifier` | `content-desc` ?? `text` ?? `resource-id` |
| **Selected State** | `aria-selected="true"` | `isSelected == true`, `traits.contains("selected")` | `selected=true` |
| **Checked State** | `aria-checked="true"` | `value == "1"` (for switches/checkboxes) | `checked=true` |
| **Disabled State** | `disabled`, `aria-disabled`| `isEnabled == false` | `enabled=false` |

### Layer 2: Visual Geometry, Display Density & Safe Areas
Mobile devices operate on point/dp abstractions rather than 1:1 CSS pixels:
1. **Coordinate Normalization:**
   - Android: Bounds reported in physical screen pixels $\rightarrow$ scaled to device-independent pixels (`dp`):
     $$\text{dp} = \frac{\text{pixels}}{\text{density} / 160}$$
   - iOS: Bounds reported in logical points $\rightarrow$ multiplied by Retina scale factor (`@2x`, `@3x`) for pixel-truth visual anchoring.
2. **Safe-Area Compensation:**
   - Automatically detects and tracks **Dynamic Island / Notch** top bounds and **Home Indicator** bottom bars.
   - Probes avoid interacting with non-interactive safe-area margins.

### Layer 3: Design Tokens (DTCG Mobile)
- **Colors:** Extracts theme hex/RGB values from SwiftUI asset catalogs and Android Material 3 dynamic color palettes.
- **Typography:** Maps iOS Dynamic Type (`Large Title`, `Headline`, `Body`, `Caption`) and Material Design 3 type scales into DTCG standard typography tokens.
- **Corner Radii & Elevation:** Extracts bounding corner radii (Squircle continuous corners on iOS; Material rounded corners on Android) and shadow elevation vectors.

### Layer 4: Mobile Interaction Automata (State & Transitions)
1. **Screen State Identity (`route`):**
   - Web: URL pathname + search query (e.g. `/checkout/payment`).
   - Android: `Activity` class name + `Fragment` backstack tag + Intent deep-link URI (e.g. `com.enterprise.app/.ui.checkout.PaymentFragment`).
   - iOS: Topmost `UIViewController` type + SwiftUI `NavigationStack` path identifier.
2. **Mobile Transition Triggers:**
   - `tap`: Primary touch down and touch up at element center.
   - `long-press`: Touch down held for $\ge 500\text{ms}$ before release (triggers context menus).
   - `swipe-left` / `swipe-right`: Lateral swipe (e.g. swipe-to-delete, carousel pagination).
   - `pull-to-refresh`: Downward drag past header threshold to trigger async data reload.
   - `fling-scroll`: Kinetic vertical flick with inertial deceleration.
   - `system-back`: Android hardware/gesture back; iOS edge-swipe pop navigation.
   - `request-permission`: OS runtime permission dialogs (Camera, Geolocation, Push Notifications).


---

## 5. Mobile Anti-Detection & Touch Kinematics

Automated bot detection on mobile devices (e.g. Arkose Labs Mobile SDK, Datadome Mobile, Cloudflare Mobile Turnstile) looks for linear robotic touch coordinates, zero touch pressure, instantaneous taps, and absence of physical device motion.

### A. Thumb-Arc Kinematics (Natural Swipes)
When humans hold a mobile phone, thumb swipes follow an arc centered at the thumb's carpometacarpal pivot point:
- **Radial Arc Interpolation:** Swipes are calculated along a curved trajectory $R(\theta) = (x_0 + r \cos\theta, y_0 + r \sin\theta)$ rather than a rigid Cartesian straight line.
- **Inertial Fling Deceleration:** Vertical flings model physical fluid friction:
  $$v(t) = v_0 \cdot e^{-k t}$$
  gradually slowing down touch coordinate steps before pointer-up release.

### B. Touch Contact & Pressure Dynamics
- Emits realistic `pointerType: "touch"` with variable contact geometry:
  - `width` / `height` major axis: 8–14dp (simulating thumb pad contact deformation).
  - `pressure`: ramps smoothly from $0.15 \rightarrow 0.85 \rightarrow 0.20$ across the gesture lifecycle.

---

## 6. Mobile Hardware Barriers & Biometric HITL Orchestration

Hardware security chips (Apple Secure Enclave, Android StrongBox / Titan M2) require authentic user confirmation for Apple Pay, Passkeys, and banking transactions.

### A. Non-Production / CI Environment (Automated Bypass Hooks)
- **iOS Simulator:** Injected via official Apple simulator CLI:
  `xcrun simctl biometric enroll <device-id>`  
  `xcrun simctl biometric match <device-id>`
- **Android Emulator / Rooted Test Harness:** Injected via ADB shell:
  `adb -s <device> emu finger touch 1`

### B. Production & Enterprise Compliance Mode (True HITL Barrier)
When running audits on real customer devices:
1. **Barrier Classification:** `detectAuthBarrier()` captures `kind: "biometric-passkey"`.
2. **State Freeze:** FSM emits an active `HITLHandshake` event and enters pause mode.
3. **Operator Notification:** Pushes a webhook / Slack alert to the authorized human operator.
4. **Biometric Clearance:** Operator touches TouchID/FaceID. The state machine captures the post-clearance state, stamping the edge with `hitl:biometric-verified`.

---

## 7. Implementation Roadmap & Production Milestones

### Phase M1: Substrate Surface Abstraction (`src/substrate/`)
- Introduce `SubstrateSurface` and `SubstrateSession` interfaces in `src/substrate/types.ts`.
- Refactor `BiDiSession` and `Page` to implement `SubstrateSession` and `SubstrateSurface`.
- **Quality Gate:** Existing web test suite passes 100% with zero regressions.

### Phase M2: Android Direct UIAutomator2 Client (`src/mobile/android/`)
- Implement lightweight direct HTTP/WebSocket client connecting to `127.0.0.1:6790` (over ADB port-forwarding).
- Implement `AndroidTreeWalker`: translates Android UI hierarchy JSON to canonical `AxTreeNode[]`.
- Implement `AndroidSurface`: maps `getRoute()` to top Activity/Fragment.

### Phase M3: iOS WDA Direct Client (`src/mobile/ios/`)
- Implement direct WDA client connecting to `127.0.0.1:8100` (over USB `iproxy`).
- Implement `iOSTreeWalker`: translates `XCUIElement` tree to canonical `AxTreeNode[]`.
- Implement `iOSSurface`: maps `getRoute()` to top UIViewController/SwiftUI view.

### Phase M4: Mobile Touch Kinematic Engine (`src/mobile/kinetics/`)
- Adapt `src/bidi-client/input.ts` Bézier and sinusoidal velocity curves for touch radius and thumb-arc gestures.
- Add multi-touch and pinch-to-zoom support.

### Phase M5: Mobile FSM State Materialization & Biometric HITL Verification
- Wire mobile surfaces into `runObservedExtractor` and `extractStateDeclared`.
- Add integration test suite exercising native Android / iOS sample apps.
- Enforce full constitutional quality gates (Typecheck, check-env, build, test).

