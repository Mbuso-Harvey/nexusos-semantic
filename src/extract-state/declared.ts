/**
 * extract-state/declared — Stage 7.1 (declared half).
 *
 * Statically extracts every transition implied by the HTML in the page.
 * Plan section 7.1.
 *
 * Sources (per 7.1):
 *   1. [command][commandfor] (Invoker Commands).
 *      Known kinds: toggle-popover, show-modal, close, hide-popover,
 *      show-popover, toggle-button. For these, target = element with the
 *      matching id referenced by commandfor.
 *      Custom (--foo): target = closest ancestor <button command="--foo">.
 *   2. [popovertarget] — paired with [popover] element.
 *   3. <dialog open> or <dialog> triggered by a button.
 *   4. <a href> — link edge only (no transition).
 *   5. APG pattern match — for AX nodes whose role is one of
 *      {tablist, tab, tabpanel, dialog, menu, menubar, listbox, combobox,
 *       tree, accordion, grid, disclosure, alertdialog} set apgPattern and
 *      record declared transitions implied by the pattern (e.g. for tabs,
 *      "focus next tab -> activates tabpanel" is implied).
 *
 * PR-8a (Layer 1 finalization): the same page walker now also emits
 *   6. Breadcrumb chains — every <nav aria-label="breadcrumb"> (or
 *      <ol aria-label~="breadcrumb"> / <ol aria-label~="crumb">).
 *      Records: kind: "breadcrumb", fromAxId = container nav, order.
 *   7. NavElement records — one per <menu>, [role=menubar],
 *      [role=tablist], and <nav> link container. Records carry
 *      kind: "nav-element", memberAxIds, activeMemberAxId.
 *   8. state:cause placeholder records — one per commandfor,
 *      popovertarget, dialog-open, and apg-tab-activate source axId.
 *      The to-side is the documented placeholder state id; PR-8 T6
 *      resolves the placeholder to the real State node id.
 *
 * IDs:
 *   edge:    edge:<from>-><to>:<kind>
 *   trans:   trans:<kind>-<axId>-<n>
 *   nav:     nav:<pageId>:<kind>:<n>            (NavElement nodes)
 *   state:   state:TBD:<fromAxId>:<kind>        (placeholder, PR-8 T6)
 *
 * Provenance: html:parse for everything emitted here.
 */
import type { Extractor, ExtractorContext } from "../crawler/orchestrator.js";
import type {
  Edge, Transition, NavElement, EdgeKind, TransitionTrigger, ApgPattern,
  NavElementKind, AuthContext, AxNode, ElementStateObservation,
} from "../graph/types.js";
import {
  materializeSuccessor, resolveStateCauseEdges,
  type MaterializeSnapshot,
} from "./state-materialize.js";

