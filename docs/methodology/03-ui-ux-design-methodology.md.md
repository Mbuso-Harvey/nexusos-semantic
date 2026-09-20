# 03 — UI/UX Design Methodology

> **Use this when:** You need the application to look professional, polished, and
> trustworthy — without hiring a designer or inventing anything from scratch.

---

## The Core Rule: Copy, Don't Invent

Every visual element, interaction pattern, spacing value, font size, animation curve,
and layout decision MUST be traceable to a specific element from one of THREE
inspiration products:

| # | Product | Best For |
|---|---|---|
| 1 | **Gemini** (Google) | Home screens, gradient auras, glassmorphism, color systems, cards |
| 2 | **ChatGPT** (OpenAI) | Chat UI, message bubbles, typing indicators, voice input, file upload |
| 3 | **Copilot** (GitHub/Microsoft) | Sidebar navigation, settings panels, pack management, code views |

**If you can't name which product a design element came from, you're inventing. STOP.**

---

## Why This Works

These three products have been tested by BILLIONS of users. Their design patterns
are proven, accessible, and trusted. Copying them gives you:

- **Instant credibility** — users recognize familiar patterns
- **Battle-tested accessibility** — these companies have a11y teams
- **Zero design debt** — no arguing about button sizes or font weights
- **Faster implementation** — no design iteration, just reference → implement

---

## The Design-by-Reference Method

### Step 1: Inventory Your Screens

List every screen/page in your application:
- Home screen
- Chat/conversation view
- Settings panel
- File browser
- Search results
- Profile/account
- etc.

### Step 2: Assign Inspiration Sources

For EACH screen, pick which product to reference:

```
Home screen      → Gemini (gradient aura, hero CTA, capability cards)
Chat view        → ChatGPT (message bubbles, typing dots, input bar)
Settings         → Copilot (grouped toggles, accent switches, gear icon)
Sidebar          → Copilot (icon nav, collapse behavior, tier badge)
Voice input      → ChatGPT (pill button, waveform bars, "Listening…" label)
File upload      → ChatGPT (drag zone, file chips, progress bar)
Permission modal → Copilot (inline dialog, shield icon, stacked buttons)
```

### Step 3: Extract Specific Elements

For each assigned product, identify EXACT elements to copy:

**From Gemini** (go to gemini.google.com):
- Home screen: centered gradient aura behind hero text
- Color: their accent purple → your `--accent`
- Cards: subtle border, 12px radius, surface background
- Typography: 600 semibold headings, never 700 bold
- Spacing: generous padding (24-32px sections)

**From ChatGPT** (go to chatgpt.com):
- Message bubbles: user right-aligned with accent bg, assistant left-aligned
- Typing indicator: 3 bouncing dots + "Thinking…" label
- Input bar: rounded pill, send button inside, mic button left
- Voice: pill-shaped recording button with waveform + "Listening…"
- File chips: Phosphor icons, 1px border, pill shape

**From Copilot** (go to github.com/copilot):
- Sidebar: Phosphor icons, collapse toggle, active state fill weight
- Settings: grouped sections, toggle switches, accent color on active
- Pack management: cards with icon + name + version + status
- Code blocks: monospace font, subtle background, copy button

### Step 4: Build the Token System

Extract actual color values from screenshots or DevTools:

```css
:root {
  /* Sampled from Gemini light mode */
  --bg: #ffffff;
  --bg-surface: #f7f7f8;
  --fg: #1a1a2e;

  /* Sampled from ChatGPT */
  --accent: #6366f1;      /* ChatGPT's purple accent */
  --border: #e5e5ea;      /* ChatGPT's subtle borders */

  /* Spacing from all three (they all use 4px scale) */
  --space-compact: 8px;
  --space-standard: 16px;
  --space-relaxed: 24px;
}
```

**Never guess a color value.** Open DevTools on the real product and sample it.

---

## The Phosphor Icon Standard

Use `@phosphor-icons/react` exclusively. Never use emoji for UI icons.

**Conventions**:
- Default: `Regular` weight, `20px` size
- Active/navigation: `Fill` weight
- Interactive elements: `40px` minimum touch target
- Every icon button: `aria-label` attribute

**Common icon mappings**:

