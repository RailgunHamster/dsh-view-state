# API notes — the exact facts `dsh-view-state` is built on

Every claim below was read out of the harness **at the version this machine runs
(dsh `0.1.5-rc.2` packages, `dsh` CLI `0.1.5-rc.1`)**. Where a claim came from
shipped code, the file is cited; where it came from a type declaration, that is
said explicitly, because the two are not equally strong evidence.

Two install layouts exist on this machine and they are **not** interchangeable:

- `C:\Users\Administrator\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<pkg>`
  — the global install. This is what the running `dsh web` loads, so it is the
  authoritative copy for runtime behaviour.
- `C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\*` — junctions
  into the global install. Several of them are **dangling**: `dsh-client-ui-slots`
  and `dsh-client-store` have no counterpart under the global install at all, so
  a recursive search there finds nothing. The real sources for those two live in
  a checkout at `D:\git\deepseek-harness` (whose `node_modules/.pnpm/...` entries
  junction back into `packages/client/*`). Quotes from that checkout are marked.

---

## 1. Session selection

**Source:** `dsh-api-session-controller/lib/types/client/sessions/service.d.ts` (types)
and `dsh-api-session-controller/lib/client.js` (shipped code).

The service is `ctx.sessions`; it is published by the shipped client half:

> `rootCtx.reflect.provide("sessions", this, void 0);`
> — `dsh-api-session-controller/lib/client.js`

`list` is the read face, and `current` is the selection:

> `readonly list: SnapshotStore<SessionListState>;`
> — `service.d.ts`

> `export interface SessionListState { ids: SessionId[]; byId: Record<SessionId, SessionSummary>; current: SessionId | undefined; ... }`
> — `service.d.ts`

> `ctx.sessions.list.getSnapshot().current`
> — verified against shipped consumers, e.g. `dsh-client-ui-session/lib/client.js`:
> `const current = this.sessions.list.getSnapshot().current;`

`open()` is synchronous and fails loud:

> `open(id: SessionId): void;` — "Select a listed or retained catalog-addressed session as current."
> — `service.d.ts`; the implementation is `this.manager.select(id)` (`lib/client.js`).
> The host-side contract text is explicit that **unknown ids fail loud**.

**Consequences for this plugin**

- Selection is read from `list.getSnapshot().current`, never from the layout store
  (see §3).
- Because `current` arrives asynchronously, an id that is not yet in `byId` is not
  yet *known* to be unknown. The plugin therefore retries on an escalating
  schedule and only drops the parameter once the list is non-empty and provably
  lacks the id.
- Because `open()` throws on unknown ids, the plugin never probes it as a
  validity test; it checks `byId` first. The `try/catch` around `open()` exists
  for the residual race, where the list changes between the check and the call.
- `inject` is deliberately **empty**. `sessions` is a hard dependency in the
  shipped sense, but this plugin must still activate (and still mirror the URL)
  when a service is missing, so it resolves services with `ctx.get(name)` and
  degrades. Declaring them in `inject` would park the plugin in `waiting`
  instead.

---

## 2. Panel widths — the root-store question

**This was the open question, and the answer is: the store IS reachable.**

### 2.1 `ctx.layout` alone is not enough

**Source:** `dsh-client-ui-layout/lib/types/client/service.d.ts` (types).

> `export interface ILayout { selectPanel(panelId: MainPanelId | null): void; beginNavigation(): AbortSignal; toggleSidebar(): void; openRightbar(track: boolean, fullscreen: boolean): void; closeRightbar(): void; }`

No read, no arbitrary width setter. `setSidebar(px)` and `setRightbar(px)` are not
on this face, and neither is `layoutInfo` — so `ctx.layout` cannot satisfy the
width half of the contract on its own.

### 2.2 The real state, and the store seat

**Source:** `dsh-client-ui-layout/lib/types/client/stores.d.ts` (types) and
`dsh-client-ui-layout/lib/client.js` (shipped code).

> `type LayoutState = { panelInfo: { activePanelId: MainPanelId | null }; layoutInfo: LayoutInfo }`

> `type LayoutInfo = { sidebar: number; viewportWidth: number; narrowExpanded: boolean; rightbar: number | null; rightbarShown: boolean; rightbarTrack: boolean; rightbarFullscreen: boolean; rightbarInstant: boolean }`

