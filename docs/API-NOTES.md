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

### 1.1 `list.current` is not always populated — the 0.2.1 defect

**Source:** measured in a real browser profile (HarnessPortable's WebView2 leveldb,
origin `http://127.0.0.1:3082`), then read back out of
`dsh-api-session-controller/lib/client.js`.

Both facts sat side by side in the same profile, for the same origin:

```
dsh.sessions.current = {"sessionId":"session-6ec917c4-1676-4ed0-9cdb-3313559ab9f3"}   <- the app's own persisted selection
dsh.view-state.v1    = {"session":null,"sidebar":280,"rightbar":0}                     <- what this plugin recorded
```

The app knew the session; the plugin recorded `null`. Every saved preset therefore
carried `dsh_session=` empty, while the two widths captured fine.

The list store's own field doc says why `current` can be blank even while a
selection exists:

> `current` rides the same snapshot (arbitrated: …) — `service.d.ts`
> "a transiently absent selection blanks `current` without moving the stage"
> — `ClientSessions.watched` (`lib/client.js`)

The durable half of that same fact is the controller's **persisted selection
cell**, an own property on the very object provided as `ctx.sessions`:

```js
this.selection = createSnapshotStore({}, { persist: { name: "dsh.sessions.current" } });
const restored = this.selection.getSnapshot();          // { sessionId, subagentAddress }
this.manager = new SessionManager(remote, restored.sessionId, restored.subagentAddress);
```

— `dsh-api-session-controller/lib/client.js` (property name `selection` survives
minification; the app itself uses `.getSnapshot().sessionId`)

Its type is `private readonly selection;` (`service.d.ts`) with the doc "Private on
purpose: reads go through the list snapshot; writes through `ClientSessions.open`
/ `clear`." That makes this reach a **runtime** fact, not a promised API, which is
exactly how the plugin treats it.

**Read order (0.2.1):**

1. `ctx.sessions.list.getSnapshot().current` — the public face, preferred.
2. When that is not a non-empty string:
   `ctx.sessions.selection.getSnapshot().sessionId`, only after a structural check
   (the cell is an object with `getSnapshot`; the id is a non-empty string).
3. Otherwise the previous semantics are unchanged: `null` when a source was
   readable (known-absent), `undefined` when none was — so an unresolved
   `dsh_session` is still preserved rather than erased.

Reading the **cell** rather than the list is what makes the mirror agree with the
app's own persistence: the cell is what
`localStorage["dsh.sessions.current"]` is written from.

### 1.2 The service itself arrives late — and there is no notification for it

**Source:** measured on a live `0.1.5-rc.1` web profile (headless Edge over CDP,
diagnostic probe inside `lib/client.js`). Timing of the two seats this plugin
depends on, relative to its own `apply()`:

```
apply()                    ctx.get("sessions") = undefined      ctx.get("slots") = object
apply() + microtask        ctx.get("sessions") = undefined
apply() + ~1 s             ctx.get("sessions") = object  { list, manager, selection, … }
layout store seat          present on the first 'root' probe in some boots, ~4 s later in others
session list populated     after the layout seat in the common boot
```

So a single `ctx.get("sessions")` in `apply()` returned `undefined` on every page
without a deep link, and since `startSessionWatch` was only called there, **no
session subscription was ever installed** and the mirror never learned the
selection. Both stores were reachable at ~1 s; nothing was reading them.

There is no public "this service appeared" notification — that facility exists for
the slot registry (`ctx.slots.subscribe(key, …)`) and not for services — so the
lookup is retried on the same escalating schedule as the layout seat
(`watchSessions()`, `LAYOUT_RETRY_DELAYS`) and the service is bound as soon as it
appears. A missing sessions service stays a supported boot: giving up is silent,
and the URL/localStorage channels keep working.

The same measurements show why the *watch* must be able to republish on its own:
the layout seat can be resolved before the service appears, so the last
layout-driven mirror happened before there was anything to read, and the list
finished loading after it. The watch therefore calls back into the mirror when it
reaches a conclusion — including the out-of-attempts "still unknown" one — which
is what finally published a restored selection that had been sitting in the store
the whole time. Measured before that callback existed: store correct, URL and
`localStorage` both `null`.

**Consequences for this plugin**

- Selection is read in the order above, never from the layout store (see §3).
- The sessions service is looked up on every mirror and on a retry schedule, never
  captured once at `apply()`.
- Both stores are subscribed (`list.subscribe` **and** `selection.subscribe`), so a
  selection that only the persisted cell carries — the measured case — still
  re-mirrors. Before 0.2.1 only `list` was followed, so a change the list did not
  report was invisible to the plugin.
- A cell that is readable and holds no `sessionId` counts as **known-absent**, the
  same as an empty `list.current`. A cell that is missing or wrong-shaped is
  **unknown** — the fallback simply does not exist, and behaviour is exactly what it
  was before this version.
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

…but only **after the seat exists**: at `apply()` time this array is empty in
practice (§2.3.1), so callers must wait for the registry change notification or
poll. The snippet above is the shape of the read, not a boot-time recipe.

