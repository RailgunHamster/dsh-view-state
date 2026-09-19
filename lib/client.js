// dsh-view-state — browser half.
//
// Makes the dsh web UI's *per-tab view state* addressable from outside the
// page, so an external shell (e.g. a desktop wrapper hosting the UI in a
// WebView and saving per-tab layout presets) can read what the user was
// looking at and restore it later.
//
// dsh's frontend has no router: the selected session and the two panel widths
// live only in page memory (a root slot store plus the sessions list store).
// This plugin therefore mirrors three facts of that live state into query
// parameters on whatever path the page is on, and reads them back at boot.
//
// Frozen URL contract (another codebase is written against it):
//   dsh_session=<sessionId>  currently selected session; removed when none
//   dsh_sidebar=<px>         sidebar width preference in px; 0 = collapsed
//   dsh_rightbar=<px>        right panel saved width in px;  0 = no saved width
//
// Hard rules this file obeys:
//   1. history.replaceState ONLY — never pushState, never a reload, never a
//      navigation. We never touch the pathname (so `/s/<sessionId>` deep links
//      keep working) and never touch a parameter we do not own (especially
//      `token`, which the generated startup URL uses for auth). Order of
//      foreign parameters is preserved as far as practical.
//   2. Fail soft. Every missing service, missing slot, unknown session id or
//      thrown error is swallowed (at most one console.warn) and leaves the page
//      exactly as it was. This plugin must never be able to break the UI.
//   3. Zero visual surface: no slots, no DOM, no CSS, no UI of any kind.
//
// Everything is plain ESM JavaScript (no TypeScript, no build step, no
// bundler). The file is wrapped in the harness's client-module registration
// envelope (`window.__ModuleLoader__.load`) because a `dsh.client` bundle is
// served verbatim from `exports["./client"]` and executed by
// `@deepseek-ai/dsh-client-modules`; that envelope is what makes the module
// table entry and keeps all side effects inside the factory closure (nothing
// runs at script-execution time, only at materialization).
window.__ModuleLoader__.load({
	id: "dsh-view-state",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// ---------------------------------------------------------------------
		// Contract constants
		// ---------------------------------------------------------------------

		/** Query parameters this plugin owns. Nothing else is ever read or written. */
		const P_SESSION = "dsh_session";
		const P_SIDEBAR = "dsh_sidebar";
		const P_RIGHTBAR = "dsh_rightbar";
		/** One namespaced localStorage key holding the same three facts. */
		const STORAGE_KEY = "dsh.view-state.v1";

		// Width ranges. These mirror @deepseek-ai/dsh-client-ui-layout's own
		// columns contract (SIDEBAR_MIN/MAX, RIGHTBAR_MIN, RIGHTBAR_MAX_RATIO).
		// They are duplicated deliberately: this plugin must not import a
		// harness package at runtime, and a drift here can only ever make a
		// restored width slightly narrower than the store would have allowed —
		// never wider, because the store re-clamps every write.
		const SIDEBAR_MIN = 264;
		const SIDEBAR_MAX = 420;
		/** The shipped contract default; used to materialize an expanded sidebar. */
		const SIDEBAR_DEFAULT = 280;
		/** Right panel floor. The ceiling is viewport-relative and stays the store's job. */
		const RIGHTBAR_MIN = 300;

		/** Sidebar width that means "collapsed" in the contract. */
		const COLLAPSED = 0;

		/**
		 * Where the right panel's live state actually lives, recorded here because
		 * it is the single least obvious fact in this plugin's design:
		 *
		 * `layoutInfo.rightbar` is the *saved width*. It is `null` until the panel
		 * has been opened once; after that it keeps the last px across resizes and
		 * closes (the field's own doc says so: "Resizing the frame and closing the
		 * panel preserve this preference"). So `dsh_rightbar=0` is exactly
		 * "no saved width yet" and every positive value round-trips losslessly,
		 * *including while the panel is hidden*.
		 *
		 * Whether the panel is currently *shown* is NOT ours to restore: it is
		 * `surface.layout.expanded` inside @deepseek-ai/dsh-client-ui-sidebar-right's
		 * per-session store, and that seat reports it back to the frame through
		 * `ctx.layout.openRightbar/closeRightbar`. Driving it from here would race
		 * the seat. See docs/API-NOTES.md for the full capability matrix.
		 */

		/** Structural probe for the root layout store instance (see resolveLayoutStore). */
		const LAYOUT_STORE_PROBE = "activePanelId";
		/** Escalating retry schedule (ms) for a session id that the list has not resolved yet. */
		const SESSION_RETRY_DELAYS = [0, 50, 150, 400, 900, 2000, 4000];

		// ---------------------------------------------------------------------
		// Small helpers
		// ---------------------------------------------------------------------

		/** True for a value that can carry query parameters. */
		function hasLocation() {
			return typeof window !== "undefined" && window.location !== void 0 && typeof window.location.search === "string";
		}

		/** True when the object is a non-null object. */
		function isObject(value) {
			return typeof value === "object" && value !== null;
		}

		/**
		 * Parse a raw query string into ordered `{ key, raw }` segments.
		 *
		 * The raw (still percent-encoded) text is kept per segment so that
		 * rebuilding the string cannot re-encode or re-order parameters this
		 * plugin does not own — most importantly `token`, whose exact bytes the
		 * server authenticated against.
		 * @param search - location.search, with or without the leading '?'.
		 * @returns ordered segments; malformed pieces survive as opaque text.
		 */
		function parseSearch(search) {
			const body = typeof search === "string" && search.startsWith("?") ? search.slice(1) : typeof search === "string" ? search : "";
			if (body === "") return [];
			const segments = [];
			for (const piece of body.split("&")) {
				if (piece === "") continue;
				const eq = piece.indexOf("=");
				if (eq === -1) {
					segments.push({ key: piece, raw: null });
					continue;
				}
				segments.push({ key: piece.slice(0, eq), raw: piece.slice(eq + 1) });
			}
			return segments;
		}

		/**
		 * Decode one percent-encoded query value, mapping '+' to a space as
		 * `application/x-www-form-urlencoded` requires.
		 * @param raw - the raw segment value.
		 * @returns the decoded value, or the input when decoding fails.
		 */
		function decodeValue(raw) {
			if (raw === null) return null;
			try {
				return decodeURIComponent(raw.replace(/\+/gu, " "));
			} catch {
				// A malformed escape sequence is not worth failing over.
				return raw;
			}
		}

		/** Encode one value with form semantics (space as '+'), matching URLSearchParams. */
		function encodeValue(value) {
			return encodeURIComponent(value).replace(/%20/gu, "+");
		}

		/**
		 * Read the plugin's own parameters out of a query string.
		 * @param search - location.search.
		 * @returns the three owned values (null when absent).
		 */
		function readOwnedParams(search) {
			const out = { session: null, sidebar: null, rightbar: null };
			for (const segment of parseSearch(search)) {
				if (segment.key === P_SESSION) out.session = decodeValue(segment.raw);
				else if (segment.key === P_SIDEBAR) out.sidebar = decodeValue(segment.raw);
				else if (segment.key === P_RIGHTBAR) out.rightbar = decodeValue(segment.raw);
			}
			return out;
		}

		/**
		 * Rewrite only the plugin's own parameters, in place.
		 *
		 * Owned parameters are replaced where they already sit (so their position
		 * is stable) or appended at the end; a null value removes the parameter.
		 * Every other segment is copied through byte-for-byte, in order.
		 * @param search - the current location.search.
		 * @param next - owned values to write; null removes.
		 * @returns the new query string, with the leading '?'.
		 */
		function writeOwnedParams(search, next) {
			const owned = new Map([
				[P_SESSION, next.session === null || next.session === void 0 ? null : String(next.session)],
				[P_SIDEBAR, next.sidebar === null || next.sidebar === void 0 ? null : String(next.sidebar)],
				[P_RIGHTBAR, next.rightbar === null || next.rightbar === void 0 ? null : String(next.rightbar)],
			]);
			const out = [];
			const written = new Set();
			for (const segment of parseSearch(search)) {
				if (!owned.has(segment.key)) {
					out.push(segment.raw === null ? segment.key : `${segment.key}=${segment.raw}`);
					continue;
				}
				if (written.has(segment.key)) continue; // collapse a duplicate owned key into one
				written.add(segment.key);
				const value = owned.get(segment.key);
				if (value !== null) out.push(`${segment.key}=${encodeValue(value)}`);
			}
			for (const [key, value] of owned) {
				if (value === null || written.has(key)) continue;
				out.push(`${key}=${encodeValue(value)}`);
			}
			return out.length === 0 ? "" : `?${out.join("&")}`;
		}

		/**
		 * Parse a width parameter.
		 *
		 * Unparsable, negative and non-finite values are treated as absent, and
		 * decimals are floored. The upper bound is left to the layout store, which
		 * clamps against the live viewport (the right panel's ceiling is
		 * proportional to it, so this layer cannot know the real maximum).
		 * @param raw - the decoded parameter value.
		 * @param max - a conservative static ceiling.
		 * @returns the width in px, or null when the value is not usable.
		 */
		function parseWidth(raw, max) {
			if (typeof raw !== "string") return null;
			const trimmed = raw.trim();
			if (trimmed === "") return null;
			const value = Number(trimmed);
			if (!Number.isFinite(value) || value < 0) return null;
			return Math.min(Math.floor(value), max);
		}

		/**
		 * Read the local fallback copy.
		 * @returns the stored triple, or null when absent/unreadable.
		 */
		function readStorage() {
			try {
				if (typeof localStorage === "undefined") return null;
				const raw = localStorage.getItem(STORAGE_KEY);
				if (raw === null) return null;
				const parsed = JSON.parse(raw);
				if (!isObject(parsed)) return null;
				return {
					session: typeof parsed.session === "string" && parsed.session !== "" ? parsed.session : null,
					sidebar: typeof parsed.sidebar === "number" && Number.isFinite(parsed.sidebar) ? parsed.sidebar : null,
					rightbar: typeof parsed.rightbar === "number" && Number.isFinite(parsed.rightbar) ? parsed.rightbar : null,
				};
			} catch {
				// A corrupt or unavailable store is simply no fallback at all.
				return null;
			}
		}

		/**
		 * Write the write-through copy. Storage failures (private mode, quota) are
		 * non-fatal by design: the URL remains the primary channel.
		 * @param state - the triple to persist.
		 */
		function writeStorage(state) {
			try {
				if (typeof localStorage === "undefined") return;
				localStorage.setItem(STORAGE_KEY, JSON.stringify({
					session: state.session,
					sidebar: state.sidebar,
					rightbar: state.rightbar,
				}));
			} catch {
				/* see above */
			}
		}

		// ---------------------------------------------------------------------
		// Root layout store resolution (the one open question this plugin answers)
		// ---------------------------------------------------------------------
		//
		// `ctx.layout` is the outward face only: selectPanel / beginNavigation /
		// toggleSidebar / openRightbar / closeRightbar. It exposes no read and no
		// arbitrary width setter, so `setSidebar(px)` and `setRightbar(px)` — and
		// reading `layoutInfo` — are not reachable through it.
		//
		// They ARE reachable through the slot registry. ui-layout seats its store
		// on its 'root' registration:
		//
		//     const handle = createLayoutStore();
		//     const instance = handle.create();          // the live instance
		//     const store = { ...handle, create: () => instance };   // create() pinned
		//     ctx.slots.register({ name: "root", ..., store }, AppFrame);
		//
		// `ctx.slots.entries(key)` is public, returns the registry's live
		// `StoredEntry` objects, and each carries `.store` — the very object handed
		// to `register`. Because ui-layout spread the handle and *overrode* `create`
		// to return that one captured instance, `entry.store.create()` hands back
		// the real store the frame is rendering, not a fresh copy.
		//
		// The handle is identified structurally rather than by name: probe
		// `create()` for a snapshot whose shape is `{ panelInfo.activePanelId,
		// layoutInfo }`. A fresh un-pinned instance still matches the shape, so the
		// probe also verifies the pinned-instance property: two `create()` calls
		// that return the same object prove `create` was overridden, which is what
		// makes mutating it affect the live frame. If a future ui-layout drops that
		// override, the probe fails, the plugin reports the limitation once, and
		// everything else keeps working.

		/**
		 * Resolve the live root layout store from the slot registry.
		 * @param ctx - the client context.
		 * @returns `{ instance }` on success, or `{ degraded: reason }` when the
		 *   store cannot be reached or is not the live, pinned instance.
		 */
		function resolveLayoutStore(ctx) {
			let entries;
			try {
				const slots = ctx.get !== void 0 ? ctx.get("slots") : void 0;
				if (slots === void 0 || typeof slots.entries !== "function") return { degraded: "the slots service (or its entries()) is unavailable" };
				entries = slots.entries("root");
			} catch {
				return { degraded: "the 'root' slot could not be read" };
			}
			if (!Array.isArray(entries) && typeof entries?.[Symbol.iterator] !== "function") {
				return { degraded: "the 'root' slot returned no entry list" };
			}
			for (const entry of entries) {
				const candidate = isObject(entry) ? entry.store : void 0;
				if (!isObject(candidate) || typeof candidate.create !== "function") continue;
				try {
					const first = candidate.create();
					const second = candidate.create();
					if (!isLayoutInstance(first) || first !== second) continue;
					if (typeof first.actions?.setSidebar !== "function") continue;
					return { instance: first };
				} catch {
					continue;
				}
			}
			return { degraded: "no pinned layout store was found on the 'root' slot" };
		}

		/** Structural test for the layout store instance face. */
		function isLayoutInstance(instance) {
			if (!isObject(instance) || typeof instance.getSnapshot !== "function" || typeof instance.subscribe !== "function") return false;
			try {
				const snapshot = instance.getSnapshot();
				return isObject(snapshot) && isObject(snapshot.layoutInfo) && isObject(snapshot.panelInfo) && LAYOUT_STORE_PROBE in snapshot.panelInfo;
			} catch {
				return false;
			}
		}

		// ---------------------------------------------------------------------
		// Plugin
		// ---------------------------------------------------------------------

		/**
		 * Client plugin body.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			// Fail-soft logging: at most one console.warn per activation, no matter
			// how many degrade paths are hit. Diagnostics must never become noise.
			let warned = false;
			const warn = (message) => {
				if (warned) return;
				warned = true;
				try {
					console.warn(`dsh-view-state: ${message}`);
				} catch {
					/* a console we cannot use is not an error */
				}
			};

			// The whole body runs inside one Cordis effect, so every listener and
			// timer this plugin installs is collected when the plugin unloads.
			ctx.effect(() => {
				try {
					// `run` returns its own teardown (session-list subscription and any
					// pending retry timer); handing it back keeps unload exact.
					return run(ctx, warn);
				} catch (error) {
					// Absolute backstop: a failure here must leave the page untouched.
					warn(`disabled (${error instanceof Error ? error.message : String(error)})`);
					return () => {};
				}
			}, "dsh-view-state: URL view-state mirror");
		}

		/**
		 * Wire the mirror and apply the incoming state once.
		 * @param ctx - client root context.
		 * @param warn - the one-shot warning sink.
		 */
		function run(ctx, warn) {
			// --- optional services (never hard dependencies: a missing service
			// must not hold this plugin in `waiting`, because writing the URL is
			// still useful without it) ---
			const sessions = safeGet(ctx, "sessions");
			// `ctx.layout` is deliberately not read: it exposes no way to read
			// `layoutInfo` and no arbitrary width setter, so it cannot help. See
			// resolveLayoutStore() for where the real store is reached instead.

			// --- what the page is asking for ---
			const search = hasLocation() ? window.location.search : "";
			const fromUrl = readOwnedParams(search);

			// URL wins over localStorage; localStorage fills the gaps the URL left.
			const stored = readStorage();
			const wanted = {
				session: normalizeSessionId(fromUrl.session) ?? stored?.session ?? null,
				sidebar: fromUrl.sidebar !== null
					? parseWidth(fromUrl.sidebar, SIDEBAR_MAX)
					: stored?.sidebar ?? null,
				rightbar: fromUrl.rightbar !== null
					? parseWidth(fromUrl.rightbar, Number.MAX_SAFE_INTEGER)
					: stored?.rightbar ?? null,
			};

			// Resolved exactly once: the probe calls `create()` on each 'root' entry,
			// so it is not something to repeat on every state change.
			const resolved = resolveLayoutStore(ctx);
			const instance = resolved.instance === void 0 ? null : resolved.instance;
			if (instance === null && (wanted.sidebar !== null || wanted.rightbar !== null)) {
				// Degraded: widths cannot be restored, but nothing else breaks. The
				// URL and localStorage channels keep working in both directions.
				warn(`panel widths cannot be restored (${resolved.degraded}); URL and localStorage mirroring continue`);
			}

			// --- restore ---
			const restored = restoreSession(ctx, sessions, wanted.session, warn);
			restoreLayout(instance, wanted);

			// --- mirror: live state -> URL + localStorage ---
			// Three session states, deliberately distinguished:
			//   string    -> a session is selected; write it
			//   null      -> a session is known NOT to be selected (or the wanted id
			//                was proven unknown); remove the parameter
			//   undefined -> nothing is known yet; leave the parameter alone
			const state = { session: restored.session, sidebar: wanted.sidebar, rightbar: wanted.rightbar };

			const mirror = () => {
				try {
					const current = readState(sessions, instance);
					state.sidebar = current.sidebar;
					state.rightbar = current.rightbar;
					// A proven-unknown id stays dropped: never let a stale read put it
					// back just because the app happens to still have it selected.
					if (state.session !== null && current.session !== void 0) state.session = current.session;
					writeStorage(state);
					mirrorUrl(state);
				} catch (error) {
					warn(`could not mirror state to the URL (${error instanceof Error ? error.message : String(error)})`);
				}
			};

			// Layout commits (drag, toggle, panel show/hide) — the width channel.
			let unsubscribeLayout = null;
			if (instance !== null) {
				try {
					const off = instance.subscribe(mirror);
					if (typeof off === "function") unsubscribeLayout = off;
				} catch { /* a store that refuses subscriptions just mirrors less often */ }
			}

			// Session selection: the list's `current` is the frontend's own source of
			// truth for it, so a change there (a user click, the app's restore, or
			// the open() above) republishes the session parameter.
			const publishSession = () => {
				const value = readSessionId(sessions);
				// `undefined` means the list could not be read; keep what we have.
				if (value !== void 0) state.session = value;
				mirror();
			};

			// Subscribed independently of the layout so that a layout-less boot still
			// captures session switches.
			const unsubscribeSessions = subscribeSessions(sessions, publishSession);

			// Publish the very first snapshot, so a boot that selected a session
			// without touching the URL still lands in localStorage.
			publishSession();

			return () => {
				for (const off of [unsubscribeSessions, unsubscribeLayout, restored.cancel]) {
					if (typeof off !== "function") continue;
					try {
						off();
					} catch {
						/* ignore */
					}
				}
			};
		}

		/** Read an optional service without throwing. */
		function safeGet(ctx, name) {
			try {
				return typeof ctx.get === "function" ? ctx.get(name) : void 0;
			} catch {
				return void 0;
			}
		}

		/** Coerce a URL/storage session value into a usable id or null. */
		function normalizeSessionId(value) {
			if (typeof value !== "string") return null;
			const trimmed = value.trim();
			return trimmed === "" ? null : trimmed;
		}

		/**
		 * Restore the selected session.
		 *
		 * The session list arrives asynchronously, so an id that is not in it yet
		 * is not necessarily unknown. We retry on an escalating schedule and, as
		 * soon as the list is non-empty without containing the id, conclude it is
		 * unknown and drop just that parameter (fail soft). The unwatched
		 * alternative — probing `open()` — is deliberately avoided: `open()` fails
		 * loud for ids outside the list, and a wrong guess there would be an error
		 * we caused.
		 * @param ctx - client root context.
		 * @param sessions - the sessions service, or undefined.
		 * @param target - the wanted session id, or null.
		 * @param warn - the one-shot warning sink.
		 * @returns `{ session, cancel }`: the session value the mirror should
		 *   publish (the target id; null when a selection is known to be absent;
		 *   `undefined` while nothing is known yet), and a `cancel` that stops the
		 *   watch and clears any pending retry timer.
		 */
		function restoreSession(ctx, sessions, target, warn) {
			if (target === null) return { session: null, cancel: () => {} };
			if (sessions === void 0 || isObject(sessions.list) === false || typeof sessions.list.getSnapshot !== "function") {
				warn("the sessions service is unavailable; only the URL and localStorage copies are maintained");
				return { session: void 0, cancel: () => {} };
			}

			// What the mirror should publish for the session parameter.
			// `undefined` = wait for the list; null = drop the parameter.
			let resolved = void 0;

			let attempt = 0;
			let done = false;
			let disposer = null;
			let timer = null;

			const stop = (value) => {
				resolved = value;
				done = true;
				if (disposer !== null) {
					try {
						disposer();
					} catch { /* ignore */ }
					disposer = null;
				}
				if (timer !== null) {
					try {
						clearTimeout(timer);
					} catch { /* ignore */ }
					timer = null;
				}
			};

			const evaluate = () => {
				if (done) return;
				let snapshot = null;
				try {
					snapshot = sessions.list.getSnapshot();
				} catch {
					snapshot = null;
				}
				const current = snapshot !== null && typeof snapshot.current === "string" ? snapshot.current : null;
				if (current === target) {
					// Already selected (by the app's own persisted selection, or by a
					// previous attempt). Nothing to do and nothing to announce.
					stop(target);
					return;
				}
				const listed = snapshot !== null && isObject(snapshot.byId) && Object.prototype.hasOwnProperty.call(snapshot.byId, target);
				if (listed) {
					// The parameter is authoritative on load: a deep link (or a saved
					// tab preset) exists precisely to override the app's own persisted
					// selection, so a different current session is not a reason to
					// decline. `current === target` is handled above as a pure no-op.
					try {
						sessions.open(target);
						stop(target);
					} catch (error) {
						warn(`session ${target} could not be opened (${error instanceof Error ? error.message : String(error)}); leaving the current view`);
						stop(null);
					}
					return;
				}
				const nonEmpty = snapshot !== null && isObject(snapshot.byId) && Object.keys(snapshot.byId).length > 0;
				if (nonEmpty) {
					// The list is authoritative and this id is not in it. Drop just
					// this parameter; everything else stays intact.
					warn(`unknown session id ${target}; ignoring ${P_SESSION}`);
					stop(null);
					return;
				}
				// The list has not loaded yet. Wait for the next change, or the clock.
				if (attempt >= SESSION_RETRY_DELAYS.length) {
					// Out of attempts: still unknown. Stop watching, and leave the
					// parameter alone rather than erasing a possibly-valid id.
					stop(void 0);
					return;
				}
				const delay = SESSION_RETRY_DELAYS[attempt];
				attempt += 1;
				if (delay === 0) {
					// Still synchronous at boot: let the list settle in a microtask
					// rather than blocking activation.
					Promise.resolve().then(evaluate);
					return;
				}
				if (typeof setTimeout === "function") timer = setTimeout(evaluate, delay);
			};

			try {
				if (typeof sessions.list.subscribe === "function") {
					disposer = sessions.list.subscribe(() => {
						evaluate();
					});
				}
			} catch {
				disposer = null;
			}
			evaluate();
			return { session: resolved, cancel: () => { stop(resolved); } };
		}

		/**
		 * Restore sidebar and right panel widths onto the already-resolved live store.
		 *
		 * Every branch is a no-op when the value already matches, so a restore that
		 * has nothing to do cannot look like a user interaction.
		 * @param instance - the live layout store, or null when degraded.
		 * @param wanted - the wanted triple.
		 */
		function restoreLayout(instance, wanted) {
			if (instance === null) return;

			// --- sidebar: `layoutInfo.sidebar` IS the width preference, 0 = collapsed ---
			if (wanted.sidebar !== null) {
				try {
					const before = readSidebar(instance);
					if (before !== null && before !== wanted.sidebar) {
						if (wanted.sidebar === COLLAPSED) {
							// setSidebar() clamps into [SIDEBAR_MIN, SIDEBAR_MAX], so it can
							// never produce the rail; toggleSidebar() is the only action
							// that yields 0.
							if (typeof instance.actions.toggleSidebar === "function") instance.actions.toggleSidebar();
						} else {
							// An expanded restore sets the exact px. (Only reachable from
							// storage/URL when the collapsed sidebar had no width to keep:
							// closing forgets the drag width by contract.)
							if (typeof instance.actions.setSidebar === "function") instance.actions.setSidebar(wanted.sidebar);
						}
					}
				} catch {
					/* a rejected width is not worth a warning of its own */
				}
			}

			// --- right panel: `layoutInfo.rightbar` is the saved width, null = never opened ---
			if (wanted.rightbar !== null && wanted.rightbar > 0) {
				try {
					if (typeof instance.actions.setRightbar === "function") instance.actions.setRightbar(wanted.rightbar);
				} catch {
					/* ignore */
				}
			}

			// Deliberately NOT restored here: whether the right panel is *shown*.
			// That fact belongs to ui-sidebar-right's per-session surface store, and
			// its seat pushes it back into the frame on every layout effect; writing
			// it from here would race the seat. See docs/API-NOTES.md.
		}

		/** Read the sidebar preference out of a layout instance, or null. */
		function readSidebar(instance) {
			try {
				const value = instance.getSnapshot()?.layoutInfo?.sidebar;
				return typeof value === "number" && Number.isFinite(value) ? value : null;
			} catch {
				return null;
			}
		}

		/**
		 * Subscribe to session selection changes, tolerating a missing service.
		 * @param sessions - the sessions service, or undefined.
		 * @param onChange - change callback.
		 * @returns an unsubscribe function (never throws).
		 */
		function subscribeSessions(sessions, onChange) {
			try {
				if (sessions === void 0 || isObject(sessions.list) === false || typeof sessions.list.subscribe !== "function") return () => {};
				const off = sessions.list.subscribe(() => {
					try {
						onChange();
					} catch { /* mirroring must never break the app's own notification path */ }
				});
				return typeof off === "function" ? off : () => {};
			} catch {
				return () => {};
			}
		}

		/**
		 * Read the session the page is actually showing.
		 *
		 * `ctx.sessions.list.getSnapshot().current` is the single source of truth
		 * for selection in this frontend — the layout store carries no session at
		 * all (its snapshot is exactly `{ panelInfo, layoutInfo }`), and
		 * ui-session's own scope adapter resolves the current binding from
		 * `sessions.list.getSnapshot().current` as well.
		 * @param sessions - the sessions service, or undefined.
		 * @returns the session id, or null when none is selected, or undefined when
		 *   the list cannot be read at all.
		 */
		function readSessionId(sessions) {
			if (sessions === void 0 || isObject(sessions.list) === false || typeof sessions.list.getSnapshot !== "function") return void 0;
			return readSessionCurrent(sessions);
		}

		/**
		 * Read `list.current`.
		 * @param sessions - the sessions service, or undefined.
		 * @returns the current id, or null when there is none / it cannot be read.
		 */
		function readSessionCurrent(sessions) {
			try {
				const value = sessions?.list?.getSnapshot?.()?.current;
				return typeof value === "string" && value !== "" ? value : null;
			} catch {
				return null;
			}
		}

		/**
		 * Read the live state for mirroring.
		 *
		 * When the layout store is unreachable the panel fields come back as null,
		 * meaning "no reading was taken" — the caller then leaves those parameters
		 * exactly as they are rather than inventing values. Session selection always
		 * comes from the sessions list, which is the frontend's own source of truth
		 * for it (the layout snapshot is exactly `{ panelInfo, layoutInfo }` and
		 * carries no session at all); its field is `undefined` when that list cannot
		 * be read, which tells the caller to keep whatever it already knew.
		 * @param sessions - the sessions service, or undefined.
		 * @param instance - the live layout store, or null.
		 * @returns the state to publish; `sidebar`/`rightbar` are null when unread.
		 */
		function readState(sessions, instance) {
			let sidebar = null;
			let rightbar = null;
			if (instance !== null) {
				try {
					const info = instance.getSnapshot()?.layoutInfo;
					if (isObject(info)) {
						if (typeof info.sidebar === "number" && Number.isFinite(info.sidebar)) sidebar = info.sidebar;
						// `rightbar` is the saved width; null means "never opened", which
						// the contract spells as 0.
						if (typeof info.rightbar === "number" && Number.isFinite(info.rightbar)) rightbar = info.rightbar;
						else if (info.rightbar === null) rightbar = COLLAPSED;
					}
				} catch {
					/* unread stays null */
				}
			}
			return {
				// `undefined` when the sessions list cannot be read at all, so the
				// caller keeps the session value it already has instead of dropping it.
				session: readSessionCurrent(sessions),
				sidebar,
				rightbar,
			};
		}

		/**
		 * Write state into the URL with `history.replaceState`, and only when the
		 * query string actually changed.
		 *
		 * Never `pushState`: a state mirror must not create history entries, and
		 * must not be reachable with the Back button. The pathname, the hash and
		 * every foreign parameter are preserved exactly.
		 * @param state - the state to publish.
		 */
		function mirrorUrl(state) {
			if (!hasLocation()) return;
			try {
				const current = window.location.search ?? "";
				const next = writeOwnedParams(current, {
					session: state.session,
					sidebar: state.sidebar,
					rightbar: state.rightbar,
				});
				if (next === current) return; // idempotent: no history churn, no wasted work
				if (typeof window.history?.replaceState !== "function") return;
				const path = `${window.location.pathname}${next}${window.location.hash ?? ""}`;
				window.history.replaceState(window.history.state ?? null, "", path);
			} catch (error) {
				// A refused replaceState (sandboxed frame, cross-origin oddity) is
				// non-fatal: localStorage still carries the state.
				void error;
			}
		}

		module.exports = {
			apply,
			// Service names resolved through Cordis's client context. Neither is a
			// hard dependency: `inject` is intentionally empty so the plugin never
			// sits in `waiting` (the URL channel is useful even with no services).
			inject: [],
		};
		return module.exports;
	},
});