with the actions `selectPanel, retainMainPanels, setSidebar, toggleSidebar,
setViewportWidth, setRightbar, openRightbar, closeRightbar`.

The shipped `apply()` is decisive — note the overridden `create`:

```js
const handle = createLayoutStore();
const instance = handle.create();
const store = { ...handle, create: () => instance };   // <-- pinned to one instance
const layout = new LayoutController(instance.actions, ...);
const disposeService = ctx.reflect.provide("layout", layout);
const disposeRegistration = ctx.slots.register({ name: "root", ..., store }, AppFrame);
```

— `dsh-client-ui-layout/lib/client.js`

So the object handed to `ctx.slots.register` is a **spread copy of the handle whose
`create()` always returns the one live instance**, not a fresh store.

### 2.3 Reaching it from a third-party plugin

**Source:** `@deepseek-ai/dsh-client-ui-renderer/lib/types/client/registry.d.ts`
(types) and `lib/client.js` (shipped code) — this is the `ctx.slots` service the
web shell actually installs; `dsh-client-ui-slots` is only its pure core.

The public read surface:

> `entries(key: keyof SlotMap & string): readonly StoredEntry[];` — "Snapshot entries for a key (render-erased view; stable reference between mutations)."
> — `registry.d.ts`

The shipped implementation returns the core's **live** objects, not copies:

```js
entries(key) { return this._core.entries(key); }
```

and each stored entry carries the very object that was passed as `options.store`:

> `export interface StoredEntry { component: unknown; options: {...}; children?: ...; store?: StoreDecl | undefined; ... }`

**Therefore:**

```js
const entry = ctx.slots.entries("root").find(e => e.store !== undefined);
const instance = entry.store.create();   // the live LayoutState store
instance.getSnapshot().layoutInfo;       // read: sidebar / rightbar / viewportWidth / ...
instance.actions.setSidebar(px);         // write: arbitrary px
instance.actions.setRightbar(px);
```

