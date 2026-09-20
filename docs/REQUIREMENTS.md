# Original Requirements (DO NOT MODIFY)

> This is the canonical brief, transcribed verbatim on 2026-08-30 from
> the original message that opened the Agent Web Graph project. Every
> later architectural decision is measured against this document. To
> amend, add a dated addendum at the bottom — never edit the brief
> itself. (See ED-05 in `docs/EXECUTIVE_DECISIONS.md`.)

---

# Agent-Native Web Representation Layer
Working concept: WebMap / Agent Web Graph

1. Problem Statement Modern AI agents can increasingly interact with websites, but they still lack a native mental model of a web application. Today, an agent generally interacts with a website in one of three ways:

* visually interpreting screenshots and moving a virtual mouse;
* reading the DOM/accessibility tree and attempting to infer the interface;
* calling structured actions exposed by systems such as WebMCP.

Each approach solves only part of the problem.
WebMCP can expose what an application can do, but it does not necessarily provide a complete representation of what the application is.
An agent may know that an action such as:
`create_database()`
exists, but it may not inherently understand:

* what pages exist in the application;
* how those pages relate to one another;
* where functionality lives;
* what menus and navigation structures exist;
* what is visible on each page;
* how elements are spatially arranged;
* which components are inside other components;
* what appears when something is clicked, hovered, expanded or opened;
* what different UI states look like;
* how the overall product is visually designed.

Humans naturally build this mental model simply by looking at and exploring a website.
Agents currently have to reconstruct it repeatedly.
The problem we want to solve
How can we give an AI agent a complete machine-readable mental model of a website — including its navigation, page structure, visual layout, interactive states and executable capabilities — without requiring the agent to repeatedly explore the website with a mouse and screenshots?
The objective is not simply to make agents better at clicking websites.
The objective is to create a native agent interface to the web.
2. Core Idea
Create a machine-readable representation of an entire web application.
Conceptually:
Human GUI
and, alongside it:
Agent GUI
The Agent GUI would describe the application in a form optimized for machines.
For example:

```
APPLICATION
│
├── Dashboard
│   ├── Header
│   │   ├── Search
│   │   └── User Menu
│   │
│   ├── Sidebar
│   │   ├── Dashboard
│   │   ├── Projects
│   │   ├── Databases
│   │   ├── Billing
│   │   └── Settings
│   │
│   └── Main Content
│       ├── Revenue Chart
│       ├── Usage Chart
│       └── Recent Activity
│
├── Databases
│   ├── Database List
│   ├── Create Database
│   └── Database Details
│
└── Settings
    ├── General
    ├── Appearance
    ├── Users
    └── Security
```

But the representation goes much further than a sitemap.
3. Five Layers of the Representation
Layer 1 — Navigation Graph
The agent should understand the entire application topology.
For example:

```
Dashboard
    ↓
Settings
    ├── General
    ├── Appearance
    ├── Security
    └── Billing
```

Each node would contain things such as:

* URL
* route
* page name
* parent page
* child pages
* navigation links
* breadcrumbs
* menus
* tabs
* possible transitions

This allows the agent to answer:
"Where do I change the theme?"
without manually clicking around looking for it.
It can query the graph and discover:

```
Settings → Appearance → Theme
```

4. Layer 2 — Semantic Page Structure Every page should have a machine-readable component tree. Example:

```
Page: Settings / Appearance

Header
Sidebar
Main
    AppearancePanel
        ThemeSelector
            LightButton
            DarkButton
            SystemButton

        AccentColourSelector

        DensitySelector
```

The agent therefore knows what exists on the page, not merely what text appears there.
5. Layer 3 — Visual Layout
This is the particularly interesting part.
The representation should describe how the page actually looks.
For example:

```
Sidebar
position: left
width: 256px
height: viewport
fixed: true

MainContent
position: right-of Sidebar
padding: 32px
max-width: 1200px

SettingsCard
position: centre
width: 720px

ThemeSelector
layout: horizontal
children:
    Light
    Dark
    System
```

Potential information could include:

* X/Y location
* width
* height
* hierarchy
* spacing
* alignment
* grid structure
* flex relationships
* typography
* colours
* borders
* radius
* visual prominence
* responsive behaviour
* layering/z-index
* component relationships