// ----- Page-side script -----
//
// We walk the DOM once and emit a flat list of records. The record shape is
// deliberately simple so the test can mock it. The page-side script never
// references outer JS (BiDi deserializes it in the target realm) — the only
// closure is on `pageNodeId` which is passed as a script argument.
//
// Exported so PR-8c T8's end-to-end test can drive the actual walker
// body in a Node VM with a minimal document shim, proving the wiring
// is real, not a unit-test claim about the function body.
export const PAGE_SCRIPT = `(pageNodeId) => {
  const out = [];
  // PR-8c T1: canonical pre-order walk produces the same axIds as the
  // structural extractor. Root = index 0. The walk is the same one
  // observed.ts and visual.ts use (see AXID_JS_BODY).
  const idxOf = new Map();
  {
    const root = document.documentElement;
    idxOf.set(root, 0);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let node; let i = 1;
    while ((node = walker.nextNode())) { idxOf.set(node, i); i++; }
  }
  // PR-8d (item 1): the canonical AxNode id has NO href special case.
  // An anonymous <a> without an explicit id gets the same axId (n<index>)
  // as every other element at the same pre-order slot. The href value
  // is preserved as a separate property on the link record, never
  // woven into the AxNode id.
  const axIdFor = (el) => {
    if (el.id) return 'ax:' + pageNodeId + ':' + el.id;
    const idx = idxOf.get(el);
    if (idx === undefined) {
      const parent = el.parentElement;
      let sibIdx = 0;
      if (parent) for (let s = el.previousElementSibling; s; s = s.previousElementSibling) sibIdx++;
      return 'ax:' + pageNodeId + ':dyn:' + (el.tagName || '') + ':' + sibIdx;
    }
    return 'ax:' + pageNodeId + ':n' + idx;
  };
  // Map a role/element to an APG role key (used to look up declared vocab).
  const apgRoleFor = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    const tag = el.tagName;
    if (explicit === 'tablist' || tag === 'TABLIST') return 'tablist';
    if (explicit === 'tab' || tag === 'TAB') return 'tab';
    if (explicit === 'tabpanel') return 'tabpanel';
    if (explicit === 'dialog') return 'dialog';
    if (explicit === 'alertdialog') return 'alertdialog';
    if (explicit === 'menu' || tag === 'MENU') return 'menu';
    if (explicit === 'menubar') return 'menubar';
    if (explicit === 'listbox') return 'listbox';
    if (explicit === 'combobox') return 'combobox';
    if (explicit === 'tree' || tag === 'TREE') return 'tree';
    if (explicit === 'treeitem') return 'treeitem';
    if (tag === 'DIALOG') return 'dialog';
    if (el.tagName === 'DETAILS') return 'disclosure';
    return null;
  };
  // Collect tabs grouped by their owning tablist, by DOM order, so we can
  // emit "focus next tab -> activates tabpanel" transitions.
  const collectTabs = () => {
    const lists = document.querySelectorAll('[role="tablist"], tablist');
    const groups = [];
    for (const list of lists) {
      const tabs = [];
      list.querySelectorAll('[role="tab"], tab').forEach((t) => tabs.push(t));
      groups.push({ list, tabs });
    }
    return groups;
  };
  const tabGroups = collectTabs();
  const apgByAxId = {};
  for (const g of tabGroups) {
    for (const t of g.tabs) {
      apgByAxId[axIdFor(t)] = 'tabs';
    }
    if (g.list.id) apgByAxId['ax:' + pageNodeId + ':' + g.list.id] = 'tabs';
  }

  for (const el of document.querySelectorAll('*')) {
    const href = el.getAttribute && el.getAttribute('href');
    const fromAxId = axIdFor(el);

    // --- <a href> ---
    // PR-8d (item 1): the link target id is a separate sentinel
    // (the form "link:<pageNodeId>:<href>") — not an AxNode id. The
    // structural extractor does NOT mint an AxNode for the URL; the
    // link edge resolves to the target page via the orchestrator's
    // nav-link post-pass. Keeping the sentinel out of the AxNode id
    // namespace is what allows all four extractors to agree on the
    // same axId for an anonymous <a>.
    if (el.tagName === 'A' && href) {
      out.push({
        fromAxId,
        toAxId: 'link:' + pageNodeId + ':' + href,
        kind: 'link',
        hrefValue: href,
      });
    }

    // --- [command][commandfor] (Invoker Commands) ---
    // PR-8c T8: the trigger is the actual command value, not the
    // generic 'command'. show-modal -> 'command-show-modal',
    // show-popover -> 'command-show-popover', etc. Custom invoker
    // commands (e.g. '--play-video') keep the legacy 'command'
    // trigger because they have no canonical mapping.
    const command = el.getAttribute && el.getAttribute('command');
    const commandfor = el.getAttribute && el.getAttribute('commandfor');
    if (command && commandfor) {
      const isCustom = command.startsWith('--');
      let toAxId = null;
      if (isCustom) {
        // Custom invoker command: target = closest ancestor <button command="--foo">.
        let a = el.parentElement;
        while (a) {
          if (a.tagName === 'BUTTON' && a.getAttribute('command') === command) {
            toAxId = axIdFor(a);
            break;
          }
          a = a.parentElement;
        }
      } else {
        const t = document.getElementById(commandfor);
        if (t) toAxId = 'ax:' + pageNodeId + ':' + commandfor;
      }
      if (toAxId) {
        out.push({
          fromAxId,
          toAxId,
          kind: 'commandfor',
          transitionKind: 'declared',
          // PR-8c T8: preserve the actual command value as the trigger.
          // For known invoker commands (show-modal, show-popover,
          // toggle-popover, hide-popover, close, request-close), map
          // to a typed trigger. For custom commands, keep 'command'.
          trigger: (command === 'show-modal') ? 'command-show-modal'
                : (command === 'show-popover') ? 'command-show-popover'
                : (command === 'toggle-popover') ? 'command-toggle-popover'
                : (command === 'hide-popover') ? 'command-hide-popover'
                : (command === 'close') ? 'command-close'
                : (command === 'request-close') ? 'command-request-close'
                : 'command',
          commandValue: command,
        });
      }
    }

    // --- [popovertarget] paired with [popover] element ---
    const popovertarget = el.getAttribute && el.getAttribute('popovertarget');
    if (popovertarget) {
      const t = document.getElementById(popovertarget);
      // Must have the popover attribute (or popover="auto"/"manual").
      if (t && (t.hasAttribute('popover') || (t.getAttribute && t.getAttribute('popover') !== null))) {
        out.push({
          fromAxId,
          toAxId: 'ax:' + pageNodeId + ':' + popovertarget,
          kind: 'popovertarget',
          transitionKind: 'declared',
          trigger: 'popover',
        });
      }
    }

    // --- <dialog> open or triggered by a button ---
    if (el.tagName === 'DIALOG') {
      // (a) already-open dialogs
      if (el.hasAttribute('open')) {
        // PR-8c T1: dialog toAxId uses the canonical axId (via
        // axIdFor), not a counter-minted "dialog:N" id. If the
        // dialog has no element id, its canonical id falls back to
        // its pre-order index.
        out.push({
          fromAxId: 'ax:' + pageNodeId + ':' + pageNodeId,
          toAxId: axIdFor(el),
          kind: 'dialog-open',
          transitionKind: 'declared',
          trigger: 'dialog',
        });
      }
      // (b) dialogs triggered by a button via commandfor=show-modal
      // PR-8c T8: the trigger reflects the actual command value
      // (show-modal -> 'command-show-modal'). A dialog could
      // also be opened by a button via command='show-popover'
      // (uncommon) — preserve that command-specific trigger too.
      if (el.id) {
        const trigs = document.querySelectorAll('[commandfor="' + el.id + '"]');
        for (const b of trigs) {
          const btnCmd = b.getAttribute('command') || '';
          if (btnCmd === 'show-modal' || btnCmd === 'show-popover' || btnCmd === 'close') {
            out.push({
              fromAxId: axIdFor(b),
              toAxId: 'ax:' + pageNodeId + ':' + el.id,
              kind: 'dialog-open',
              transitionKind: 'declared',
              trigger: (btnCmd === 'show-modal') ? 'command-show-modal'
                    : (btnCmd === 'show-popover') ? 'command-show-popover'
                    : (btnCmd === 'close') ? 'command-close'
                    : 'dialog',
              commandValue: btnCmd,
            });
          }
        }
      }
    }

    // --- PR-8g T2: choose-dropdown (real production transition) ---
    // Per blocker 2 of the PR-8g binding instruction: "Implement
    // choose-dropdown as real production transition. Real native
    // <select> and combobox/listbox. No enum-only satisfaction."
    //
    // For a native <select> with at least 2 <option>s, the
    // declared half emits a 'state:cause' transition from the
    // select to the (initially-selected) option, with trigger
    // 'choose-dropdown'. This is the declared form of "selecting
    // an option changes the state of the select". The observed
    // path then produces a state:successor edge with the same
    // trigger when the probe fires a real 'change' event.
    //
    // For an ARIA combobox/listbox with a non-empty option set,
    // emit a 'state:cause' transition from the combobox/listbox
    // to the listbox (or to the first non-active option) with
    // trigger 'choose-dropdown'. Same idea, different target.
    if (el.tagName === 'SELECT') {
      const opts = el.querySelectorAll('option');
      if (opts.length >= 2) {
        // The "default" option is the one that is currently
        // selected (i.e. the select.value). The transition's
        // toAxId points to that option's axId, so the
        // declared+observed convergence can find the
        // corresponding State node by sourceAxId.
        const defaultOption = Array.from(opts).find(
          (o) => !o.disabled && (o.value === el.value || o.hasAttribute('selected')),
        ) || opts[0];
        out.push({
          fromAxId,
          toAxId: axIdFor(defaultOption),
          kind: 'state:cause',
          transitionKind: 'declared',
          trigger: 'choose-dropdown',
          apgPattern: 'combobox',
          optionValue: defaultOption.value,
        });
      }
    } else if (el.getAttribute && (el.getAttribute('role') === 'combobox' || el.getAttribute('role') === 'listbox')) {
      // ARIA combobox/listbox. The listbox is either a child
      // [role="listbox"] or one referenced via aria-controls. We
      // emit a 'state:cause' transition from the combobox/listbox
      // to the listbox itself; the observed path produces a
      // state:successor edge with trigger='choose-dropdown' when
      // the probe fires a real DOM event.
      let listbox = el.querySelector('[role="listbox"]');
      if (!listbox) {
        const controlsId = el.getAttribute('aria-controls');
        if (controlsId) listbox = document.getElementById(controlsId);
      }
      if (listbox) {
        out.push({
          fromAxId,
          toAxId: axIdFor(listbox),
          kind: 'state:cause',
          transitionKind: 'declared',
          trigger: 'choose-dropdown',
          apgPattern: el.getAttribute('role') === 'combobox' ? 'combobox' : 'listbox',
        });
      }
    }

    // --- APG pattern recording (no edges/transitions here, just apgPattern hint) ---
    const apgRole = apgRoleFor(el);
    if (apgRole) {
      out.push({
        fromAxId,
        toAxId: null,
        kind: 'apg',
        apgRole,
      });
    }
  }

  // --- APG pattern vocab: tablist -> tabs activate tabpanels ---
  // For each tablist, emit "focus next tab -> activates tabpanel" as a declared
  // transition from each tab to its corresponding tabpanel (resolved by
  // aria-controls). The fromAxId is the tab; toAxIds is the tabpanel(s).
  for (const g of tabGroups) {
    for (let i = 0; i < g.tabs.length; i++) {
      const t = g.tabs[i];
      const controls = t.getAttribute('aria-controls');
      if (!controls) continue;
      const tabAxId = axIdFor(t);
      out.push({
        fromAxId: tabAxId,
        toAxId: 'ax:' + pageNodeId + ':' + controls,
        kind: 'apg-tab-activate',
        transitionKind: 'declared',
        trigger: 'focus',
        apgPattern: 'tabs',
      });
    }
  }

  // --- PR-8a: breadcrumb chains (Layer 1 breadcrumb NavElements) ---
  // Per the brief §3, the navigation graph also describes the *order* in
  // which a user traversed to arrive at this page. We emit a NavElement
  // record per breadcrumb container. The container axId is the <nav>'s
  // axId; memberAxIds is the ordered list of the breadcrumb items'
  // axIds (in DOM order, which is the order the user sees).
  const collectBreadcrumbItems = (nav) => {
    // The <nav aria-label="breadcrumb"> typically contains an <ol> or
    // a flat list of <a> / <span> items. We accept either.
    const direct = nav.querySelectorAll(':scope > ol > li, :scope > ul > li, :scope > a, :scope > span');
    return Array.from(direct);
  };
  const breadcrumbContainers = Array.from(document.querySelectorAll('nav[aria-label]')).filter((n) => {
    const lbl = (n.getAttribute('aria-label') || '').toLowerCase();
    return lbl.includes('breadcrumb') || lbl.includes('crumb');
  });
  for (let bi = 0; bi < breadcrumbContainers.length; bi++) {
    const nav = breadcrumbContainers[bi];
    // PR-8c T1: use the canonical axId (axIdFor) for the container
    // and for each member. If the container has no element id, its
    // canonical id is the pre-order index.
    const navAxId = axIdFor(nav);
    const items = collectBreadcrumbItems(nav);
    const memberAxIds = items.map((it) => axIdFor(it));
    out.push({
      fromAxId: navAxId,
      toAxId: null,
      kind: 'nav-element',
      navKind: 'breadcrumb',
      memberAxIds,
      activeMemberAxId: null,
      name: nav.getAttribute('aria-label') || null,
    });
    // Also emit a breadcrumb edge from the container to each item, in
    // order, so graph.path can return the breadcrumb trail with
    // stable ordering.
    for (let i = 0; i < items.length; i++) {
      out.push({
        fromAxId: navAxId,
        toAxId: memberAxIds[i],
        kind: 'breadcrumb',
        order: i,
      });
    }
  }

  // --- PR-8a: menu / menubar / tablist / nav-link-set NavElements ---
  // The APG vocab already detected these via apgRoleFor; here we
  // produce the *NavElement* (structure) record so the graph can
  // answer "what is the user menu?" structurally, not just by
  // looking at APG-tagged ax-nodes.
  const menuContainers = Array.from(document.querySelectorAll(
    'menu, [role="menu"], [role="menubar"], [role="tablist"]'
  ));
  for (let mi = 0; mi < menuContainers.length; mi++) {
    const c = menuContainers[mi];
    const role = c.getAttribute('role') || c.tagName.toLowerCase();
    let navKind;
    if (role === 'menubar') navKind = 'menubar';
    else if (role === 'tablist') navKind = 'tablist';
    else navKind = 'menu';
    const containerAxId = c.id
      ? 'ax:' + pageNodeId + ':' + c.id
      : 'ax:' + pageNodeId + ':' + navKind + '-container-' + mi;
    // Immediate children that participate in the structure. For
    // tablist: <[role=tab]>. For menu/menubar: <[role=menuitem]> or
    // direct <li> children of <menu>.
    const memberSelector = navKind === 'tablist'
      ? '[role="tab"], tab'
      : '[role="menuitem"], menuitem, :scope > li';
    const members = Array.from(c.querySelectorAll(memberSelector));
    const memberAxIds = members.map((m, idx) => {
      if (m.id) return 'ax:' + pageNodeId + ':' + m.id;
      return 'ax:' + pageNodeId + ':' + navKind + '-member-' + mi + '-' + idx;
    });
    let activeMemberAxId = null;
    if (navKind === 'tablist') {
      const active = members.find((m) => m.getAttribute('aria-selected') === 'true');
      if (active) {
        activeMemberAxId = active.id
          ? 'ax:' + pageNodeId + ':' + active.id
          : memberAxIds[members.indexOf(active)] || null;
      } else if (memberAxIds.length > 0) {
        // Default: first member is "active" when no aria-selected is set.
        activeMemberAxId = memberAxIds[0];
      }
    }
    out.push({
      fromAxId: containerAxId,
      toAxId: null,
      kind: 'nav-element',
      navKind,
      memberAxIds,
      activeMemberAxId,
      name: c.getAttribute('aria-label') || null,
    });
    // Emit menu-of / tab-of edges from the container to the
    // NavElement id, and tab-of edges per member tab → containing
    // tablist NavElement id.
    const navElementId = 'nav:' + pageNodeId + ':' + navKind + ':' + mi;
    out.push({
      fromAxId: containerAxId,
      toAxId: navElementId,
      kind: navKind === 'tablist' ? 'tab-of' : 'menu-of',
    });
    if (navKind === 'tablist') {
      for (const mAxId of memberAxIds) {
        out.push({
          fromAxId: mAxId,
          toAxId: navElementId,
          kind: 'tab-of',
        });
      }
    }
  }

  // --- PR-8a: <nav> link-set NavElements ---
  // A <nav> that is not a breadcrumb is a nav-link-set. The set's
  // members are the <a> children.
  const navSetContainers = Array.from(document.querySelectorAll('nav')).filter((n) => {
    const lbl = (n.getAttribute('aria-label') || '').toLowerCase();
    return !(lbl.includes('breadcrumb') || lbl.includes('crumb'));
  });
  for (let ni = 0; ni < navSetContainers.length; ni++) {
    const nav = navSetContainers[ni];
    const containerAxId = nav.id
      ? 'ax:' + pageNodeId + ':' + nav.id
      : 'ax:' + pageNodeId + ':navset-' + ni;
    const links = Array.from(nav.querySelectorAll('a[href]'));
    const memberAxIds = links.map((a, idx) => {
      if (a.id) return 'ax:' + pageNodeId + ':' + a.id;
      return 'ax:' + pageNodeId + ':navset-link-' + ni + '-' + idx;
    });
    if (memberAxIds.length === 0) continue; // skip empty nav wrappers
    out.push({
      fromAxId: containerAxId,
      toAxId: null,
      kind: 'nav-element',
      navKind: 'nav-link-set',
      memberAxIds,
      activeMemberAxId: null,
      name: nav.getAttribute('aria-label') || null,
    });
  }

  // --- PR-8a: state:cause placeholder edges ---
  // For every declared state transition source (commandfor,
  // popovertarget, dialog-open, apg-tab-activate), emit a
  // state:cause edge from the source axId to the placeholder state
  // id. PR-8 T6 resolves the placeholder to a real State node id.
  //
  // PR-8d (item 7): the placeholder format is now
  //   "state:TBD:<kind>:<sourceAxId>"
  // (kind FIRST, sourceAxId LAST), with the structural 'cause'
  // metadata attached to the edge. The resolver reads the
  // metadata first and only falls back to the placeholder-string
  // parse for backward compat with persisted graphs from PR-8a.
  // The previous "state:TBD:<fromAxId>:<kind>" format was
  // ambiguous because axIds contain ":" characters.
  for (const r of out) {
    if (r.transitionKind !== 'declared' || !r.toAxId) continue;
    const isCause = r.kind === 'commandfor' || r.kind === 'popovertarget' ||
      r.kind === 'dialog-open' || r.kind === 'apg-tab-activate';
    if (!isCause) continue;
    out.push({
      fromAxId: r.fromAxId,
      toAxId: 'state:TBD:' + r.kind + ':' + r.fromAxId,
      kind: 'state:cause',
      causeKind: r.kind,
      commandValue: r.commandValue || null,
    });
  }

  return out;
}`;