| Purpose | Phosphor Icon | Weight |
|---|---|---|
| Chat | `ChatTeardropDots` | Regular / Fill |
| Home | `House` | Regular / Fill |
| Settings | `Gear` | Regular / Fill |
| History | `ClockCounterClockwise` | Regular |
| Files/Folder | `Folder` | Regular |
| Search | `MagnifyingGlass` | Regular |
| Send message | `PaperPlaneTilt` | Fill |
| Microphone | `Microphone` | Regular / Fill |
| Stop | `Stop` | Fill |
| Shield/Security | `ShieldCheck` | Regular |
| Download | `DownloadSimple` | Regular |
| Upload | `UploadSimple` | Regular |
| Warning | `WarningCircle` | Regular |
| Close/Delete | `X` | Regular |
| Expand menu | `List` | Regular |
| Collapse menu | `X` | Regular |
| Light mode | `SunDim` | Regular |
| Dark mode | `Moon` | Regular |
| System mode | `Monitor` | Regular |
| Phone/Voice call | `PhoneCall` | Regular |
| Speaker/TTS | `SpeakerHigh` | Regular |
| Info | `Info` | Regular |
| Check/Confirm | `Check` | Regular |
| Copy | `Copy` | Regular |
| External link | `ArrowSquareOut` | Regular |

**Verify before using**: Phosphor has 1,488 icons. Some names changed between versions.
Always check: https://phosphoricons.com/

---

## Animation Standards

### Rules
- **Duration**: 150–250ms (never slower than 300ms for micro-interactions)
- **Easing**: `ease-out` for appear/enter, `ease-in-out` for transitions
- **Purpose**: Every animation must serve a function (feedback, guidance, state change)

### Common Animations (All Traced to ChatGPT or Gemini)

| Animation | Source | Duration | Easing | Keyframe |
|---|---|---|---|---|
| Message bubble appear | ChatGPT | 250ms | ease-out | slide-up 8px + scale 0.98→1 |
| Sidebar collapse | Copilot | 200ms | ease-out | opacity fade on inner elements |
| Shimmer skeleton | Gemini | 1.8s | ease-in-out | gradient slide across element |
| Typing dots | ChatGPT | 1.4s per dot | ease-in-out | scale 0.6→1 with stagger |
| Modal appear | Copilot | 150ms | ease-out | fade in backdrop, slide-down dialog |
| Voice waveform | ChatGPT | continuous | N/A | Canvas rAF loop, sin wave bars |

### Reduced Motion Guard (MANDATORY)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0s !important;
    transition-duration: 0s !important;
  }
}