The agent would therefore have something approaching a structured visual memory of the interface.
Not merely:
"There is a settings button."
But:
"There is a 256-pixel left sidebar. Settings is the fifth navigation item. Selecting it loads a content panel to the right containing four vertically stacked settings categories."
That becomes dramatically more useful for design-oriented agents.
6. Layer 4 — Interaction and State Graph
Web applications aren't static pages.
They contain states.
For example:

```
User Menu
    CLOSED
       ↓ click
    OPEN
       ├── Profile
       ├── Settings
       └── Logout
```

Or:

```
Projects menu

collapsed
    ↓ hover
expanded
    ↓ select project
project page
```

The system therefore needs an interaction state graph.
Possible transitions include:

* click
* hover
* focus
* drag
* scroll
* submit
* expand
* collapse
* open modal
* close modal
* switch tab
* choose dropdown
* authentication
* conditional rendering

This is critical.
Otherwise the agent only understands the static version of the page.
7. Layer 5 — Capabilities / WebMCP
Now combine the representation with structured executable actions.
For example, a page might expose:

```
Page:
Databases

Visual elements:
Create Database button

Capability:
create_database(
    engine,
    region,
    size,
    name
)
```

The Agent Web Graph associates the visual interface with the executable capability.
So the agent knows:
Humans perform this operation through this part of the GUI.
and:
I don't need to manipulate that GUI — I can directly invoke this capability.
This is where WebMCP fits into the architecture.
8. Combined Architecture
Conceptually:

```
                    WEBSITE
                       │
        ┌──────────────┼──────────────┐
        │              │              │
       DOM        Accessibility      CSS
        │              Tree           │
        └──────────────┼──────────────┘
                       │
               WEB EXTRACTOR
                       │
                       ▼
              AGENT WEB GRAPH
                       │
      ┌────────────────┼────────────────┐
      │                │                │
Navigation         Visual Model     State Graph
   Graph
      │                │                │
      └────────────────┼────────────────┘
                       │
                 WebMCP Tools
                       │
                       ▼
                   AI AGENT
```

9. Agent Experience Imagine an agent receives: "Change this application's theme to dark." Instead of starting a browser and looking around, it queries:

```
find("theme")
```

The graph responds:

```
Settings
→ Appearance
→ Theme Selector

Capability:
set_theme(theme)
```

The agent invokes:

```
set_theme("dark")
```

Done.
10. More Powerful Example
Suppose the user says:
"Create a PostgreSQL database for my application."
The agent could search the application graph:

```
query capabilities:
database
postgres
storage
```

It discovers:

```
Databases
    → Create Database

Tool:
create_database

Required:
engine
region
instance_size
storage
```

The agent asks only the information it doesn't know.
Then executes the operation.
There is no reason for it to spend 30 seconds navigating menus with a virtual mouse.
11. Design Understanding Use Case
There's another entirely different capability produced by this system.
A developer could tell an agent:
"Study the layout of this application and build my dashboard using a similar information architecture."
The agent could examine:

```
Navigation hierarchy
Page structure
Component hierarchy
Spacing system
Grid
Typography relationships
Card layouts
Responsive behaviour
Interaction patterns
```

Rather than relying exclusively on screenshots.
A coding agent could therefore reason about the actual structure behind the interface.
12. First Major Technical Component: Browser Extractor
Build a crawler/extractor using something such as:
Chromium + Playwright
It visits a website and extracts:

* DOM
* accessibility tree
* CSS/computed styles
* element bounding boxes
* URLs
* links
* forms
* buttons
* components
* headings
* ARIA roles
* navigation structures
* images
* menus
* tabs
* dialogs
* interactive elements

It then explores possible UI states.
13. State Exploration
The crawler would need to discover things such as:

```
hover(element)
click(element)
expand(element)
focus(element)
open(element)
```

and compare the resulting page state.
For example:

```
STATE 001
Navbar normal

STATE 002
Products hovered
    AI
    Analytics
    Hosting
    Security

STATE 003
AI selected
AI product page
```