// ----- Public API -----

/** Record shape returned by the page-side script. */
export interface DeclaredRecord {
  fromAxId: string;
  toAxId: string | null;
  kind: string;
  transitionKind?: "declared" | "observed";
  trigger?: TransitionTrigger;
  apgRole?: string;
  apgPattern?: ApgPattern;
  // PR-8a: NavElement materialization (breadcrumb / menu / menubar /
  // tablist / nav-link-set).
  navKind?: NavElementKind;
  memberAxIds?: string[];
  activeMemberAxId?: string | null;
  name?: string | null;
  /** PR-8a: breadcrumb-edge order within the container. */
  order?: number;
  /**
   * PR-8c T8: the actual `command` value for `commandfor` records.
   * Preserved on the record so the materialized `Transition` and
   * `state:successor` edge can be inspected for the original
   * command (e.g. `show-modal`, `show-popover`, `--play-video`).
   * The `trigger` field is the canonical TransitionTrigger; this
   * field is the raw command string.
   */
  commandValue?: string;
  /**
   * PR-8d (item 1): the href value for `link` records. Preserved
   * because the link edge's `to` is a sentinel of the form
   * `link:<pageId>:<href>`, not an AxNode id. The href is
   * duplicated here so consumers don't have to parse it back
   * out of the to string.
   */
  hrefValue?: string;
  /**
   * PR-8d (item 7): for `state:cause` records, the declared
   * transition kind that produced this edge. The `kind` field
   * on a cause record is "state:cause" (the edge kind); this
   * field records the *underlying* transition kind
   * ("commandfor" | "popovertarget" | "dialog-open" |
   * "apg-tab-activate" | "link" | "nav-link") for unambiguous
   * resolution without parsing the placeholder string.
   */
  causeKind?: "commandfor" | "popovertarget" | "dialog-open" | "apg-tab-activate" | "link" | "nav-link" | "choose-dropdown";
  /**
   * PR-8g T2: for `state:cause` records produced by
   * `choose-dropdown`, the value of the selected <option> (for
   * native <select>) or the id of the active <li role="option">
   * (for ARIA combobox/listbox). Preserved so the materialized
   * `Transition` and `state:successor` edge can be inspected
   * for the original chosen value. The trigger field is
   * 'choose-dropdown'; this field is the raw value.
   */
  optionValue?: string | null;
}