html.reduce-motion *, 
html.reduce-motion *::before, 
html.reduce-motion *::after {
  animation-duration: 0s !important;
  transition-duration: 0s !important;
}
```

---

## Accessibility (Non-Negotiable)

### Minimum Requirements

| Requirement | Standard | How to Verify |
|---|---|---|
| Touch targets | 40px minimum | CSS: all interactive elements ≥ 40px in at least one dimension |
| Icon labels | aria-label on all icon-only elements | Audit: grep for `<Icon` without `aria-label` |
| Color contrast | 4.5:1 minimum (WCAG AA) | Use high contrast mode CSS swap |
| Focus states | Visible on all interactive elements | Tab through the app — every element shows focus ring |
| Reduced motion | Toggle in settings + respects OS pref | Two methods: CSS media query + manual class toggle |
| High contrast | Toggle in settings | Swaps all CSS variables for black-on-white or white-on-black |
| Screen reader | All UI text in DOM (not Canvas-only) | Use semantic HTML, aria-current for active nav |

---

## CSS Rules (MANDATORY)

### Colors
```css
/* ✅ CORRECT */
color: var(--accent);
border: 1px solid var(--border);
background: var(--danger, #e5484d);   /* Always provide fallback */

/* ❌ WRONG */
color: #6366f1;
border: 1px solid #e5e5ea;
```

### Semi-Transparent Variants
```css
/* ✅ CORRECT — use color-mix() */
background: color-mix(in srgb, var(--accent) 12%, transparent);

/* ❌ WRONG — don't guess opacity */
background: rgba(99, 102, 241, 0.12);
```

### CSS Nesting
```css
/* ✅ CORRECT — separate blocks for @media */
.shimmer-line { animation: shimmer-slide 1.8s infinite; }

@media (prefers-reduced-motion: reduce) {
  .shimmer-line { animation: none; }
}

/* ❌ WRONG — esbuild doesn't support @media nesting */
.shimmer-line {
  animation: shimmer-slide 1.8s infinite;
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
}
```

---

## Common UI Patterns (With Exact Sources)

### Typing Indicator — ChatGPT

```
[●] [●] [●]  Thinking…
 ↑   ↑   ↑    ↑
 3 bouncing dots + label, 1.4s staggered animation each
 ChatGPT does exactly this — 3 gray dots, then "ChatGPT is thinking…"
```

Implementation: 3 `<span className="chat-typing-dot">` elements with staggered
`animation-delay` (0s, 0.2s, 0.4s), plus a `<span className="chat-typing-label">`.

### Shimmer Skeleton — Gemini

```
┌──────────────────────────────┐
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  ← shimmer-card
│ ░░░░░░░░░░░░░░░░░░░░░░░░     │
└──────────────────────────────┘
```

Gemini uses gradient sweeps across placeholder blocks during loading.
Implementation: `linear-gradient(90deg, var(--bg-surface) 25%, color-mix(...) 50%, var(--bg-surface) 75%)`
with `background-size: 200% 100%` and `animation: shimmer-slide 1.8s infinite`.

### Message Bubbles — ChatGPT

```
                    ┌──────────────────┐
                    │ User message     │  ← accent bg, right-aligned
                    └──────────────────┘
┌──────────────────┐
│ Assistant reply  │                    ← surface bg, left-aligned
└──────────────────┘
```

ChatGPT: user messages accent-colored, right side. Assistant messages neutral, left side.
Both have 12px border-radius, 12-16px padding, 14px font.

### Voice Recording — ChatGPT

```
┌──────────────────────────────┐
│ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓  Listening…  │  ← pill shape, accent color
└──────────────────────────────┘
```

ChatGPT's mobile app: pill-shaped button with 5-bar waveform + "Listening…" label.
Implementation: Canvas element with rAF animation loop drawing rounded bars
with sin-wave height variation.

### Settings Panel — Copilot

```
⚙ Settings
────────────────────
Appearance    ○ System  ○ Light  ○ Dark
────────────────────
Accessibility
  Reduced motion   [toggle ●]
  High contrast    [toggle ○]
```

Copilot: grouped settings with section dividers, pill-shaped option selectors,
accent-colored toggle switches. Gear icon in nav.

### Sidebar Navigation — Copilot

```
┌──────┐
│  🏠  │  ← House icon, Fill weight when active
│  💬  │  ← ChatTeardropDots, Regular when inactive
│  📁  │  ← Folder, collapsed: icon only
│  ⚙   │  ← Gear, expanded: icon + label
│      │
│ Lite │  ← Tier badge at bottom
└──────┘
```

Copilot sidebar: Phosphor icons, Fill weight for active, Regular for inactive,
collapse toggle switches to icon-only mode. Tier badge at bottom.

---

## The Tracker Format for UI Tasks

Every UI task in the implementation tracker MUST have an Inspiration Source:

```markdown
| P9.6.2.3 | Typing indicator: 3 bouncing dots + "Thinking…" label | Plan 162 | ✅ DONE | ChatGPT |
| P9.6.2.14 | Voice recording waveform visualization | Plan 167 | ✅ DONE | ChatGPT |
| P9.6.1.1 | Home screen gradient aura background | Plan 140 | ✅ DONE | Gemini |
| P9.8.1.3 | Sidebar collapse fade transitions | Plan 178 | ✅ DONE | Copilot |
| P9.6.4.1 | Knowledge view shimmer loading grid | Plan 230 | ✅ DONE | Gemini |
```

**If the Inspiration Source column is empty for a UI task, the task is NOT ready to implement.**

---

## FOUC Prevention (Flash of Unstyled Content)

Dark mode must apply BEFORE first paint:

```tsx
// ThemeProvider — useLayoutEffect runs synchronously before paint
useLayoutEffect(() => {
  const stored = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (stored === 'dark' || (!stored && prefersDark)) {
    document.documentElement.classList.add('dark');
  }
}, []);
```

---

## Build Verification for UI Work

After any CSS change:
```bash
pnpm tsc -p tsconfig.renderer.json --noEmit   # 0 errors
pnpm build                                      # 0 errors, 0 CSS warnings
```

esbuild CSS minifier will warn about:
- CSS nesting with @media (not supported)
- Invalid color-mix() syntax
- Missing fallback values

Fix ALL warnings before committing.

---

## Summary Checklist

Before submitting any UI work:
- [ ] Every visual element cites Gemini, ChatGPT, or Copilot
- [ ] All colors use `var()` with fallbacks
- [ ] Phosphor icons verified to exist
- [ ] All icon buttons have `aria-label`
- [ ] Touch targets ≥ 40px
- [ ] Animations have reduced-motion guard
- [ ] Dark mode tested (FOUC-free)
- [ ] High contrast mode tested
- [ ] `pnpm tsc` 0 errors
- [ ] `pnpm build` 0 warnings
- [ ] Tracker Inspiration Source column populated for all UI items

---

*Part of the [Copilot Project Methodology](./README.md).*