These become nodes and transitions in the graph.
14. Representation Schema
One of the most important parts of the project is defining a standard schema.
Something conceptually like:

```
{
  "page": "Settings",
  "route": "/settings",

  "layout": {
    "sidebar": {},
    "main": {}
  },

  "elements": [],

  "navigation": [],

  "states": [],

  "capabilities": []
}
```

The exact schema needs considerable research.
The schema could ultimately be more valuable than the crawler itself.
15. Agent Query Layer
Do not necessarily dump the entire website graph into an LLM context window.
Give the agent tools for interrogating it.
For example:

```
search_site("theme")

find_page("billing")

find_capability("create database")

get_page_structure("/settings")

get_visual_layout("/dashboard")

get_navigation_path("security settings")

get_interactions("user menu")

get_component("sidebar")

get_related_capabilities("/databases")
```

Now the agent can retrieve exactly the information it needs.
16. Critical Requirement: Dynamic Sites
The system must eventually understand that:

```
Website ≠ collection of HTML pages
```

Modern web applications are stateful systems.
Therefore the underlying model should probably be closer to:
application graph
rather than merely:
sitemap.
Nodes represent states.
Edges represent transitions.
Capabilities represent actions.
Visual metadata describes what each state looks like.
17. Authentication
The graph may also change depending on identity.
For example:

```
Anonymous User
    Home
    Pricing
    Login

Authenticated User
    Dashboard
    Projects
    Settings

Administrator
    Dashboard
    Users
    Audit Logs
    Billing
    Organisation Settings
```

Therefore the representation should understand permission-dependent capability graphs.
18. Security Requirement
This is extremely important.
Discoverability does not equal permission.
An agent knowing:

```
delete_account()
```

exists should not automatically mean it can invoke it.
The architecture should distinguish:

```
DISCOVER
READ
PROPOSE
EXECUTE
CONFIRM
```

Potentially:

```
create_database
Risk: medium
Confirmation: required

delete_organisation
Risk: critical
Confirmation: mandatory
```

19. Performance Requirement The graph should be generated once and reused whenever possible. Instead of an agent rediscovering the website during every session:

```
crawl once
      ↓
construct graph
      ↓
cache graph
      ↓
incrementally update
```

Agents can then traverse thousands of interface elements in milliseconds rather than visually browsing them one at a time.
20. MVP
Do not start with:
"Map Azure."
Start with a controlled SaaS application.
Perhaps 5–10 pages containing:

* dashboard
* projects
* users
* billing
* settings
* nested menus
* modal
* dropdown
* hover menu
* form
* tabs
* WebMCP actions

Then prove these five things independently:

1. Discovery Can the system automatically discover the application structure?
2. Navigation Can the agent locate something without manually browsing?
3. Visual understanding Can the agent accurately describe the layout?
4. State understanding Can it understand menus, modals, tabs and hidden interface states?
5. Action execution Can WebMCP capabilities be connected to the relevant parts of the interface?
6. Success Test Give two agents the same task. Traditional browser agent "Find the appearance settings and enable dark mode." It must:

```
inspect screenshot
move mouse
click settings
wait
inspect screenshot
find appearance
click
inspect
click dark mode
```

Agent Web Graph
It performs:

```
search("dark mode")

→ Settings / Appearance
→ set_theme("dark")

execute
```

Then measure:

* time
* number of model calls
* number of screenshots
* tokens consumed
* mistakes
* latency
* task completion rate

That gives us empirical evidence that the architecture works.
22. Longer-Term Vision
Eventually, instead of every AI company inventing another browser-control system, websites could expose two interfaces:

```
Human Interface
     +
Agent Interface
```

The human interface remains HTML/CSS/JavaScript.
The agent interface contains:

```
Structure
Navigation
Visual representation
Interaction states
Capabilities
Permissions
Semantics
```

WebMCP could provide the hands.
The Agent Web Graph provides the map and spatial understanding.
Vision can still provide the eyes when necessary.
And the LLM provides the reasoning.
So the architecture becomes:
Eyes + Map + Hands + Brain.

---

## Addenda

(None yet. To amend the brief, add a dated addendum below this line —
do not edit the brief above.)