export interface DeclaredResult {
  edges: Edge[];
  transitions: Transition[];
  navElements: NavElement[];
  /**
   * PR-8b (item 2): the declared materialization plan. The
   * extractor's `run()` method iterates this list, derives a
   * before/after `MaterializeSnapshot` for each entry, and calls
   * `materializeSuccessor()` to upsert real `StateNode`s + write
   * `state:successor` edges. Each entry is a `(sourceAxId,
   * targetAxId, kind, trigger)` tuple; the post-process hook in
   * `run()` is what actually populates the State graph.
   */
  declaredTransitions: Array<{
    sourceAxId: string;
    targetAxId: string;
    kind: "commandfor" | "popovertarget" | "dialog-open" | "apg-tab-activate" | "choose-dropdown";
    trigger: TransitionTrigger;
    /**
     * PR-8d (item 8): the actual `command` value (e.g. `show-modal`,
     * `close`, `hide-popover`, `request-close`, `show-popover`,
     * `toggle-popover`). The `kind` field is the edge kind
     * (`commandfor` / `popovertarget` / etc.); this field is the
     * underlying command semantics that drive the after-state
     * structure. `deriveAfterSnapshot` switches on this value, not
     * on `kind`, so a `command=hide-popover` never produces an
     * after-state with the popover open.
     */
    commandValue: string | null;
    /**
     * PR-8g T2: the chosen option's value (for native <select>)
     * or the active option's id (for ARIA combobox/listbox). The
     * declared materialization writes this onto the source
     * element's ariaStates so the before/after snapshots differ
     * in a way the state-id projection can detect — without
     * the change, declared+observed convergence would always
     * fail for choose-dropdown because the source and target
     * are both observed as "select with selected option X" in
     * the baseline.
     */
    optionValue: string | null;
  }>;
}

/**
 * Pure transform: convert a list of records from the page into edges +
 * transitions + the materialization plan for declared state
 * transitions. Exported so tests can drive it without a BiDi session.
 */
