// Synthetic SaaS demo — minimal interactivity so the crawler's
// behavior extractor observes real DOM diffs and real dispatchEvent calls.
//
// The crawler doesn't require this script to function; without it the page
// still has full a11y semantics. With it, the behavioral extractor sees
// realistic state transitions (popover open, dialog open, tab swap, combobox
// filter, theme toggle).

(function () {
  "use strict";

  // ---- Tabs (manual ARIA, no roving tabindex yet) ----
  const tablist = document.querySelector('[role="tablist"]');
  if (tablist) {
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => activateTab(tab));
      tab.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowRight") {
          ev.preventDefault();
          const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
          next.focus(); activateTab(next);
        } else if (ev.key === "ArrowLeft") {
          ev.preventDefault();
          const prev = tabs[(tabs.indexOf(tab) - 1 + tabs.length) % tabs.length];
          prev.focus(); activateTab(prev);
        }
      });
    });
  }
  function activateTab(tab) {
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.setAttribute("tabindex", on ? "0" : "-1");
    });
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    if (panel) {
      const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
      panels.forEach((p) => { p.hidden = p !== panel; });
    }
  }

  // ---- Combobox: filter a static list as the user types ----
  const search = document.getElementById("docs-search");
  const listbox = document.getElementById("docs-suggestions");
  if (search && listbox) {
    const docs = [
      "Getting started",
      "Authentication",
      "API reference",
      "Webhooks",
      "Billing and subscriptions",
      "Security overview",
      "Rate limits",
      "Glossary",
    ];
    let activeIndex = -1;
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      if (q.length < 2) {
        listbox.hidden = true;
        search.setAttribute("aria-expanded", "false");
        return;
      }
      const matches = docs.filter((d) => d.toLowerCase().includes(q));
      listbox.innerHTML = matches.map((d, i) =>
        `<li role="option" id="opt-${i}"${i === activeIndex ? ' aria-selected="true"' : ""}>${d}</li>`
      ).join("");
      listbox.hidden = matches.length === 0;
      search.setAttribute("aria-expanded", matches.length > 0 ? "true" : "false");
    });
    listbox.addEventListener("click", (ev) => {
      const li = ev.target.closest('[role="option"]');
      if (!li) return;
      search.value = li.textContent || "";
      listbox.hidden = true;
      search.setAttribute("aria-expanded", "false");
    });
    search.addEventListener("keydown", (ev) => {
      if (listbox.hidden) return;
      const options = Array.from(listbox.querySelectorAll('[role="option"]'));
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        activeIndex = (activeIndex + 1) % options.length;
        paintActive(options);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        activeIndex = (activeIndex - 1 + options.length) % options.length;
        paintActive(options);
      } else if (ev.key === "Enter" && activeIndex >= 0) {
        ev.preventDefault();
        search.value = options[activeIndex].textContent || "";
        listbox.hidden = true;
        search.setAttribute("aria-expanded", "false");
      } else if (ev.key === "Escape") {
        listbox.hidden = true;
        search.setAttribute("aria-expanded", "false");
      }
    });
    function paintActive(options) {
      options.forEach((o, i) => o.setAttribute("aria-selected", i === activeIndex ? "true" : "false"));
    }
  }

  // ---- Theme toggle (custom invoker command target) ----
  const themeBtn = document.getElementById("theme-toggle");
  const themeLabel = document.getElementById("theme-label");
  if (themeBtn && themeLabel) {
    themeBtn.addEventListener("click", () => {
      const next = themeLabel.textContent === "light" ? "dark" : "light";
      themeLabel.textContent = next;
      document.documentElement.dataset.theme = next;
    });
  }

  // ---- Sign-out dialog (return value surfaces) ----
  const signoutDialog = document.getElementById("confirm-signout");
  if (signoutDialog) {
    signoutDialog.addEventListener("close", () => {
      // dispatched on close so the behavioral extractor can observe
      // "after dialog close" snapshot
      window.dispatchEvent(new CustomEvent("awg:signout-decided", {
        detail: { returnValue: signoutDialog.returnValue },
      }));
    });
  }

  // ---- Route-driven conditional rendering (?filter=...) ----
  // The /projects.html page hides list items whose
  // [data-project-status] doesn't match the active filter, and
  // stamps the chosen filter on the list element so the substrate
  // sees a route-driven state.
  const projectList = document.getElementById("project-list");
  if (projectList) {
    const params = new URLSearchParams(window.location.search);
    const filter = params.get("filter") || "all";
    projectList.dataset.activeFilter = filter;
    Array.from(projectList.querySelectorAll("[data-project-status]")).forEach((el) => {
      const status = el.getAttribute("data-project-status");
      el.hidden = filter !== "all" && status !== filter;
    });
  }

  // ---- Auth context — render exactly one
  //      [data-condition="auth:<kind>"] section, set the
  //      <html data-auth-kind> attribute, and stamp the resolved
  //      principal/role on the body for the extractor.
  //
  // Resolution order (PR-8d T6):
  //   1. `?as=<spec>` query param (manual switcher on /settings)
  //   2. `awg-role` cookie (custom-role, set by BiDi storage)
  //   3. `role=admin` cookie (administrator, set by BiDi storage)
  //   4. `principal` cookie (authenticated, set by BiDi storage)
  //   5. anonymous
  //
  // The cookies are attached to the target origin by BiDi before
  // navigation, so the page sees them in `document.cookie` from
  // the very first render. The page stamps the resolved principal
  // and role on the body so the observed extractor can read them. ----
  {
    function readCookie(name) {
      const prefix = name + "=";
      const parts = (document.cookie || "").split(/;\s*/);
      for (const p of parts) {
        if (p.startsWith(prefix)) return decodeURIComponent(p.slice(prefix.length));
      }
      return null;
    }
    const params = new URLSearchParams(window.location.search);
    let as = params.get("as");
    if (!as) {
      const role = readCookie("awg-role");
      const admin = readCookie("role");
      const principal = readCookie("principal");
      if (role) as = `custom-role:${role}:${principal || "anon"}:cookie`;
      else if (admin === "admin") as = `administrator:${principal || "anon"}:cookie`;
      else if (principal) as = `authenticated:${principal}:cookie`;
    }
    const kind = (as || "anonymous").split(":")[0];
    document.documentElement.dataset.authKind = kind;
    const principal = readCookie("principal") || (as && as.split(":")[1]) || "";
    const role = readCookie("awg-role") || readCookie("role") || "";
    if (principal) document.body.dataset.principal = principal;
    if (role) document.body.dataset.role = role;
    Array.from(document.querySelectorAll("[data-condition]")).forEach((el) => {
      const expr = el.getAttribute("data-condition") || "";
      el.hidden = !expr.split("|").map((s) => s.trim()).includes("auth:" + kind);
    });
  }

  // ---- Network/async-driven state ----
  // The "Load more" button on /tickets.html?type=open (if present)
  // fetches a stub payload after a short delay. The crawler's
  // network-wait probe takes a snapshot after the fetch settles.
  const loadMore = document.getElementById("btn-load-more");
  if (loadMore) {
    loadMore.addEventListener("click", async () => {
      const before = loadMore.textContent;
      loadMore.textContent = "Loading…";
      loadMore.setAttribute("aria-busy", "true");
      // Simulate a 250ms network round-trip.
      await new Promise((r) => setTimeout(r, 250));
      const list = document.getElementById("ticket-list");
      if (list) {
        for (let i = 0; i < 3; i++) {
          const li = document.createElement("li");
          li.textContent = `Loaded ticket #${Math.floor(Math.random() * 10000)}`;
          list.appendChild(li);
        }
      }
      loadMore.textContent = before;
      loadMore.removeAttribute("aria-busy");
    });
  }

  // ---- Feature-X conditional rendering (?feature-x=on) ----
  // The /index.html page hides a card by default. If the URL has
  // ?feature-x=on, the card is shown. The button inside the card
  // hides it again. The substrate's "conditional" probe takes a
  // snapshot of each state.
  {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("feature-x");
    const featureBlock = document.getElementById("feature-x-block");
    if (featureBlock) {
      featureBlock.hidden = flag !== "on";
    }
    const hideBtn = document.getElementById("btn-toggle-feature-x");
    if (hideBtn) {
      hideBtn.addEventListener("click", () => {
        if (featureBlock) featureBlock.hidden = true;
      });
    }
    const showBtn = document.getElementById("btn-show-feature-x");
    if (showBtn) {
      showBtn.addEventListener("click", () => {
        if (featureBlock) featureBlock.hidden = false;
      });
    }
  }
})();