This works **only because ui-layout pinned `create()`**. The plugin verifies that
property rather than assuming it: it calls `create()` twice and requires the two
results to be identical objects. A plain `defineStore` handle returns a fresh
instance per call (`dsh-client-runtime/src/client/contract/store.ts`: "create()
deliberately does not dedupe or throw"), so an unpinned handle fails the probe and
the plugin declines to mutate a store nobody is rendering — which is why the test
suite has an explicit "un-pinned store" case.

### 2.3.1 Timing: the seat is registered *after* a third-party `apply()`

**This is the correction that 0.2.0 exists for.** Reading the registry is not
enough; it has to be read *late enough*. Measured on a live `0.1.5-rc.1` web
profile (plugin installed, headless Edge over CDP, diagnostic build logging
`ctx.slots.entries("root")` from inside the plugin):

```
DVV entries=0 []                                                   <- inside apply(): entries("root") is EMPTY
DVV later entries=1 [{"hasStore":true,"createType":"function"}]     <- ~4 s later: exactly one entry, with a store
```

So the earlier version of this plugin, which called `resolveLayoutStore()` exactly
once — synchronously, inside `apply()` — always degraded:

```
dsh-view-state: panel widths cannot be restored (no pinned layout store was found on the 'root' slot); URL and localStorage mirroring continue
```

`ui-layout`'s `register()` call happens after our `apply()` has already run. The
slot registry offers the notification needed to wait for it:

> `subscribe(key: keyof SlotMap & string, fn: () => void): () => void;` — "Subscribe to a key's registration changes (microtask-batched)."
> — `dsh-client-ui-renderer/lib/types/client/registry.d.ts`

and ui-layout itself already uses it: `const disposePanels = ctx.slots.subscribe("main", retainMainPanels);`
(`dsh-client-ui-layout/lib/client.js`). 0.2.0 therefore waits on
`ctx.slots.subscribe("root", …)` and keeps an escalating polling fallback
(`LAYOUT_RETRY_DELAYS = [0, 50, 150, 400, 900, 2000, 4000]`, the same shape as the
session schedule) for a registry without `subscribe()` or an un-pinned store that
becomes pinned later. The degrade warning is emitted once, and only after that
schedule is exhausted (~7.5 s cumulative), never on the first empty read.

### 2.3.2 Unknown ≠ null (the second, independent defect)

The first read being empty must not be *published* either. The old mirror treated
"no reading was taken" as `null`, and `null` in the URL writer means "remove the
parameter" — so a wrapper-supplied `?dsh_sidebar=320` was deleted by the page
during the boot window and `location.search` came back empty:

```
location.search = ""                                              <- the plugin removed the parameter it was given
localStorage["dsh.view-state.v1"] = {"session":null,"sidebar":null,"rightbar":null}
sidebar rendered at 280 (the default)                             <- nothing was applied
```

Every published fact is now `{ known: false }` or `{ known: true, value }`. A
parameter is written when its fact is known and present, removed only when the
fact is known to be absent, and copied through untouched while it is unknown. The
same rule covers `dsh_session` while the session list has not resolved.

### 2.3.3 The second, weaker route to the actions: `ctx.layout` itself is built from
`instance.actions`, so its own methods write to the same store. But it only
exposes `toggleSidebar` (0 ⟷ contract default) and `openRightbar`/`closeRightbar`,
so it cannot set an arbitrary px and cannot be read at all. The plugin uses it for
nothing.

### 2.4 What this makes restorable

| Fact | Where it lives | Read | Write | Exact? |
|---|---|---|---|---|
| selected session | `ctx.sessions.list.current`, else the persisted `ctx.sessions.selection` cell (§1.1) | yes | `ctx.sessions.open(id)` | yes, or fail-soft drop |
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
| `dsh_session` | yes, from `list.current`, else from the persisted `sessions.selection` cell | yes, via `open()` after `byId` validation | exact, or the parameter is dropped |
| `dsh_sidebar` = `0` | yes, `layoutInfo.sidebar === 0` | yes, via `toggleSidebar()` when the pre-state differs | exact |
| `dsh_sidebar` = `<px>` | yes, `layoutInfo.sidebar` | yes, via `setSidebar(px)` | exact within `[264, 420]`, which is the store's own clamp |
| `dsh_rightbar` = `<px>` | yes, `layoutInfo.rightbar` | yes, via `setRightbar(px)` | exact within `[300, 0.7 × viewport]`, re-clamped by the store |
| `dsh_rightbar` = `0` | yes, `layoutInfo.rightbar === null` ("no saved width yet") | not applied; nothing to apply | exact as *absence* |
| right panel shown/hidden | **no** | **no** | owned by ui-sidebar-right's per-session store; see §2.5 |
| a fact that is still **unknown** | **no** | **no** | its parameter is left exactly as supplied; only a *known-absent* fact removes one (§2.3.2) |
| `token` and every foreign param | preserved byte-for-byte | never read, never rewritten | exact |
| pathname (`/s/<id>` etc.) | never touched | never touched | exact |

---

## 7. Verified vs. unverified

**Verified here**

- Every API claim above was read from the shipped `.js`/`.d.ts` on this machine.
- `lib/client.js` syntax-checks under Node 24 (`node --check`).
- `lib/index.js` is loadable ESM exporting a function `apply`.
- 175 stub-Cordis assertions pass (`node test/client-half.test.mjs`), covering the
  frozen contract, both fail-soft paths, the localStorage precedence rules, the
  parameter-hygiene rules, the un-pinned-store probe, effect teardown, both
  0.2.0 fixes (an Nth-tick `root` seat — retried, applied, mirrored, no warning
  before the schedule is spent — and the unknown-vs-absent rule), and the 0.2.1
  fix (the session read order across both stores, their subscriptions, the
  wrong-shaped / missing cell boundaries, a sessions service that only appears
  after `apply()`, and the `known-absent` / `unknown` boundary when no cell
  exists).
- **Real browser, end to end.** Headless Edge over CDP, against a live
  `dsh --profile web --port 3081 --no-open` profile with this plugin installed;
  the client module is served from disk, so `lib/client.js` was synced into the
  profile and re-measured without a dsh restart. The served bundle was confirmed
  to contain the new code (`hasRetryCode: true`). Three boots, each with a fresh
  browser profile, token-authenticated first and then navigated to the URL under
  test:

  | Boot URL | `location.search` after boot | `localStorage["dsh.view-state.v1"]` | rendered sidebar (`div[class*="sidebarCol"]`) | plugin console output |
  |---|---|---|---|---|
  | `?dsh_sidebar=320` | `?dsh_sidebar=320&dsh_rightbar=0` | `{"session":null,"sidebar":320,"rightbar":0}` | **320 px** | none |
  | `?dsh_sidebar=0` | `?dsh_sidebar=0&dsh_rightbar=0` | `{"session":null,"sidebar":0,"rightbar":0}` | **56 px** (`.…_collapsed` rail) | none |
  | *(no parameters)* | `?dsh_sidebar=280&dsh_rightbar=0` | `{"session":null,"sidebar":280,"rightbar":0}` | **280 px** (store default) | none |

  All three are the success criteria, measured rather than reasoned: the supplied
  parameter survives and is mirrored back from the store, the width is actually
  applied to the rendered frame, and **no degraded warning is emitted** in any
  case. The pre-0.2.0 behaviour of the same first row was
  `location.search = ""` plus the "panel widths cannot be restored" warning.

- **Real browser, 0.2.1 (the session read order).** Same rig, fresh browser
  profile, the app's own persisted selection put in place *before* any page script
  runs (`Page.addScriptToEvaluateOnNewDocument`, so the measurement is not racing
  the app's own restore):

  | Boot URL | `location.search` after boot | `localStorage["dsh.view-state.v1"]` | sidebar | plugin console |
  |---|---|---|---|---|
  | `/` (no `dsh_*` params, `dsh.sessions.current` = a listed session) | `?dsh_sidebar=280&dsh_rightbar=0&dsh_session=<that session>` | `{"session":"<that session>","sidebar":280,"rightbar":0}` | 280 px | none |
  | `?dsh_sidebar=320&dsh_session=<that session>` | `?dsh_sidebar=320&dsh_session=<that session>&dsh_rightbar=0` | `{"session":"<that session>","sidebar":320,"rightbar":0}` | **320 px** | none |
  | `?dsh_sidebar=320` (session parameter absent) | `?dsh_sidebar=320&dsh_rightbar=0` | `{"session":null,"sidebar":320,"rightbar":0}` | **320 px** | none |

  The first row is the defect: before 0.2.1 the same boot recorded
  `{"session":null,…}` and carried no `dsh_session` at all, because
  `ctx.get("sessions")` was `undefined` inside `apply()` and the selection cell was
  therefore never read (its value, in the user's profile, was the id shown above).
  Sampled repeatedly for 30 s in that same run, the store's session first appears
  at ~12–20 s (the list load), and the URL/localStorage pick it up in the same
  tick — the watch's own republish, not a later user action. The `token` parameter
  is consumed by the app's own redirect on the very first navigation, which is why
  it is absent from every `location.search` above; a later navigation that carries
  it behaves as the first 0.2.0 table already proves.

**Not verified here**

- That `ctx.slots.entries("root")[0]` is the layout entry at the moment this
  plugin activates: measured false (§2.3.1). What *is* verified is that the seat
  arrives later and the retry reaches it — hence the design.
- Real React render behaviour *between* the store write and the next paint, and
  the right panel's `syncPresentation` interplay (the right panel's saved width
  round-trips in the store; whether it is *shown* is not ours, §2.5).
- That `history.replaceState` on this origin preserves the app's routing state
  (the app has no router, so there is nothing to preserve, but this is inferred
  from the absence of `pushState`/`hash` usage rather than observed).
- Cordis's real `ctx.effect` disposal timing (the stub models it), and the real
  registry's microtask batching of `slots.subscribe` (the CDP runs prove the
  event path reaches the seat; the unit test models the notification as
  synchronous so the Nth-tick case is deterministic).
- The un-pinned-store and retry-exhaustion paths were exercised only in the
  browser against the *working* pinning; the failure branches are unit-tested.