export function buildDeclared(
  pageNodeId: string,
  records: DeclaredRecord[],
): DeclaredResult {
  const edges: Edge[] = [];
  const transitions: Transition[] = [];
  const navElements: NavElement[] = [];
  const declaredTransitions: DeclaredResult["declaredTransitions"] = [];
  const transCounters = new Map<string, number>();
  // PR-8a: NavElement ids are stable per page+kind+order-of-emission.
  // We track the per-kind counter so re-runs of buildDeclared produce
  // identical ids (idempotency).
  const navCounters = new Map<string, number>();

  const nextTransId = (kind: string, fromAxId: string): string => {
    const k = `${kind}|${fromAxId}`;
    const n = (transCounters.get(k) ?? 0) + 1;
    transCounters.set(k, n);
    return `trans:${kind}-${fromAxId}-${n}`;
  };

  const nextNavId = (kind: string): string => {
    const n = (navCounters.get(kind) ?? 0) + 1;
    navCounters.set(kind, n);
    return `nav:${pageNodeId}:${kind}:${n}`;
  };

  for (const r of records) {
    // ---- PR-8a: NavElement materialization ----
    // A "nav-element" record creates a NavElement node. Its id is
    // derived deterministically from pageNodeId + kind + emission
    // order so re-runs produce identical ids.
    if (r.kind === "nav-element" && r.navKind && r.memberAxIds) {
      const id = nextNavId(r.navKind);
      const domOrderHint = navCounters.get(r.navKind) ?? 0;
      navElements.push({
        id,
        type: "nav-element",
        pageId: pageNodeId,
        kind: r.navKind,
        inPageDomOrder: domOrderHint,
        containerAxId: r.fromAxId,
        memberAxIds: r.memberAxIds,
        activeMemberAxId: r.activeMemberAxId ?? null,
        name: r.name ?? null,
        provenance: "html:parse",
      });
      // menu-of / tab-of edges from container → NavElement id are
      // emitted by the page-side walker as separate records; we
      // handle them in the "edges" branch below.
    }

    // ---- Edges ----
    if (r.kind === "link" || r.kind === "commandfor" || r.kind === "popovertarget" || r.kind === "dialog-open") {
      if (!r.toAxId) continue;
      const edgeKind = r.kind as EdgeKind;
      // PR-8d (item 1): link edges carry the href in a structured
      // `hrefValue` field; the `to` is a `link:<pageId>:<href>`
      // sentinel, not an AxNode id. commandfor edges carry the
      // `cause` metadata so the resolver doesn't have to parse
      // the placeholder string.
      const edge: Edge = {
        id: `edge:${r.fromAxId}->${r.toAxId}:${edgeKind}`,
        type: "edge",
        from: r.fromAxId,
        to: r.toAxId,
        kind: edgeKind,
        provenance: "html:parse",
        ...(r.kind === "link" ? { hrefValue: r.hrefValue } : {}),
        ...(r.kind === "commandfor" ? {
          cause: {
            sourceAxId: r.fromAxId,
            declaredKind: "commandfor",
            commandValue: r.commandValue,
          },
        } : {}),
      };
      edges.push(edge);
    }

    // PR-8a: breadcrumb edges from a NavElement id to each member.
    if (r.kind === "breadcrumb" && r.toAxId) {
      edges.push({
        id: `edge:${r.fromAxId}->${r.toAxId}:breadcrumb`,
        type: "edge",
        from: r.fromAxId,
        to: r.toAxId,
        kind: "breadcrumb",
        provenance: "html:parse",
      });
    }

    // PR-8a: menu-of / tab-of edges from container axId to NavElement id.
    if ((r.kind === "menu-of" || r.kind === "tab-of") && r.toAxId) {
      edges.push({
        id: `edge:${r.fromAxId}->${r.toAxId}:${r.kind}`,
        type: "edge",
        from: r.fromAxId,
        to: r.toAxId,
        kind: r.kind as EdgeKind,
        provenance: "html:parse",
      });
    }

    // PR-8a: state:cause cross-layer edges (Layer 1 → Layer 4
    // placeholder state ids; PR-8 T6 resolves the placeholder to
    // a real State node id).
    //
    // PR-8d (item 7): the structural `cause` metadata is attached
    // here so the resolver can use the kind + commandValue
    // directly without parsing the placeholder string. The
    // placeholder format is now `state:TBD:<kind>:<sourceAxId>`
    // (kind first, sourceAxId last), unambiguous because
    // `kind` is one of a closed enum (never contains a colon).
    if (r.kind === "state:cause" && r.toAxId) {
      const declaredKind = r.causeKind ?? "commandfor";
      edges.push({
        id: `edge:${r.fromAxId}->${r.toAxId}:state:cause`,
        type: "edge",
        from: r.fromAxId,
        to: r.toAxId,
        kind: "state:cause",
        provenance: "html:parse",
        cause: {
          sourceAxId: r.fromAxId,
          declaredKind,
          commandValue: r.commandValue ?? undefined,
          // PR-8g T2: the option value is preserved on the
          // state:cause edge for choose-dropdown transitions
          // so the resolver can find the matching State.
          // The `optionValue` field is set ONLY for
          // choose-dropdown records; for other declaredKinds
          // it is undefined.
          optionValue: r.optionValue ?? undefined,
        },
      });
    }

    // ---- Transitions ----
    if (r.transitionKind === "declared" && r.toAxId) {
      // Pick the "trans kind" prefix used in the transition id. By convention
      // we use the edge kind for commandfor/popovertarget/dialog-open so the
      // ids match the test expectations and the existing orchestrator stub.
      const prefix = r.kind; // e.g. "commandfor", "popovertarget", "dialog-open", "apg-tab-activate"
      const trigger: TransitionTrigger = r.trigger ?? "click";
      const t: Transition = {
        id: nextTransId(prefix, r.fromAxId),
        type: "transition",
        kind: "declared",
        trigger,
        fromAxId: r.fromAxId,
        toAxIds: [r.toAxId],
        beforeSnapshot: "snapshot:0",
        afterSnapshot: "snapshot:0",
        apgPattern: (r.apgPattern as ApgPattern) ?? null,
        preconditions: [],
        provenance: "html:parse",
      };
      transitions.push(t);
      // PR-8b (item 2): record the declared transition in the
      // materialization plan. The extractor's `run()` method will
      // derive before/after `MaterializeSnapshot`s from the page
      // state and the transition's target, then call
      // `materializeSuccessor()`. This is what makes
      // `declared+observed` convergence reachable.
      const k = r.kind as DeclaredResult["declaredTransitions"][number]["kind"];
      if (
        k === "commandfor" || k === "popovertarget" ||
        k === "dialog-open" || k === "apg-tab-activate" ||
        // PR-8g T2: choose-dropdown is a real production transition
        // (per blocker 2 of the PR-8g binding instruction). The
        // declared materialization's `deriveAfterSnapshot` for
        // choose-dropdown mutates the source element's
        // ariaStates (aria-activedescendant / aria-valuetext)
        // and unselects the previous target option so the
        // before/after snapshots actually differ.
        k === "choose-dropdown"
      ) {
        declaredTransitions.push({
          sourceAxId: r.fromAxId,
          targetAxId: r.toAxId,
          kind: k,
          trigger,
          commandValue: r.commandValue ?? null,
          // PR-8g T2: pass the option value through to the
          // materializer so `deriveAfterSnapshot` can record it
          // on the source element's ariaStates.
          optionValue: r.optionValue ?? null,
        });
      }
    }

    // APG pattern records that don't produce edges still annotate AxNode.apgPattern,
    // but that resolution lives in the AX extractor (out of scope here). The
    // declared extractor only emits the edges and transitions implied by the
    // pattern vocabulary.
  }

  return { edges, transitions, navElements, declaredTransitions };
}