This works **only because ui-layout pinned `create()`**. The plugin verifies that
property rather than assuming it: it calls `create()` twice and requires the two
results to be identical objects. A plain `defineStore` handle returns a fresh
instance per call (`dsh-client-runtime/src/client/contract/store.ts`: "create()
deliberately does not dedupe or throw"), so an unpinned handle fails the probe and
the plugin declines to mutate a store nobody is rendering — which is why the test
suite has an explicit "un-pinned store" case.

There is a second, weaker route to the actions: `ctx.layout` itself is built from
`instance.actions`, so its own methods write to the same store. But it only
exposes `toggleSidebar` (0 ⟷ contract default) and `openRightbar`/`closeRightbar`,
so it cannot set an arbitrary px and cannot be read at all. The plugin uses it for
nothing.

### 2.4 What this makes restorable

| Fact | Where it lives | Read | Write | Exact? |
|---|---|---|---|---|
| selected session | `ctx.sessions.list.current` | yes | `ctx.sessions.open(id)` | yes, or fail-soft drop |
| sidebar px (expanded) | `layoutInfo.sidebar` | yes | `actions.setSidebar(px)` | yes, clamped by the store to `[264, 420]` |
| sidebar collapsed | `layoutInfo.sidebar === 0` | yes | `actions.toggleSidebar()` | yes when the pre-state is known; see §4 |
| rightbar saved px | `layoutInfo.rightbar` | yes | `actions.setRightbar(px)` | yes, clamped by the store to `[300, 0.7 × viewport]` |

Clamp constants, from `dsh-client-ui-layout/lib/types/client/columns.d.ts` and
mirrored in the shipped `actions`:

> `SIDEBAR_MIN = 264; SIDEBAR_MAX = 420; SIDEBAR_DEFAULT = 280; SIDEBAR_COLLAPSED = 56; SIDEBAR_AUTO_COLLAPSE = 1024; RIGHTBAR_MIN = 300; RIGHTBAR_MAX_RATIO = 0.7; RIGHTBAR_DEFAULT_RATIO = 0.45;`

The **upper** bound for the right panel is viewport-relative, so it cannot be
applied by this plugin — it is left to the store, which re-clamps on every write.

### 2.5 What is NOT restorable, and why

**Whether the right panel is shown.** That is not part of `LayoutInfo` as a source
of truth. `layoutInfo.rightbarShown` / `rightbarTrack` / `rightbarFullscreen` are
explicitly *derived reports*:

> "Derived chrome, not a source of truth: whether the right surface is expanded is a recorded fact owned by that surface, reported here so the frame can place the panel's resize handle. The occupant reports it; nothing else writes it."
> — `stores.d.ts`

The owner is `@deepseek-ai/dsh-client-ui-sidebar-right`, whose per-**session** store
holds `surface.layout.expanded`:

```js
const shown = surface !== void 0 && surface.layout.expanded;
...
syncPresentation({ shown, track, fullscreen })  // -> layout.openRightbar(...) / layout.closeRightbar()
```

— `dsh-client-ui-sidebar-right/lib/client.js`

The seat pushes that report into the frame from a `useLayoutEffect` on every
presentation change. Driving `openRightbar` from outside would therefore race the
seat and could be reverted immediately, and the "expanded" bit would still be
false in the store that decides. Reaching in to force it would mean mutating
another plugin's **per-session** store, which is a much weaker and more fragile
reach than the pinned root store in §2.3. The plugin does not do it, and says so.

`layoutInfo.rightbar` is still captured and restored: it is the *saved width*, so a
panel the user opens later opens at the restored width.

**Also not captured** (out of scope of the frozen contract, noted for honesty):
which global main panel is selected (`panelInfo.activePanelId`), the sidebar's
`narrowExpanded` override for viewports under 1024px, and anything about the
right panel's tab/split layout.

---

## 3. The layout snapshot carries no session

`LayoutState` is exactly `{ panelInfo, layoutInfo }` (§2.2), so there is no
`sessionId` on it. An early draft of this plugin read one; it would always have
been `undefined`. Session selection is read from the sessions list only.

---

## 4. `toggleSidebar()` is the only way to reach 0

Shipped action bodies (`dsh-client-ui-layout/lib/client.js`):

```js
setSidebar: (d, px) => { d.layoutInfo.rightbarInstant = false; d.layoutInfo.sidebar = clampWidth(px, 264, 420); },
toggleSidebar: (d) => {
  d.layoutInfo.rightbarInstant = false;
  if (d.layoutInfo.viewportWidth < 1024) d.layoutInfo.narrowExpanded = !d.layoutInfo.narrowExpanded;
  else d.layoutInfo.sidebar = d.layoutInfo.sidebar === 0 ? 280 : 0;
},
```

`setSidebar` clamps into `[264, 420]`, so it can never produce the collapsed rail.
Collapsing and expanding are both the same toggle, so the plugin reads
`layoutInfo.sidebar` first and toggles **only when the current value differs from
the target**. That keeps a restore from being mistaken for a user interaction, and
stops a repeated restore from flipping state.

The expansion target is the contract default `280`, because the documented
semantics are that closing forgets the drag width:

> "For the sidebar the preference IS the width, so closing it forgets its drag width — reopening restores the contract default."
> — `stores.d.ts`

So an expanded sidebar's exact px is captured while it is expanded; once collapsed,
there is no px left to remember, and the contract's own default is what returns.

---

## 5. Bundle and plugin contract

**Source:** `dsh-client-ui-brand-official` (shipped, browser-only plugin),
`dsh-session-link@0.2.1` (npm tarball), `dsh-client-modules/lib/index.js`.

**A host half is required.** The precedent is unambiguous, and it is the pattern
the *shipped* browser-only plugins use too:

```js
// @deepseek-ai/dsh-client-ui-brand-official/lib/index.js
/** Host plugin body — this package contributes browser presentation only. */
function apply() {}
export { apply };
```

with the comment that the empty apply "gives Loader a host-side row while the
browser half ships through `exports["./client"]`". `dsh-session-link` likewise
ships a real `lib/index.js` and declares `main: lib/index.js`. The bundle patch
inserts a row whose `name` is the package, and the Loader imports that row's host
entry; the package therefore needs a root export. This repo ships a no-op host
half for exactly that reason.

**The client bundle is CJS-in-a-factory, not free-standing ESM.** A `dsh.client`
bundle is served verbatim from `exports["./client"]` and executed as a classic
script, so top-level `export` is a syntax error. The required envelope is:

```js
window.__ModuleLoader__.load({
  id: "<package name>",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // ... all side effects live here, at materialization, not at script load ...
    exports.apply = apply;
    exports.inject = [...];
    return module.exports;
  },
});
```

"executing a plugin bundle only REGISTERS its factory … every module body side
effect — including CSS injection — lives inside the factory closure and runs at
materialization, not at script execution" — `dsh-client-modules/lib/index.js`.
`dsh-session-link/lib/client.js` is written in exactly this shape.

**`inject` is declared in two places and they mean different things:**

| Where | Value | Meaning |
|---|---|---|
| `package.json` → `dsh.client.inject` | **package** names | module-graph ordering for the browser loader (`dsh-client-modules`) |
| `lib/client.js` → `exports.inject` | **service** names | Cordis service waiting for the plugin fiber |

`dsh-session-link` declares `dsh.client.inject: ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-conversation"]` and `inject: ["slots", "sessions", "locale"]`.
`dsh-client-modules` reads the declaration and validates it with
`optionalStringArray(pkgName, "dsh.client.inject", decl.inject)`.

**`dsh.bundle.patch`** (from `dsh-session-link/package.json` +
`cordis.patch.yml`):

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { ... } }
```

```yaml
- insert:
    - id: session-link
      name: 'dsh-session-link'
