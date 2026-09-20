# dsh-view-state

[![test](https://img.shields.io/badge/test-175%20assertions%20passing-brightgreen)](#testing) · [中文](README.zh.md)

**Addressable per-tab view state for the DeepSeek Harness (`dsh`) web UI.**

`dsh`'s frontend has no router. The selected session and the two panel widths
live only in page memory, so an external shell hosting the UI in a WebView — a
desktop wrapper that wants to save and restore per-tab layout presets — has no
way to observe or replay them. This plugin makes those three facts addressable
in the URL:

```
http://127.0.0.1:3080/?dsh_session=session-abc&dsh_sidebar=300&dsh_rightbar=420&token=…
```

It keeps them in sync with live state on whatever path the page is on
(`history.replaceState` only), and reads them back on load. It adds **no UI,
no slots, no DOM and no CSS**.

---

## The URL contract

| Parameter | Meaning | Absent means | Range |
|---|---|---|---|
| `dsh_session` | the currently selected session | no session selected | any id present in the session list |
| `dsh_sidebar` | sidebar width preference, px | not yet known | `0` = collapsed, else `264`–`420` |
| `dsh_rightbar` | right panel *saved* width, px | not yet known | `0` = no saved width, else `300`–`0.7 × viewport` |

Rules the plugin guarantees:

1. **Only these three parameters are ever written**, and only via
   `history.replaceState` — never `pushState`, never a reload, never a
   navigation. The **pathname is never changed**, so `/s/<sessionId>` deep links
   keep working.
2. **Foreign parameters are preserved byte-for-byte and in order.** `token`, in
   particular, is never decoded, re-encoded or reordered: it is what the server
   authenticated against.
3. **Unknown is not absent.** A fact nobody has read yet (the layout store has
   not mounted, the session list has not loaded) leaves its parameter **exactly
   as supplied**. A parameter is removed only when its fact is *known* to be
   absent — e.g. a session list that has loaded and provably lacks the id.
   Erasing a wrapper's `?dsh_sidebar=320` because our first read happened too
   early would be data loss, not a degrade path.
4. **Reachability is retried, never sampled once.** `ui-layout` registers the
   pinned layout store on the `root` slot *after* this plugin activates, so the
   plugin waits for the registry's own change notification
   (`ctx.slots.subscribe("root", …)`) with an escalating polling fallback, then
   applies the requested widths. The "widths cannot be restored" warning is
   emitted **once, and only after that schedule is exhausted**.
5. Unparsable and negative widths are treated as **absent**, not as `0`.
6. The URL wins over `localStorage` when both carry a value; `localStorage` fills
   the gaps the URL left. A URL that already matches the live state is **not
   rewritten at all**.
7. Unknown session ids **fail soft**: only that parameter is dropped; everything
   else keeps working.
8. Every missing service, missing slot or thrown error is swallowed. At most
   **one** `console.warn` is emitted per activation.

### What changed in 0.2.0

Two independent defects, both proven in a real browser:

- **Retry-based reachability.** The plugin used to probe `ctx.slots.entries("root")`
  exactly once, synchronously, inside `apply()`. Measured on a live
  `0.1.5-rc.1` web profile, that probe is always empty — `ui-layout` registers the
  seat ~4 s later — so the one attempt failed, the plugin warned, and no width was
  ever applied. It now waits for the seat (registry notification + escalating
  polling) and applies the requested state when it arrives.
- **Unknown ≠ null.** An unread fact used to be published as `null`, which the URL
  writer interprets as "remove this parameter". A wrapper-supplied
  `?dsh_sidebar=320` was therefore deleted by the page during the boot window, and
  `location.search` came back empty. Facts now carry an explicit knownness, and a
  parameter is only ever removed when the fact is known to be absent.

### What changed in 0.2.1

One defect, proven by direct evidence rather than reasoning, and it is why saved
presets carried no session. Measured in a real browser profile (WebView2 leveldb,
origin `http://127.0.0.1:3082`), two keys for the same origin:

```
dsh.sessions.current = {"sessionId":"session-6ec917c4-…"}   <- the app's own persisted selection
dsh.view-state.v1    = {"session":null,"sidebar":280,"rightbar":0}   <- what this plugin recorded
```

The app knew the session; the plugin recorded `null`, so each captured preset had
`dsh_session=` empty on every tab while the widths captured fine — "reopening a
layout does not remember which conversation I was in".

Three measured facts had to line up, and each was verified on a live web profile
with a diagnostic build of this plugin:

1. **`list.current` can be blank while a session is selected.** The public list
   store's own field doc calls it a *transiently absent selection*. The durable
   value lives in the session controller's **persisted selection cell**, an own
   property on the very object provided as `ctx.sessions`:
   `ctx.sessions.selection.getSnapshot().sessionId`.
2. **The `sessions` service is not published yet when this plugin activates.**
   Measured: `ctx.get("sessions")` is `undefined` inside `apply()` and a real
   service ~1 s later. A single lookup therefore left the plugin with no session
   source and no subscription for the whole page life.
3. **The list can finish loading after the last mirror.** The layout seat is
   resolved around 4 s and the session list loaded later still, so nothing
   republished the selection once the store finally had it.

The plugin now reads the selection in a fixed order, binds the service whenever it
appears, and republishes when its own watch concludes:

1. `ctx.sessions.list.getSnapshot().current` — the public face, preferred;
2. when that is not a non-empty string, the persisted cell
   `ctx.sessions.selection.getSnapshot().sessionId`, structurally validated
   (an object with `getSnapshot`, and a non-empty string id);
3. otherwise exactly the previous semantics: unknown stays unknown, so an
   existing `dsh_session` parameter is preserved rather than removed.

Both stores are subscribed, and the sessions service is re-read on every mirror and
on an escalating retry schedule — there is no public notification for "a service
appeared", so this is the same retry the layout seat already needed. Every earlier
guarantee is unchanged: `replaceState` only, the pathname untouched, foreign
parameters byte-exact, fail-soft, no UI/DOM/CSS. The fallbacks are guarded
*runtime* reaches, never promises: if a future version drops the property or the
service, behaviour is exactly what it was in 0.2.0.

---

## Install

```bash
dsh plugin --profile web add github:RailgunHamster/dsh-view-state
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` registers it in the
profile's `dsh.profile.bundles` automatically and the row is composed at boot —
no manual YAML editing.

```bash
dsh web           # restart the Web GUI, then refresh the page
```

> **Package-manager forms.** Once published to npm: `dsh plugin --profile web add dsh-view-state`.
> Manual install without the bundle mechanism: `pnpm add dsh-view-state` in the
> profile directory, then add this to the profile's patch layer
> (e.g. `~/.dsh/profiles/web/cordis.patch.yml`):
>
> ```yaml
> - insert:
>     - id: view-state
>       name: 'dsh-view-state'
> ```

**Requirements:** dsh with a web profile, roughly `0.1.0-rc.6` or newer
(`0.1.5-rc.1`/`0.1.5-rc.2` is what this was developed against). Nothing else is
needed — `sessions`, `layout` and `slots` are all composed by the shipped web
bundle, and the plugin declares **no hard service dependency**, so it can never
wedge a boot.

---

## What the external shell should do

The whole point is that a wrapper never has to reach into the page. Read the URL,
save it, and replay it.

### Capture (per tab)

Read the URL, keep only the parameters you own:

```csharp
// WPF / WinForms WebView2
string source = webView.Source.ToString();          // e.g. http://127.0.0.1:3080/s/session-abc?dsh_session=…&token=…
var uri  = new Uri(source);
string query = uri.Query;                            // "?dsh_session=…&dsh_sidebar=300&dsh_rightbar=420&token=…"
string path  = uri.AbsolutePath;                     // "/s/session-abc"  — save this too, it is not ours to change

// Store `path` + the three dsh_* values as this tab's preset. Never store or
// reuse `token` across restarts; it is per-launch.
```

Because the plugin writes on every real state change, the URL is always current:
`Source` after the user picks a session or drags a handle already reflects it.

### Restore (per tab)

Navigate the WebView to the origin **plus** the saved path and the three
parameters, leaving the app's own startup parameters alone:

```csharp
string restored =
    $"{origin}{savedPath}" +
    $"?dsh_session={Uri.EscapeDataString(savedSession)}" +
    $"&dsh_sidebar={savedSidebar}" +
    $"&dsh_rightbar={savedRightbar}" +
    startupParameters;          // must still carry the app's own `token`

webView.Source = new Uri(restored);
```

On load the plugin reads the three values and applies them once the session list
and the layout store are ready. If a session id is no longer in the list, that
parameter alone is dropped and the rest still applies.

### Notes for wrapper authors

- **Use `replaceState`-style navigation, not a fresh page load, when you can.**
  Setting `Source` reloads the app; if your wrapper can rewrite the query string
  in place, the plugin picks the change up on its own.
- **Never send only the three parameters.** Keep the shell's own query string
  (notably `token`) or the page will fail to authenticate.
- **A tab with no state yet has an empty `dsh_session`.** Treat a missing or
  empty `dsh_session` as "no session", not as an error.
- `dsh_sidebar=0` is a real, meaningfully collapsed sidebar; `dsh_rightbar=0`
  means "the right panel has never been opened", so there is no width to restore.

---

## Known limitations

These are the honest edges of what the plugin can do on dsh `0.1.5-rc.*`. The
underlying API facts are in [`docs/API-NOTES.md`](docs/API-NOTES.md).

- **The right panel's shown/hidden state is NOT captured or restored.** Whether
  the right panel is expanded is not part of the layout store's source of truth:
  it is `surface.layout.expanded` inside `@deepseek-ai/dsh-client-ui-sidebar-right`'s
  **per-session** store, and that seat reports it back into the frame on every
  layout effect. Writing it from here would race the seat. `dsh_rightbar`
  therefore captures the *saved width* only — a panel the user opens later opens
  at the restored width.
- **An expanded sidebar's exact px is lost once it is collapsed.** By contract
  "closing forgets its drag width — reopening restores the contract default"
  (`SIDEBAR_DEFAULT = 280`). Capture while expanded gives exact px; capture while
  collapsed gives `0`, and restoring `0` re-collapses. Nothing is silently
  invented, but the pre-collapse width is genuinely gone by the app's own design.
- **Widths are re-clamped by the app.** `setSidebar` clamps to `[264, 420]`, and
  `setRightbar` to `[300, 0.7 × viewport]`. The right panel's ceiling is
  viewport-relative, so a width saved on a wide window comes back narrower on a
  narrow one. The plugin does not fight that.
- **Sub-1024px sidebar auto-collapse is not modelled.** Below
  `SIDEBAR_AUTO_COLLAPSE = 1024` the sidebar renders as a rail driven by
  `narrowExpanded`, which is not part of this contract.
- **Not captured:** the selected global main panel
  (`panelInfo.activePanelId`), the right panel's tab/split contents, scroll
  positions, or anything about a session other than its id.
- **A session id outside the current list cannot be restored**, and
  `dsh_session` only round-trips within one `$DSH_HOME`; session ids are opaque
  and local.
- **Reaching the layout store depends on an implementation detail.** The plugin
  gets the live store from the `store` seat on the `root` slot registration and
  verifies it is pinned (two `create()` calls must return the same object). The
  seat is registered *after* this plugin activates (measured: `entries("root")`
  is empty inside `apply()`, one entry ~4 s later), so the plugin waits for it.
  If a future ui-layout never registers a pinned store, width restore degrades to
  a single warning — **after** the retry schedule is exhausted, ~7.5 s — and the
  URL/localStorage mirroring keeps working. See
  [`docs/API-NOTES.md` §2.3](docs/API-NOTES.md).
- **Reading the selected session depends on one runtime detail.** The public face
  is `sessions.list.getSnapshot().current`, and on a page where that field is
  blanked (measured) the plugin falls back to the session controller's own
  persisted selection cell, `sessions.selection.getSnapshot().sessionId` — an
  internal property the controller declares `private`. The plugin probes it
  structurally and does nothing when it is missing or wrong-shaped, so a future
  version that drops it degrades to exactly the 0.2.0 behaviour rather than
  breaking. The `sessions` service is also looked up through `ctx.get()` on every
  mirror plus a retry schedule, because it is published *after* this plugin
  activates (measured: `undefined` in `apply()`, a service ~1 s later).
- **Verified in a real browser** (headless Edge over CDP, live web profile,
  plugin installed): `?dsh_sidebar=320` restores a ≈320 px sidebar and the
  parameter survives the boot; `?dsh_sidebar=0` collapses to the ≈56 px rail; a
  parameterless load mirrors the store's own default (0.2.0); and with the app's
  persisted selection in place before load, a plain reload publishes that session
  into the URL and `localStorage` where 0.2.0 recorded `null`, while
  `?dsh_sidebar=320&dsh_session=<id>` still round-trips (0.2.1). See
  [`docs/API-NOTES.md` §7](docs/API-NOTES.md).

---

## Testing

```bash
node test/client-half.test.mjs     # or: npm test
```

175 assertions, no dependencies, no browser: the real `lib/client.js` is loaded
through a hand-written fake `ctx` (services `sessions`, `layout`, `slots`, plus
`effect`), with `window`, `history`, `localStorage` and a controllable
`setTimeout`/`clearTimeout` pair. It covers the frozen contract, the exact
resulting URL strings, pathname preservation, `token` preservation and byte-exact
foreign parameters, unknown-id drop, storage fallback and precedence, the
un-pinned-store probe, and effect teardown — plus the two 0.2.0 fixes (a `root`
slot that appears only on the Nth tick: widths read, applied, mirrored, and no
warning before the retries are spent; and the unknown-vs-null rule) and the 0.2.1
fix (the session read order across the list and the persisted selection cell, both
subscriptions including a selection change that never touches `list.current`, a
sessions service that only appears after `apply()`, the wrong-shaped / missing cell
boundaries, and the exact resulting URLs). Every block disposes its fiber first, so
a retired retry timer can never leak into the next assertion.

---

## Layout

```
lib/client.js              the browser half (plain ESM, no build step, no bundler)
lib/index.js               no-op host half — required so the Loader row has a host export
cordis.patch.yml           the bundle patch (`dsh.bundle.patch`): inserts this one row
test/client-half.test.mjs  stub-Cordis contract test
docs/API-NOTES.md          every API fact relied on, with file paths and quotes
```

## License

[MIT](LICENSE)