/**
 * Pluggable extractor. Calls `page.script.callFunction` with the page-side
 * walker, then funnels the records through `buildDeclared`.
 *
 * **PR-8b (item 2).** After the structural extractor has populated the
 * graph with AxNodes, this extractor materializes real `StateNode`s
 * + `state:successor` edges for every declared transition. The
 * baseline snapshot is built from the graph's AxNodes; the
 * after-snapshot is structured per transition kind
 * (`commandfor`/`popovertarget` → target axId added to
 * `openPopoverIds`; `dialog-open` → added to `openDialogIds`;
 * `apg-tab-activate` → target axId `selected=true`).
 */
export const extractStateDeclared: Extractor = {
  name: "state-declared",
  async run({ graph, page, pageNode, log, auth, network }) {
    const t0 = Date.now();
    const records = await page.script.callFunction<DeclaredRecord[]>(
      page.target,
      PAGE_SCRIPT,
      [pageNode.id],
    );
    const { edges, transitions, navElements, declaredTransitions } = buildDeclared(pageNode.id, records);
    for (const e of edges) graph.upsertEdge(e);
    for (const t of transitions) graph.upsertTransition(t);
    for (const n of navElements) graph.upsertNavElement(n);

    // PR-8b (item 2): materialize real StateNodes + state:successor
    // edges for each declared transition. The auth/network contexts
    // come from the orchestrator; the baseline snapshot is built
    // from the graph's AxNodes.
    let materialized = 0;
    let successors = 0;
    if (declaredTransitions.length > 0) {
      const authCtx = auth ?? { kind: "anonymous" } as AuthContext;
      const netCtx = network ?? { status: "online" as const, evidence: "static" as const };
      // PR-8f: read the actual browser viewport (via BiDi) so the
      // declared baseline's viewport matches the observed baseline's
      // viewport. The viewport is part of the semantic projection
      // (per state-id.ts), so a mismatch (declared 1280x800x1 vs
      // observed 1280x595x1.5) produces different state ids even
      // when every per-element observation is identical — defeating
      // declared+observed convergence.
      let baselineViewport: { w: number; h: number; dpr: number; scrollX: number; scrollY: number } = {
        w: pageNode.viewport.w,
        h: pageNode.viewport.h,
        dpr: pageNode.viewport.dpr,
        scrollX: 0,
        scrollY: 0,
      };
      try {
        const v = await page.script.evaluate<{ w: number; h: number; dpr: number; scrollX: number; scrollY: number } | null>(
          { context: page.target.context },
          "(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1, scrollX: window.scrollX, scrollY: window.scrollY }))()",
        );
        if (v && typeof v.w === "number" && typeof v.h === "number" && typeof v.dpr === "number") {
          baselineViewport = v;
        }
      } catch (e) {
        // best-effort: fall back to the PageNode's recorded viewport
        log(`  [state-declared] [viewport-read-failed] ${(e as Error).message}; using PageNode viewport`);
      }
      // PR-8g T1: read the actual `document.activeElement` from the
      // page so the declared baseline's `focusedAxId` matches the
      // observed baseline's. Without this, the two paths produce
      // different state ids (declared `focusedAxId: null` vs
      // observed `focusedAxId: ax:page:...:n7`) even when the
      // element-level state is identical — defeating the
      // declared+observed convergence. The axId resolution uses
      // the same `axIdFor(el)` convention as the rich snapshot
      // walker in observed.ts: prefer `el.id` (pageId-prefixed),
      // fall back to the DOM-tree index when the element has no
      // id. The body is excluded (activeElement is the body on
      // first load, when nothing is focused).
      let baselineFocusedAxId: string | null = null;
      try {
        const focused = await page.script.callFunction<{ axId: string | null }>(
          page.target,
          "(pageId) => { const a = document.activeElement; if (!a || a.nodeType !== 1) return { axId: null }; if (a === document.body) return { axId: null }; const root = document.documentElement; const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null); const idxOf = new Map(); idxOf.set(root, 0); let node; let i = 1; while ((node = walker.nextNode())) { idxOf.set(node, i); i++; } function axIdFor(el) { if (el.id) return 'ax:' + pageId + ':' + el.id; const idx = idxOf.get(el); if (idx === undefined) { const parent = el.parentElement; let sibIdx = 0; if (parent) for (let s = el.previousElementSibling; s; s = s.previousElementSibling) sibIdx++; return 'ax:' + pageId + ':dyn:' + (el.tagName || '') + ':' + sibIdx; } return 'ax:' + pageId + ':n' + idx; } return { axId: axIdFor(a) }; }",
          [pageNode.id],
        );
        if (focused && typeof focused.axId === "string") {
          baselineFocusedAxId = focused.axId;
        }
      } catch (e) {
        // best-effort: fall back to null
        log(`  [state-declared] [focus-read-failed] ${(e as Error).message}; focusedAxId=null`);
      }
      const before = buildBaselineSnapshot(graph, pageNode.id, baselineViewport, baselineFocusedAxId);
      for (const dt of declaredTransitions) {
        const after = deriveAfterSnapshot(before, dt);
        const result = materializeSuccessor({
          graph,
          pageId: pageNode.id,
          route: pageNode.url,
          auth: authCtx,
          network: netCtx,
          before,
          after,
          sourceAxId: dt.sourceAxId,
          trigger: dt.trigger,
          evidenceKind: "declared",
          provenance: "html:parse",
        });
        materialized++;
        if (result.edgeId !== null) successors++;
      }
    }

    // PR-8b (item 4): resolve state:cause placeholders. Edges that
    // have no matching State are removed (not re-pointed at a
    // random state) and the unresolved callback logs a warning.
    const cause = resolveStateCauseEdges(graph, ({ sourceAxId, pageId: p, placeholderStateId }) => {
      log(`  [state-declared] [state-cause-unresolved] sourceAxId=${sourceAxId} pageId=${p} placeholder=${placeholderStateId}`);
    });

    log(`  [state-declared] edges=${edges.length} transitions=${transitions.length} navElements=${navElements.length} states=${materialized} successors=${successors} state-cause-resolved=${cause.resolved} state-cause-removed=${cause.removed}`);
    return { produced: edges.length + transitions.length + navElements.length + materialized > 0, durationMs: Date.now() - t0 };
  },
};