```

The patch inserts **only its own row**. A second row for a package the bundle
already composes fails the whole boot:
"duplicate loader entry id: session-reference" (the precedent's own note). This
plugin's patch likewise inserts one row and nothing else.

**Peer ranges.** `dsh-session-link@0.2.1` targets a `0.1.5-rc.*` harness and uses
plain caret ranges (`"^0.1.5-rc.2"`). Prerelease caret ranges do not span
prerelease lines, so this repo writes the union explicitly —
`"^0.1.0-rc.6 || ^0.1.5-rc.1"` — to stay valid across the rc lines this contract
was written against. Every `@deepseek-ai/*` shell package is a **peer** (with
`peerDependenciesMeta.optional: true`, since the plugin never imports them) so a
second copy is never installed.

---

## 6. Capability matrix

| Contract item | Captured | Restored | Exactness |
|---|---|---|---|
| `dsh_session` | yes, from `list.current` | yes, via `open()` after `byId` validation | exact, or the parameter is dropped |
| `dsh_sidebar` = `0` | yes, `layoutInfo.sidebar === 0` | yes, via `toggleSidebar()` when the pre-state differs | exact |
| `dsh_sidebar` = `<px>` | yes, `layoutInfo.sidebar` | yes, via `setSidebar(px)` | exact within `[264, 420]`, which is the store's own clamp |
| `dsh_rightbar` = `<px>` | yes, `layoutInfo.rightbar` | yes, via `setRightbar(px)` | exact within `[300, 0.7 × viewport]`, re-clamped by the store |
| `dsh_rightbar` = `0` | yes, `layoutInfo.rightbar === null` ("no saved width yet") | not applied; nothing to apply | exact as *absence* |
| right panel shown/hidden | **no** | **no** | owned by ui-sidebar-right's per-session store; see §2.5 |
| `token` and every foreign param | preserved byte-for-byte | never read, never rewritten | exact |
| pathname (`/s/<id>` etc.) | never touched | never touched | exact |

---

## 7. Verified vs. unverified

**Verified here**

- Every API claim above was read from the shipped `.js`/`.d.ts` on this machine.
- `lib/client.js` syntax-checks under Node 24 (`node --check`).
- `lib/index.js` is loadable ESM exporting a function `apply`.
- 94 stub-Cordis assertions pass (`node test/client-half.test.mjs`), covering the
  frozen contract, both fail-soft paths, the localStorage precedence rules, the
  parameter-hygiene rules, the un-pinned-store probe, and effect teardown.

**Not verified here (no browser available in this environment)**

- Real behaviour inside the running web UI: that `ctx.slots.entries("root")[0]`
  is the layout entry at the moment this plugin activates, and that the store's
  `create()` is in fact pinned at that version.
- Real React render behaviour after a restored width, and the right panel's
  `syncPresentation` interplay.
- That `history.replaceState` on this origin preserves the app's routing state
  (the app has no router, so there is nothing to preserve, but this is inferred
  from the absence of `pushState`/`hash` usage rather than observed).
- Cordis's real `ctx.effect` disposal timing (the stub models it).