// ----- PR-8b (item 2): snapshot builders for declared materialization -----

/**
 * Build a `MaterializeSnapshot` from the graph's AxNodes for the
 * given page. This is the *baseline* (page in its pre-transition
 * state). For each AxNode we synthesize a `ElementStateObservation`
 * from the AxNode's role + aria-* attributes. The element rects are
 * not yet captured (the visual layer adds them in the observed
 * path); for the declared path we use a placeholder rect {0,0,0,0}
 * since the declared materialization's goal is to record the
 * *semantic* state, not the visual delta.
 */
function buildBaselineSnapshot(
  graph: { getAx(id: string): AxNode | undefined },
  pageId: string,
  viewport: { w: number; h: number; dpr: number; scrollX: number; scrollY: number },
  focusedAxId: string | null = null,
): MaterializeSnapshot {
  const elements: Record<string, ElementStateObservation> = {};
  for (const ax of graphAllAx(graph, pageId)) {
    elements[ax.id] = axNodeToObservation(ax, focusedAxId);
  }
  return {
    elements,
    // PR-8g T1: the declared baseline now reads the actual
    // `document.activeElement` from the page (PR-8f) so its
    // `focusedAxId` agrees with the observed baseline. The
    // `focused` flag on the matching element is also set. The
    // `deriveAfterSnapshot` for non-focus transitions preserves
    // the focus; focus-only transitions (none in the declared
    // path today) would set it explicitly. Any focus change
    // captured by the observed path is observed-only.
    focusedAxId,
    openDialogIds: [],
    openPopoverIds: [],
    expandedRegionAxIds: [],
    viewport,
    conditionalMarkers: {},
  };
}

/** Iterate all AxNodes that belong to the given page. */
function* graphAllAx(graph: { getAx(id: string): AxNode | undefined }, pageId: string): IterableIterator<AxNode> {
  // The graph class doesn't expose a `axByPage` accessor in v1. Walk
  // every ax-node via the structural extractor's page reference. In
  // practice the Graph has `_axNodes` but the public surface is
  // `axNodes()`. We filter by `ax.pageId === pageId`.
  for (const ax of graphAxNodes(graph)) {
    if (ax.pageId === pageId) yield ax;
  }
}

/** Iterate every AxNode in the graph. Type-asserted to the public
 *  `axNodes()` accessor that all Graph instances expose. */
function* graphAxNodes(graph: { getAx(id: string): AxNode | undefined }): IterableIterator<AxNode> {
  const g = graph as unknown as { axNodes(): IterableIterator<AxNode> };
  yield* g.axNodes();
}

/** Convert an AxNode to a baseline `ElementStateObservation`. The
 *  observation's rect is a placeholder; the observed path replaces
 *  this with the real rect from the visual layer. The states
 *  (`expanded`, `pressed`, etc.) are read from the AxNode's
 *  `states` field. The `visualNodeId` is left null in the declared
 *  path; the observed path sets it when a VisualNode with the same
 *  axId exists. */
function axNodeToObservation(ax: AxNode, focusedAxId: string | null = null): ElementStateObservation {
  return {
    axId: ax.id,
    rect: { x: 0, y: 0, w: 0, h: 0 },
    // PR-8e: use the real visibility captured by the structural
    // walker so the declared and observed paths produce identical
    // visibility values for the same axId. Previously this was
    // hard-coded to "visible", which broke state-id convergence
    // for any element that is hidden in the baseline (e.g. a
    // <dialog hidden> or a panel with `display: none`).
    visibility: ax.visibility,
    zIndex: null,
    // PR-8f: use the structural walker's `open` state for dialogs
    // and popovers. Previously this was hard-coded to `null`, so a
    // closed `<div popover id="user-menu">` had `open: null` here
    // but `open: false` in the rich snapshot, breaking state-id
    // convergence.
    open: ax.states.open,
    expanded: ax.states.expanded,
    selected: ax.states.selected,
    checked: ax.states.checked,
    pressed: ax.states.pressed,
    busy: ax.states.busy,
    // PR-8g T1: per-element focus flag. Set to true if this
    // axId is the declared baseline's `focusedAxId` (the
    // `document.activeElement` at crawl time). For all other
    // elements the flag is false. The observed path sets the
    // same flag from `activeEl === el` at probe time. The two
    // paths produce identical state ids when the page's focus
    // is unchanged.
    focused: focusedAxId !== null && ax.id === focusedAxId,
    ariaStates: {},
    visualNodeId: null,
  };
}

/**
 * Derive the after-snapshot for a declared transition. The
 * after-snapshot is a *structured* modification of the baseline,
 * not a guess.
 *
 * **PR-8d (item 8):** the function switches on the actual
 * `command` value (e.g. `show-modal`, `close`, `hide-popover`,
 * `request-close`, `show-popover`, `toggle-popover`), NOT on the
 * edge kind alone. A `command=hide-popover` edge has the same
 * edge kind (`commandfor`) as a `command=show-popover` edge,
 * but they produce OPPOSITE after-states:
 *
 *   - `show-modal`         -> target added to `openDialogIds`
 *   - `close`              -> target REMOVED from `openDialogIds`
 *   - `show-popover`       -> target added to `openPopoverIds`
 *   - `hide-popover`       -> target REMOVED from `openPopoverIds`
 *   - `request-close`      -> target REMOVED from `openDialogIds`
 *   - `toggle-popover`     -> target toggled in `openPopoverIds`
 *   - anything else        -> target added to `openPopoverIds`
 *     (back-compat default; this is what pre-PR-8d code did
 *     and what existing tests expect for the no-command-value
 *     case)
 *
 * For `dialog-open` and `apg-tab-activate` edges the command
 * value is irrelevant (`dialog-open` edges only ever open
 * dialogs; `apg-tab-activate` only ever activates a tab), so
 * the switch falls through to the kind-based branch.
 */
function deriveAfterSnapshot(
  before: MaterializeSnapshot,
  dt: {
    sourceAxId: string;
    targetAxId: string;
    kind: "commandfor" | "popovertarget" | "dialog-open" | "apg-tab-activate" | "choose-dropdown";
    commandValue?: string | null;
    /**
     * PR-8g T2: the chosen option's value (for native <select>)
     * or the active option's id (for ARIA combobox/listbox).
     * The declared materialization records this on the target
     * element's `ariaStates['aria-activedescendant']` (for
     * combobox) or on the source select's `ariaStates['aria-valuetext']`
     * (for native select) so the before/after snapshots differ
     * in a way the state-id projection can detect.
     */
    optionValue?: string | null;
  },
): MaterializeSnapshot {
  // Deep-clone the before-snapshot so the materializer sees a clean
  // structured diff. The element observations are cloned
  // independently; the structural fields are cloned shallow.
  const elements: Record<string, ElementStateObservation> = {};
  for (const [k, v] of Object.entries(before.elements)) {
    elements[k] = { ...v, ariaStates: { ...v.ariaStates } };
  }
  const openDialogIds = [...before.openDialogIds];
  const openPopoverIds = [...before.openPopoverIds];
  const expandedRegionAxIds = [...before.expandedRegionAxIds];
  const cmd = dt.commandValue ?? null;

  if (dt.kind === "commandfor") {
    // The actual command semantics determine the after-state.
    if (cmd === "show-modal") {
      if (!openDialogIds.includes(dt.targetAxId)) openDialogIds.push(dt.targetAxId);
      // Ensure the target is NOT recorded as an open popover
      // (a dialog and a popover are mutually exclusive).
      const idx = openPopoverIds.indexOf(dt.targetAxId);
      if (idx >= 0) openPopoverIds.splice(idx, 1);
    } else if (cmd === "close") {
      const idx = openDialogIds.indexOf(dt.targetAxId);
      if (idx >= 0) openDialogIds.splice(idx, 1);
      const pidx = openPopoverIds.indexOf(dt.targetAxId);
      if (pidx >= 0) openPopoverIds.splice(pidx, 1);
    } else if (cmd === "request-close") {
      const idx = openDialogIds.indexOf(dt.targetAxId);
      if (idx >= 0) openDialogIds.splice(idx, 1);
    } else if (cmd === "show-popover") {
      if (!openPopoverIds.includes(dt.targetAxId)) openPopoverIds.push(dt.targetAxId);
    } else if (cmd === "hide-popover") {
      // PR-8d (item 8): hide-popover must NEVER produce an
      // after-state in which the popover is opened. Remove
      // the target from openPopoverIds; do not add it.
      const idx = openPopoverIds.indexOf(dt.targetAxId);
      if (idx >= 0) openPopoverIds.splice(idx, 1);
    } else if (cmd === "toggle-popover") {
      const idx = openPopoverIds.indexOf(dt.targetAxId);
      if (idx >= 0) {
        openPopoverIds.splice(idx, 1);
      } else {
        openPopoverIds.push(dt.targetAxId);
      }
    } else {
      // No command value (back-compat default) or an unknown
      // command value. Fall back to the pre-PR-8d default of
      // opening the popover.
      if (!openPopoverIds.includes(dt.targetAxId)) openPopoverIds.push(dt.targetAxId);
    }
  } else if (dt.kind === "popovertarget") {
    // `popovertarget` is a click-driven show/hide toggle. Honor
    // the command value when present; default to show.
    if (cmd === "hide-popover" || cmd === "close") {
      const idx = openPopoverIds.indexOf(dt.targetAxId);
      if (idx >= 0) openPopoverIds.splice(idx, 1);
    } else {
      if (!openPopoverIds.includes(dt.targetAxId)) openPopoverIds.push(dt.targetAxId);
    }
  } else if (dt.kind === "dialog-open") {
    if (!openDialogIds.includes(dt.targetAxId)) {
      openDialogIds.push(dt.targetAxId);
    }
  } else if (dt.kind === "apg-tab-activate") {
    // For tab activation: the target tab becomes selected; other
    // tabs in the same tablist (siblings) become unselected. We
    // don't know the tablist membership here (the structural
    // extractor owns that), so we only flip the target's own
    // selected state. The observed path resolves full tablist
    // membership from the visual layer.
    const target = elements[dt.targetAxId] ?? {
      axId: dt.targetAxId,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      visibility: "visible" as const,
      zIndex: null,
      open: null,
      expanded: null,
      selected: null,
      checked: null,
      pressed: null,
      busy: null,
      // PR-8g T1: tab activation is not a focus transition. The
      // declared materializer never produces a focus change. If
      // the user actually focuses a tab, the observed path will
      // record it; the declared path keeps `focused: false`.
      focused: false,
      ariaStates: {},
      visualNodeId: null,
    };
    elements[dt.targetAxId] = { ...target, selected: true };
  } else if (dt.kind === "choose-dropdown") {
    // PR-8g T2: the source axId (the <select> or combobox)
    // changes its observed "active option" state. For native
    // <select>, the source's aria-valuetext (or value text)
    // changes. For ARIA combobox/listbox, the source's
    // aria-activedescendant changes. Either way, we record the
    // change on the SOURCE element (not the target), because
    // the target is the option that was previously selected
    // (whose `selected` state was true) and the source is the
    // combobox whose active option now points elsewhere.
    const source = elements[dt.sourceAxId] ?? {
      axId: dt.sourceAxId,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      visibility: "visible" as const,
      zIndex: null,
      open: null,
      expanded: null,
      selected: null,
      checked: null,
      pressed: null,
      busy: null,
      focused: false,
      ariaStates: {},
      visualNodeId: null,
    };
    const ariaStates = { ...source.ariaStates };
    if (dt.optionValue) {
      // For combobox/listbox the optionValue is the target's id;
      // for native <select> it is the new <option>'s value.
      ariaStates['aria-activedescendant'] = dt.optionValue;
      ariaStates['aria-valuetext'] = dt.optionValue;
    }
    elements[dt.sourceAxId] = { ...source, ariaStates };
    // The previous target (the option that was active before
    // the change) is unselected; the new target (the option
    // that is now active) is selected. We don't know the new
    // target's id from the declared record (we only know the
    // source), so we set the new target's selected state via
    // dt.targetAxId only if dt.targetAxId is a real option
    // (not the listbox itself). For a native <select>, the
    // declared record's targetAxId is the previously-selected
    // option's id; we mark it unselected.
    const prevTarget = elements[dt.targetAxId];
    if (prevTarget) {
      elements[dt.targetAxId] = { ...prevTarget, selected: false };
    }
  }
  return {
    elements,
    // PR-8g T1: declared materializer never produces a focus
    // change. The State-level `focusedAxId` is null in both
    // before and after. Any focus state in the graph is observed-
    // only evidence; a focus change can never satisfy the
    // declared+observed convergence condition on its own.
    focusedAxId: null,
    openDialogIds,
    openPopoverIds,
    expandedRegionAxIds,
    viewport: { ...before.viewport },
    conditionalMarkers: { ...(before.conditionalMarkers ?? {}) },
  };
}
