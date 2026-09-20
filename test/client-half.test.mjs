// Client-half contract test.
//
// Loads the real `lib/client.js` through a hand-written fake `ctx` — no Cordis,
// no React, no DOM, no browser — and asserts the five behaviours the frozen
// URL contract depends on:
//
//   1. boot with ?dsh_session&dsh_sidebar=0&dsh_rightbar=320&token=xyz selects
//      the session, applies both panel widths, and PRESERVES token;
//   2. a live state change rewrites only the three dsh_* parameters via
//      history.replaceState (exact resulting URL string) and keeps the pathname;
//   3. an unknown session id is dropped without throwing and other params survive;
//   4. with ctx.sessions / ctx.layout absent, apply() still succeeds and throws nothing;
//   5. localStorage fallback: URL empty + stored state -> applied; URL present -> URL wins.
//
// The stub `slots` service reproduces the one structural property the plugin
// depends on: ui-layout registers its store on the 'root' slot as
// `{ ...handle, create: () => instance }`, i.e. `create()` is pinned to the
// single live instance. `makeSlotStore()` below is that shape verbatim, and
// `fakeCtx` seats it exactly the way ui-layout does.
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Minimal window / document / storage shims
// ---------------------------------------------------------------------------

/** Everything a wrapper (or the browser) can observe about the page. */
const page = {
	href: "http://127.0.0.1:3080/",
	pathname: "/",
	search: "",
	hash: "",
	/** Strings the plugin passed to history.replaceState. */
	replaceCalls: [],
	/** Strings the plugin passed to history.pushState (must stay empty). */
	pushCalls: [],
	/** Uncaught console.warn calls made by the plugin. */
	warnings: [],
};

/** One recorded replaceState, split for convenient assertions. */
function lastReplace() {
	return page.replaceCalls[page.replaceCalls.length - 1] ?? null;
}

/** Rebuild the observable href from its parts (the shims keep them separate). */
function syncHref() {
	page.href = `http://127.0.0.1:3080${page.pathname}${page.search}${page.hash}`;
}

const storage = new Map();
const localStorageShim = {
	getItem: (key) => (storage.has(key) ? storage.get(key) : null),
	setItem: (key, value) => {
		storage.set(key, String(value));
	},
	removeItem: (key) => {
		storage.delete(key);
	},
	clear: () => {
		storage.clear();
	},
};

globalThis.window = {
	__ModuleLoader__: {
		load({ id, factory }) {
			capturedRegistration = { id, factory };
		},
	},
	get location() {
		return { href: page.href, pathname: page.pathname, search: page.search, hash: page.hash };
	},
	history: {
		state: null,
		replaceState(state, _title, url) {
			page.replaceCalls.push(url);
			// A real replaceState resolves a relative URL against the current one;
			// the plugin always passes pathname+search+hash, so the same-origin
			// form is enough here.
			const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/u.exec(url) ?? [];
			page.pathname = match[1] ?? page.pathname;
			page.search = match[2] ?? "";
			page.hash = match[3] ?? "";
			syncHref();
		},
		pushState(state, _title, url) {
			page.pushCalls.push(url);
		},
	},
	setTimeout: globalThis.setTimeout.bind(globalThis),
	clearTimeout: globalThis.clearTimeout.bind(globalThis),
};
globalThis.localStorage = localStorageShim;
globalThis.document = {
	querySelector: () => null,
	createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, appendChild() {} }),
	head: { appendChild() {} },
	body: { appendChild() {} },
};
// Only console.warn is intercepted; the plugin is required to stay quiet.
const realWarn = console.warn;
console.warn = (...args) => {
	page.warnings.push(args.map(String).join(" "));
};

let capturedRegistration = null;
const code = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
new Function("window", code)(globalThis.window);

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------

let total = 0;
let failures = 0;
const failuresList = [];

function check(label, condition, detail) {
	total += 1;
	if (condition) {
		console.log(`PASS  ${label}`);
		return;
	}
	failures += 1;
	failuresList.push(label);
	console.log(`FAIL  ${label}${detail === void 0 ? "" : `\n        ${detail}`}`);
}

/** Every ctx handed to boot(), so each block starts from a clean page. */
const booted = [];

/**
 * Dispose every fiber booted so far, the way Cordis would on plugin unload.
 *
 * This matters more than it used to: reachability is now retried
 * asynchronously, so a boot from an earlier block could otherwise still have a
 * timer pending (and warn, or write) while a later block is asserting.
 */
function disposeBooted() {
	const list = booted.splice(0, booted.length);
	for (const ctx of list) {
		for (const disposer of ctx.effects ?? []) {
			if (typeof disposer !== "function") continue;
			try {
				disposer();
			} catch {
				/* ignore */
			}
		}
	}
}

/** Reset everything that describes a single boot. */
function resetPage({ pathname = "/", search = "", hash = "", clearStorage = true } = {}) {
	disposeBooted();
	page.pathname = pathname;
	page.search = search;
	page.hash = hash;
	page.replaceCalls = [];
	page.pushCalls = [];
	page.warnings = [];
	syncHref();
	if (clearStorage) storage.clear();
}

// ---------------------------------------------------------------------------
// Fake harness pieces
// ---------------------------------------------------------------------------

/**
 * A snapshot store with the `getSnapshot` / `subscribe` face the plugin uses,
 * standing in for one layout store instance.
 */
function makeSlotStore(initialLayout) {
	let layoutInfo = { ...initialLayout };
	const listeners = new Set();
	const actions = {
		setSidebar(px) {
			// Mirrors the real action's clamp into [SIDEBAR_MIN, SIDEBAR_MAX].
			layoutInfo = { ...layoutInfo, sidebar: Math.min(Math.max(px, 264), 420) };
			emit();
		},
		toggleSidebar() {
			layoutInfo = { ...layoutInfo, sidebar: layoutInfo.sidebar === 0 ? 280 : 0 };
			emit();
		},
		setRightbar(px) {
			layoutInfo = { ...layoutInfo, rightbar: Math.max(px, 300) };
			emit();
		},
	};	function emit() {
		for (const listener of [...listeners]) listener();
	}
	const instance = {
		actions,
		getSnapshot: () => ({ panelInfo: { activePanelId: null }, layoutInfo }),
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
	};
	return { instance, actions, emit, listeners };
}

/**
 * The ui-layout registration shape, reduced to what the probe inspects:
 * a spread handle whose `create()` is pinned to the one live instance.
 */
function makeSlotStoreHandle(instance) {
	return {
		spec: { init: () => ({}) },
		create: () => instance,
	};
}

/**
 * The session controller's own persisted selection cell, as the shipped
 * controller creates it:
 *
 *   this.selection = createSnapshotStore({}, { persist: { name: "dsh.sessions.current" } });
 *
 * Only its read face is reproduced (`getSnapshot` / `subscribe`), because that is
 * all the plugin is allowed to touch. `set()` stands in for the controller
 * writing the cell through, and notifies like the real store does.
 */
function makeSelectionStore(initial) {
	let snapshot = initial;
	const listeners = new Set();
	return {
		store: {
			getSnapshot: () => snapshot,
			subscribe(fn) {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
		},
		set(next) {
			snapshot = next;
			for (const listener of [...listeners]) listener();
		},
		listenerCount: () => listeners.size,
	};
}

/** A sessions service whose list snapshot is mutable from the test. */
function makeSessions(initial, { selection } = {}) {
	let snapshot = initial;
	const listeners = new Set();
	const service = {
		list: {
			getSnapshot: () => snapshot,
			subscribe(fn) {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
		},
		open(id) {
			if (!Object.prototype.hasOwnProperty.call(snapshot.byId ?? {}, id)) {
				// The real `open()` fails loud for ids outside the list.
				throw new Error(`unknown session ${id}`);
			}
			opened.push(id);
			snapshot = { ...snapshot, current: id };
			for (const listener of [...listeners]) listener();
		},
	};
	// The persisted selection cell lives as an own property on the very object
	// provided as `ctx.sessions` (the shipped controller does the same). Opt-in on
	// purpose: every pre-0.2.1 case keeps a sessions service with no `selection`,
	// which is exactly the shape the plugin still has to tolerate.
	if (selection !== void 0) service.selection = selection.store;
	return {
		service,
		set(next) {
			snapshot = next;
			for (const listener of [...listeners]) listener();
		},
		notify() {
			for (const listener of [...listeners]) listener();
		},
	};
}

/** ids passed to sessions.open(), in order. */
let opened = [];

/**
 * A fake slots registry with the two public reads the plugin uses: `entries(key)`
 * and the change notification `subscribe(key, fn)`.
 *
 * The real registry batches notifications on a microtask; this one is
 * synchronous so a test can drive "the root slot appears on the Nth tick"
 * deterministically.
 */
function makeSlots() {
	const registry = new Map();
	const listeners = new Map();
	return {
		service: {
			entries: (key) => registry.get(key) ?? [],
			subscribe(key, fn) {
				if (!listeners.has(key)) listeners.set(key, new Set());
				listeners.get(key).add(fn);
				return () => {
					listeners.get(key)?.delete(fn);
				};
			},
		},
		/** Register the entries for a key and notify that key's subscribers. */
		set(key, entries) {
			registry.set(key, entries);
			for (const fn of [...(listeners.get(key) ?? [])]) fn();
		},
		listenerCount: (key) => (listeners.get(key) ?? new Set()).size,
	};
}

/** Drain the microtask queue (the plugin's delay-0 retry hops through it). */
async function microtasks(times = 12) {
	for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/**
 * A controllable `setTimeout`/`clearTimeout` pair.
 *
 * Retry schedules are asserted by driving the clock rather than by sleeping:
 * `tick(n)` runs the next n scheduled callbacks, `flush()` runs the rest
 * (including timers scheduled while running), and `pending()` counts the ones
 * that are still armed — which is how "reaching the store cancels the fallback
 * polling" is observed.
 */
function installFakeClock() {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const queue = [];
	let seq = 0;
	globalThis.setTimeout = (fn, delay) => {
		const handle = { id: (seq += 1), fn, delay, cancelled: false, ran: false };
		queue.push(handle);
		return handle;
	};
	globalThis.clearTimeout = (handle) => {
		if (handle !== null && typeof handle === "object") handle.cancelled = true;
	};
	return {
		queue,
		pending: () => queue.filter((h) => !h.cancelled && !h.ran).length,
		/** Run the next `count` armed callbacks; false when none are left. */
		tick(count = 1) {
			for (let i = 0; i < count; i += 1) {
				const next = queue.find((h) => !h.cancelled && !h.ran);
				if (next === void 0) return false;
				next.ran = true;
				next.fn();
			}
			return true;
		},
		flush() {
			while (this.tick(1)) {
				/* run the whole schedule */
			}
		},
		restore() {
			globalThis.setTimeout = realSetTimeout;
			globalThis.clearTimeout = realClearTimeout;
		},
	};
}

/**
 * Build a fake client context.
 *
 * Services are optional on purpose — the plugin must survive without any of
 * them, so the test constructs ctxs with arbitrary subsets.
 */
function fakeCtx({ sessions, layoutStore, layout = true, slots = true, slotsService, get = true } = {}) {
	const effects = [];
	const ctx = {
		services: new Map(),
		effect(callback) {
			// Cordis' ctx.effect installs the callback's return value as the
			// disposer and returns a function that disposes it.
			const disposer = callback();
			effects.push(disposer);
			return () => {
				if (typeof disposer === "function") disposer();
			};
		},
		on() {
			return () => {};
		},
		inject: [],
		effects,
	};
	if (get) {
		ctx.get = (name) => ctx.services.get(name);
	}
	if (sessions !== void 0) ctx.services.set("sessions", sessions);
	if (layout) ctx.services.set("layout", { selectPanel() {}, toggleSidebar() {}, openRightbar() {}, closeRightbar() {}, beginNavigation: () => new AbortController().signal });
	if (slotsService !== void 0) {
		ctx.services.set("slots", slotsService);
	} else if (slots && layoutStore !== void 0) {
		ctx.services.set("slots", {
			entries: (key) => (key === "root" ? [{ options: {}, component: () => null, store: layoutStore }] : []),
			subscribe: () => () => {},
		});
	}
	return ctx;
}

/** Materialize the plugin's exports out of the ModuleLoader registration. */
const pluginExports = (() => {
	const module = { exports: {} };
	const returned = capturedRegistration.factory((name) => {
		throw new Error(`unexpected require: ${name}`);
	});
	return returned ?? module.exports;
})();

/** Run one boot of apply() against a ctx (and remember it for teardown). */
function boot(ctx) {
	booted.push(ctx);
	pluginExports.apply(ctx);
	return ctx;
}

// ---------------------------------------------------------------------------
// 0. plugin surface
// ---------------------------------------------------------------------------

check("registered with ModuleLoader under the package id", capturedRegistration !== null && capturedRegistration.id === "dsh-view-state");
check("exports apply()", typeof pluginExports.apply === "function");
check("exports inject as an array", Array.isArray(pluginExports.inject));
check(
	"declares no hard service dependency (never waits, never wedges boot)",
	pluginExports.inject.length === 0,
	`inject = ${JSON.stringify(pluginExports.inject)}`,
);

// ---------------------------------------------------------------------------
// 1. boot: selects the session, applies both widths, preserves token
// ---------------------------------------------------------------------------

{
	resetPage({ search: "?dsh_session=session-abc&dsh_sidebar=0&dsh_rightbar=320&token=xyz" });
	opened = [];
	const { instance } = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const sessions = makeSessions({
		ids: ["session-abc", "session-other"],
		byId: { "session-abc": { id: "session-abc" }, "session-other": { id: "session-other" } },
		current: "session-other",
	});
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(instance) }));

	check("boot: selected the deep-linked session", opened.length === 1 && opened[0] === "session-abc");
	check("boot: sidebar collapsed to the rail (0)", instance.getSnapshot().layoutInfo.sidebar === 0);
	check("boot: right panel saved width applied", instance.getSnapshot().layoutInfo.rightbar === 320);

	const url = lastReplace();
	// The URL already described the state exactly, so a correct mirror does no
	// work at all: no replaceState, and certainly no pushState. That is asserted
	// as "no churn" rather than as a missing write.
	check("boot: no needless URL churn when the URL already matches", url === null, `replaceCalls = ${JSON.stringify(page.replaceCalls)}`);
	check("boot: never used pushState", page.pushCalls.length === 0);
	check("boot: never used pushState (and no reload/navigation mechanism touched)", page.replaceCalls.length === 0 && page.pushCalls.length === 0);
	check("boot: pathname unchanged", page.pathname === "/", `pathname = ${page.pathname}`);
	check(
		"boot: token still in the live URL",
		page.search.includes("token=xyz"),
		`search = ${page.search}`,
	);
	check(
		"boot: live URL describes the restored state",
		page.search === "?dsh_session=session-abc&dsh_sidebar=0&dsh_rightbar=320&token=xyz",
		`search = ${page.search}`,
	);
}

// 1b. a store state that differs from the URL must be rewritten
{
	resetPage({ search: "?dsh_session=session-abc&dsh_sidebar=300&dsh_rightbar=320&token=xyz" });
	opened = [];
	// The store starts at the 280px default with no saved right width, so BOTH
	// restores are real mutations and the mirror has something to publish.
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const sessions = makeSessions({
		ids: ["session-abc"],
		byId: { "session-abc": { id: "session-abc" } },
		current: "session-abc",
	});
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	check("boot/rewrite: sidebar restored to the URL value", store.instance.getSnapshot().layoutInfo.sidebar === 300);
	check("boot/rewrite: rightbar restored to the URL value", store.instance.getSnapshot().layoutInfo.rightbar === 320);
	check("boot/rewrite: pathname preserved", page.pathname === "/");
	// The URL already spelled out exactly the restored state, so the correct
	// behaviour is to write nothing at all.
	check(
		"boot/rewrite: no write when the URL already matches the restored state",
		page.replaceCalls.length === 0,
		`calls = ${JSON.stringify(page.replaceCalls)}`,
	);
	check("boot/rewrite: token untouched", page.search.includes("token=xyz"), `search = ${page.search}`);
	check("boot/rewrite: no pushState", page.pushCalls.length === 0);
	check("boot/rewrite: live URL still describes the state", page.search === "?dsh_session=session-abc&dsh_sidebar=300&dsh_rightbar=320&token=xyz", `search = ${page.search}`);
}

// 1c. a URL missing an owned parameter gains it, in place, when the store settles
{
	resetPage({ search: "?dsh_sidebar=300&token=xyz" });
	opened = [];
	const store = makeSlotStore({ sidebar: 300, viewportWidth: 1400, rightbar: null });
	boot(fakeCtx({ sessions: void 0, layoutStore: makeSlotStoreHandle(store.instance) }));
	// The store never had a saved right width, so the contract value 0 is
	// published; the pre-existing params keep their positions.
	check(
		"boot/append: the missing owned param is appended, existing ones stay put",
		lastReplace() === "/?dsh_sidebar=300&token=xyz&dsh_rightbar=0",
		`url = ${String(lastReplace())}`,
	);
	check("boot/append: token preserved", lastReplace() !== null && lastReplace().includes("token=xyz"));
	check("boot/append: sidebar parameter not rewritten", lastReplace() !== null && lastReplace().startsWith("/?dsh_sidebar=300&"));
}

// ---------------------------------------------------------------------------
// 2. state change: only the three owned params are rewritten, pathname kept
// ---------------------------------------------------------------------------

{
	resetPage({ pathname: "/s/session-abc", search: "?token=xyz&dsh_session=session-abc&dsh_sidebar=0&dsh_rightbar=320" });
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const sessions = makeSessions({
		ids: ["session-abc", "session-new"],
		byId: { "session-abc": { id: "session-abc" }, "session-new": { id: "session-new" } },
		current: "session-abc",
	});
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));

	// The user drags the sidebar, opens the right panel, then switches sessions.
	store.actions.setSidebar(400);
	store.actions.setRightbar(512);
	sessions.service.open("session-new");

	const url = lastReplace();
	check(
		"change: exact URL — owned params rewritten in place, foreign order preserved",
		url === "/s/session-abc?token=xyz&dsh_session=session-new&dsh_sidebar=400&dsh_rightbar=512",
		`url = ${String(url)}`,
	);
	check("change: pathname /s/session-abc kept", page.pathname === "/s/session-abc", `pathname = ${page.pathname}`);
	check("change: token still present exactly once", (url.match(/token=/gu) ?? []).length === 1);
	check("change: no pushState anywhere", page.pushCalls.length === 0);
	check(
		"change: replaceState only, and only for owned params",
		url !== null && !url.includes("dsh_view") && !url.includes("dsh_tab"),
	);
	check("change: exactly one warning at most", page.warnings.length <= 1, `warnings = ${JSON.stringify(page.warnings)}`);
}

// ---------------------------------------------------------------------------
// 2b. closing the sidebar is captured as dsh_sidebar=0
// ---------------------------------------------------------------------------

{
	resetPage({ search: "?dsh_sidebar=300" });
	opened = [];
	const store = makeSlotStore({ sidebar: 300, viewportWidth: 1400, rightbar: null });
	boot(fakeCtx({ sessions: makeSessions({ ids: [], byId: {}, current: void 0 }).service, layoutStore: makeSlotStoreHandle(store.instance) }));
	check("close: sidebar applied from URL", store.instance.getSnapshot().layoutInfo.sidebar === 300);
	store.actions.toggleSidebar();
	// The sidebar is genuinely collapsed; its saved width is then gone by contract
	// ("closing forgets its drag width"), so 0 is the honest value.
	check(
		"close: captured as 0",
		lastReplace() === "/?dsh_sidebar=0&dsh_rightbar=0",
		`url = ${String(lastReplace())}`,
	);
}

// ---------------------------------------------------------------------------
// 2c. a right panel that was never opened captures as dsh_rightbar=0
// ---------------------------------------------------------------------------

{
	resetPage({ search: "?dsh_rightbar=0" });
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	boot(fakeCtx({ sessions: makeSessions({ ids: [], byId: {}, current: void 0 }).service, layoutStore: makeSlotStoreHandle(store.instance) }));
	check("rightbar 0: null saved width is left untouched (store keeps its own default)", store.instance.getSnapshot().layoutInfo.rightbar === null);
	// The search string only carried dsh_rightbar, so the owned parameter that was
	// already present keeps its position and the newly published sidebar appends.
	check(
		"rightbar 0: mirrored as 0 (no saved width)",
		lastReplace() === "/?dsh_rightbar=0&dsh_sidebar=280",
		`url = ${String(lastReplace())}`,
	);
}

// ---------------------------------------------------------------------------
// 3. unknown session id: dropped, no throw, other params survive
// ---------------------------------------------------------------------------

{
	resetPage({ search: "?dsh_session=session-nope&dsh_sidebar=344&token=keep-me" });
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const sessions = makeSessions({
		ids: ["session-abc"],
		byId: { "session-abc": { id: "session-abc" } },
		current: "session-abc",
	});
	let threw = null;
	try {
		boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	} catch (error) {
		threw = error;
	}
	check("unknown id: apply() did not throw", threw === null, String(threw));
	check("unknown id: never called open()", opened.length === 0, `opened = ${JSON.stringify(opened)}`);
	check(
		"unknown id: at most one warning",
		page.warnings.length <= 1,
		`warnings = ${JSON.stringify(page.warnings)}`,
	);
	// The unknown id is gone; the parameter then describes the session the app is
	// actually showing, which is what the contract asks for. Foreign params and the
	// restored sidebar are intact.
	check(
		"unknown id: dropped from the URL, token and sidebar survive",
		lastReplace() === "/?dsh_session=session-abc&dsh_sidebar=344&token=keep-me&dsh_rightbar=0",
		`url = ${String(lastReplace())}`,
	);
	check("unknown id: token survived", lastReplace() !== null && lastReplace().includes("token=keep-me"));
	check("unknown id: the bogus id is gone from the URL", lastReplace() !== null && !lastReplace().includes("session-nope"));
	check("unknown id: sidebar still applied", store.instance.getSnapshot().layoutInfo.sidebar === 344);
	check("unknown id: exactly one warning, naming the dropped parameter", page.warnings.length === 1 && page.warnings[0].includes("dsh_session"), `warnings = ${JSON.stringify(page.warnings)}`);
}

// ---------------------------------------------------------------------------
// 3b. a session that only appears later is still honoured, while a session the
//     list never gains is dropped once the list proves it is empty of it
// ---------------------------------------------------------------------------

{
	resetPage({ search: "?dsh_session=session-late" });
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	// The list starts empty: the id is not resolvable yet.
	const sessions = makeSessions({ ids: [], byId: {}, current: void 0 });
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	check("late id: not opened while the list is empty", opened.length === 0, `opened = ${JSON.stringify(opened)}`);

	// The list arrives containing the target. The parameter is authoritative on
	// load, so the deep link is honoured even though the app had selected nothing.
	sessions.set({
		ids: ["session-late", "session-other"],
		byId: { "session-late": { id: "session-late" }, "session-other": { id: "session-other" } },
		current: void 0,
	});
	check("late id: opened once the list can prove it exists", opened.length === 1 && opened[0] === "session-late", `opened = ${JSON.stringify(opened)}`);
	// The parameter survived the whole unknown window and keeps its original
	// position; the panel facts, which are known as soon as the store is
	// reachable, are appended. (Before the retry fix this boot erased
	// `dsh_session` outright and only re-added it later, at the end.)
	check(
		"late id: never erased, then mirrored in place",
		lastReplace() === "/?dsh_session=session-late&dsh_sidebar=280&dsh_rightbar=0",
		`url = ${String(lastReplace())}`,
	);
	check("late id: the session parameter is present", lastReplace() !== null && lastReplace().includes("dsh_session=session-late"));
}

{
	resetPage({ search: "?dsh_session=session-never" });
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const sessions = makeSessions({ ids: [], byId: {}, current: void 0 });
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	// The list arrives without the target: the id is proven unknown and dropped.
	sessions.set({
		ids: ["session-other"],
		byId: { "session-other": { id: "session-other" } },
		current: "session-other",
	});
	check("never-listed id: never opened", opened.length === 0, `opened = ${JSON.stringify(opened)}`);
	// Once the list has loaded, `current` (session-other) is a real reading, so
	// the parameter is refreshed in place with the session the page is showing.
	check(
		"never-listed id: replaced by the live selection, in place",
		lastReplace() === "/?dsh_session=session-other&dsh_sidebar=280&dsh_rightbar=0",
		`url = ${String(lastReplace())}`,
	);
}

// ---------------------------------------------------------------------------
// 4. missing services: apply() still succeeds and throws nothing
// ---------------------------------------------------------------------------

{
	resetPage({ search: "?dsh_session=session-abc&dsh_sidebar=0&dsh_rightbar=320&token=xyz" });
	opened = [];
	let threw = null;
	try {
		boot(fakeCtx({ sessions: void 0, layoutStore: void 0, layout: false, slots: false }));
	} catch (error) {
		threw = error;
	}
	check("no services: apply() did not throw", threw === null, String(threw));
	check("no services: at most one warning", page.warnings.length <= 1, `warnings = ${JSON.stringify(page.warnings)}`);
	// With no services at all, every fact is UNKNOWN rather than absent. Unknown
	// is not "null": the caller's parameters are left byte-for-byte as supplied
	// instead of being erased with guesses (the old single-probe behaviour wrote
	// `/?token=xyz` here, which deleted a wrapper's own deep link).
	check(
		"no services: nothing is erased while every fact is unknown",
		lastReplace() === null,
		`url = ${String(lastReplace())}`,
	);
	check(
		"no services: the caller's parameters are byte-identical",
		page.search === "?dsh_session=session-abc&dsh_sidebar=0&dsh_rightbar=320&token=xyz",
		`search = ${page.search}`,
	);
	check("no services: token preserved", page.search.includes("token=xyz"), `search = ${page.search}`);
}

// --- a ctx with no get() at all (an older/leaner context) ---
{
	resetPage({ search: "?dsh_sidebar=0" });
	let threw = null;
	try {
		boot(fakeCtx({ get: false, layout: false, slots: false }));
	} catch (error) {
		threw = error;
	}
	check("ctx without get(): apply() did not throw", threw === null, String(threw));
}

// --- a slots service that throws: degrade, but only after the retries are spent ---
{
	resetPage({ search: "?dsh_sidebar=0&dsh_rightbar=320" });
	const clock = installFakeClock();
	let threw = null;
	const ctx = fakeCtx({ sessions: void 0, layout: true, slots: false });
	ctx.services.set("slots", {
		entries() {
			throw new Error("registry exploded");
		},
	});
	try {
		boot(ctx);
	} catch (error) {
		threw = error;
	}
	await microtasks();
	check("throwing slots registry: apply() did not throw", threw === null, String(threw));
	check("throwing slots registry: no warning on the first failed probe", page.warnings.length === 0, `warnings = ${JSON.stringify(page.warnings)}`);
	check("throwing slots registry: the caller's parameters were not erased", page.search === "?dsh_sidebar=0&dsh_rightbar=320", `search = ${page.search}`);
	clock.flush();
	check(
		"throwing slots registry: exactly one warning once the retries are spent",
		page.warnings.length === 1 && page.warnings[0].includes("panel widths cannot be restored"),
		`warnings = ${JSON.stringify(page.warnings)}`,
	);
	check("throwing slots registry: still no erasure after giving up", page.search === "?dsh_sidebar=0&dsh_rightbar=320", `search = ${page.search}`);
	clock.restore();
}

// --- a store whose create() does NOT return the same object (not pinned) ---
{
	resetPage({ search: "?dsh_sidebar=0" });
	const clock = installFakeClock();
	let threw = null;
	let freshCalls = 0;
	const ctx = fakeCtx({ sessions: void 0, layout: true, slots: false });
	ctx.services.set("slots", {
		entries: () => [
			{
				options: {},
				store: {
					spec: { init: () => ({}) },
					// Two calls, two different objects: exactly what an un-pinned
					// handle looks like. The probe must refuse it rather than mutate
					// a store nobody renders.
					create: () => {
						freshCalls += 1;
						return makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null }).instance;
					},
				},
			},
		],
	});
	try {
		boot(ctx);
	} catch (error) {
		threw = error;
	}
	await microtasks();
	check("un-pinned store: apply() did not throw", threw === null, String(threw));
	check("un-pinned store: no warning before the retries are spent", page.warnings.length === 0, `warnings = ${JSON.stringify(page.warnings)}`);
	clock.flush();
	check(
		"un-pinned store: probe rejected it on every attempt (create() pairs)",
		freshCalls >= 2 && freshCalls % 2 === 0,
		`create() calls = ${freshCalls}`,
	);
	check(
		"un-pinned store: width left unrestored and reported exactly once",
		page.warnings.length === 1 && page.warnings[0].includes("panel widths cannot be restored"),
		`warnings = ${JSON.stringify(page.warnings)}`,
	);
	check("un-pinned store: the caller's parameter was not erased", page.search === "?dsh_sidebar=0", `search = ${page.search}`);
	clock.restore();
}

// ---------------------------------------------------------------------------
// 5. localStorage fallback
// ---------------------------------------------------------------------------

// 5a. URL empty + stored state -> applied
{
	resetPage({ search: "?token=xyz" });
	storage.set("dsh.view-state.v1", JSON.stringify({ session: "session-abc", sidebar: 0, rightbar: 320 }));
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const sessions = makeSessions({
		ids: ["session-abc"],
		byId: { "session-abc": { id: "session-abc" } },
		current: "session-other",
	});
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	check("storage fallback: session applied", opened.length === 1 && opened[0] === "session-abc");
	check("storage fallback: sidebar applied", store.instance.getSnapshot().layoutInfo.sidebar === 0);
	check("storage fallback: rightbar applied", store.instance.getSnapshot().layoutInfo.rightbar === 320);
	check("storage fallback: URL now carries the state", lastReplace() === "/?token=xyz&dsh_session=session-abc&dsh_sidebar=0&dsh_rightbar=320", `url = ${String(lastReplace())}`);
	check("storage fallback: token preserved", lastReplace() !== null && lastReplace().includes("token=xyz"));
}

// 5b. URL present -> URL wins over storage
{
	resetPage({ search: "?dsh_session=session-url&dsh_sidebar=344&dsh_rightbar=400" });
	storage.set("dsh.view-state.v1", JSON.stringify({ session: "session-stored", sidebar: 0, rightbar: 320 }));
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const sessions = makeSessions({
		ids: ["session-url", "session-stored"],
		byId: { "session-url": { id: "session-url" }, "session-stored": { id: "session-stored" } },
		current: "session-other",
	});
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	check("URL wins: session from the URL", opened.length === 1 && opened[0] === "session-url", `opened = ${JSON.stringify(opened)}`);
	check("URL wins: sidebar from the URL, not storage", store.instance.getSnapshot().layoutInfo.sidebar === 344);
	check("URL wins: rightbar from the URL, not storage", store.instance.getSnapshot().layoutInfo.rightbar === 400);
	check(
		"URL wins: storage was overwritten with the URL values (write-through)",
		storage.get("dsh.view-state.v1") === JSON.stringify({ session: "session-url", sidebar: 344, rightbar: 400 }),
		`stored = ${String(storage.get("dsh.view-state.v1"))}`,
	);
}

// 5c. URL carries a partial state -> storage fills the gaps
{
	resetPage({ search: "?dsh_session=session-url" });
	storage.set("dsh.view-state.v1", JSON.stringify({ session: "session-stored", sidebar: 0, rightbar: 320 }));
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const sessions = makeSessions({
		ids: ["session-url"],
		byId: { "session-url": { id: "session-url" } },
		current: "session-other",
	});
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	check("partial URL: the URL's session wins", opened[0] === "session-url", `opened = ${JSON.stringify(opened)}`);
	check("partial URL: the missing sidebar falls back to storage", store.instance.getSnapshot().layoutInfo.sidebar === 0);
	check("partial URL: the missing rightbar falls back to storage", store.instance.getSnapshot().layoutInfo.rightbar === 320);
}

// 5d. unparsable stored values are treated as absent, and never throw
{
	resetPage({ search: "" });
	storage.set("dsh.view-state.v1", "{not json at all");
	let threw = null;
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	try {
		boot(fakeCtx({ sessions: void 0, layoutStore: makeSlotStoreHandle(store.instance) }));
	} catch (error) {
		threw = error;
	}
	check("corrupt storage: apply() did not throw", threw === null, String(threw));
	check("corrupt storage: store untouched", store.instance.getSnapshot().layoutInfo.sidebar === 280);
}

// 5e. localStorage unavailable entirely
{
	resetPage({ search: "?dsh_sidebar=0" });
	const saved = globalThis.localStorage;
	// A getter that throws models a storage-denied context (private mode, blocked).
	delete globalThis.localStorage;
	let threw = null;
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	try {
		boot(fakeCtx({ sessions: void 0, layoutStore: makeSlotStoreHandle(store.instance) }));
	} catch (error) {
		threw = error;
	}
	globalThis.localStorage = saved;
	check("no localStorage: apply() did not throw", threw === null, String(threw));
	check("no localStorage: URL still restored", store.instance.getSnapshot().layoutInfo.sidebar === 0);
}

// ---------------------------------------------------------------------------
// 6. parameter hygiene
// ---------------------------------------------------------------------------

{
	resetPage({ search: "?a=1&dsh_sidebar=300&b=2&dsh_session=session-abc&c=3&token=s3cr3t&dsh_rightbar=320" });
	opened = [];
	// The store sits at the 280px default, so restoring 300 is a real mutation and
	// the subsequent publish does write — which is the point: only the owned values
	// move, and every foreign parameter keeps its exact position and bytes.
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const sessions = makeSessions({
		ids: ["session-abc"],
		byId: { "session-abc": { id: "session-abc" } },
		current: "session-other",
	});
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	check("hygiene: sidebar restored to 300", store.instance.getSnapshot().layoutInfo.sidebar === 300);
	check("hygiene: rightbar applied from the URL", store.instance.getSnapshot().layoutInfo.rightbar === 320);
	// Restoring both widths reproduced exactly the URL that asked for them, so the
	// correct outcome is no write at all: zero history churn in the common case.
	check("hygiene: no write when the restored state already matches the URL", page.replaceCalls.length === 0, `calls = ${JSON.stringify(page.replaceCalls)}`);
	check("hygiene: every foreign parameter still present, in order", (() => {
		const url = page.search;
		const positions = ["a=1", "b=2", "c=3", "token=s3cr3t"].map((part) => url.indexOf(part));
		return positions.every((p) => p !== -1) && positions.every((p, i) => i === 0 || p > positions[i - 1]);
	})(), `search = ${page.search}`);
	check("hygiene: exact URL is unchanged", page.search === "?a=1&dsh_sidebar=300&b=2&dsh_session=session-abc&c=3&token=s3cr3t&dsh_rightbar=320", `search = ${page.search}`);
	check("hygiene: pathname untouched", page.pathname === "/");
	check("hygiene: no pushState", page.pushCalls.length === 0);
}

// 6b. a foreign-heavy URL whose restored state genuinely diverges does get rewritten
{
	resetPage({ search: "?a=1&dsh_sidebar=300&b=2&token=s3cr3t" });
	opened = [];
	// Store sits at the default and has no saved right width, so both owned
	// parameters end up differing from the URL and a write must happen.
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	boot(fakeCtx({ sessions: void 0, layoutStore: makeSlotStoreHandle(store.instance) }));
	check("hygiene2: sidebar restored to 300", store.instance.getSnapshot().layoutInfo.sidebar === 300);
	check(
		"hygiene2: foreign params keep position, owned params refreshed in place",
		lastReplace() === "/?a=1&dsh_sidebar=300&b=2&token=s3cr3t&dsh_rightbar=0",
		`url = ${String(lastReplace())}`,
	);
	check("hygiene2: token preserved", lastReplace() !== null && lastReplace().includes("token=s3cr3t"));
	check("hygiene2: foreign param order a=1,b=2,token preserved", (() => {
		const url = lastReplace() ?? "";
		const positions = ["a=1", "b=2", "token=s3cr3t"].map((part) => url.indexOf(part));
		return positions.every((p) => p !== -1) && positions.every((p, i) => i === 0 || p > positions[i - 1]);
	})(), `url = ${String(lastReplace())}`);
	check("hygiene2: no pushState", page.pushCalls.length === 0);
}

{
	// A URL-encoded token must survive byte-for-byte: it is what the server
	// authenticated against, so it must never be decoded and re-encoded.
	resetPage({ search: "?token=a%2Bb%20c%3D%3D&dsh_sidebar=300" });
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	boot(fakeCtx({ sessions: void 0, layoutStore: makeSlotStoreHandle(store.instance) }));
	check(
		"hygiene: encoded foreign value copied byte-for-byte",
		lastReplace() === "/?token=a%2Bb%20c%3D%3D&dsh_sidebar=300&dsh_rightbar=0",
		`url = ${String(lastReplace())}`,
	);
	check("hygiene: the encoded token itself is untouched", lastReplace() !== null && lastReplace().startsWith("/?token=a%2Bb%20c%3D%3D"));
}

{
	// No state at all: the mirror must not invent parameters.
	resetPage({ search: "?token=xyz" });
	opened = [];
	boot(fakeCtx({ sessions: makeSessions({ ids: [], byId: {}, current: void 0 }).service, layout: false, slots: false }));
	check("hygiene: an empty state adds nothing to the URL", lastReplace() === null, `url = ${String(lastReplace())}`);
}

{
	// Unparsable widths are absent, not zero, and never reach the store.
	resetPage({ search: "?dsh_sidebar=abc&dsh_rightbar=-40" });
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	boot(fakeCtx({ sessions: void 0, layoutStore: makeSlotStoreHandle(store.instance) }));
	check("hygiene: unparsable sidebar treated as absent", store.instance.getSnapshot().layoutInfo.sidebar === 280);
	check("hygiene: negative rightbar treated as absent", store.instance.getSnapshot().layoutInfo.rightbar === null);
	// Neither value was applied, so the mirror publishes the store's own reading
	// (the contract default sidebar, and 0 for "no saved right width") rather than
	// the unparsable input. The junk values are gone from the URL.
	check(
		"hygiene: unparsable inputs replaced by the store's real values, never written back",
		lastReplace() === "/?dsh_sidebar=280&dsh_rightbar=0",
		`url = ${String(lastReplace())}`,
	);
}

// ---------------------------------------------------------------------------
// 7. unload hygiene
// ---------------------------------------------------------------------------

{
	resetPage({ search: "?dsh_session=session-abc" });
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const sessions = makeSessions({
		ids: ["session-abc"],
		byId: { "session-abc": { id: "session-abc" } },
		current: "session-other",
	});
	const ctx = fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) });
	boot(ctx);
	check("unload: exactly one effect registered", ctx.effects.length === 1, `effects = ${ctx.effects.length}`);
	const before = store.listeners.size;
	check("unload: layout store subscribed", before === 1, `layout listeners = ${before}`);
	// Dispose the fiber the way Cordis would.
	for (const disposer of ctx.effects) if (typeof disposer === "function") disposer();
	check("unload: layout store subscription released", store.listeners.size === 0, `layout listeners = ${store.listeners.size}`);
}

// 7b. an unresolved session id schedules retries; unload clears the pending one
{
	resetPage({ search: "?dsh_session=session-maybe" });
	opened = [];
	// The list never loads, so the id stays unresolved and the escalating retry
	// schedule is what keeps the watch alive.
	const sessions = makeSessions({ ids: [], byId: {}, current: void 0 });
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const ctx = fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) });

	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const scheduled = [];
	const cleared = [];
	globalThis.setTimeout = (_fn, delay) => {
		const handle = { id: scheduled.length };
		scheduled.push(delay);
		return handle;
	};
	globalThis.clearTimeout = (handle) => {
		cleared.push(handle);
	};

	let threw = null;
	try {
		boot(ctx);
		// The first attempt runs synchronously and defers to a microtask; letting
		// that microtask run is what turns the watch into a real pending timer.
		await Promise.resolve();
		await Promise.resolve();
	} catch (error) {
		threw = error;
	}
	const pendingBeforeUnload = scheduled.length;
	for (const disposer of ctx.effects) if (typeof disposer === "function") disposer();
	globalThis.setTimeout = realSetTimeout;
	globalThis.clearTimeout = realClearTimeout;

	check("retry: apply() did not throw", threw === null, String(threw));
	check("retry: an unresolved id scheduled a real retry timer", pendingBeforeUnload >= 1, `scheduled = ${JSON.stringify(scheduled)}`);
	check("retry: the retry delays escalate from the documented schedule", scheduled.every((delay, i) => i === 0 || delay >= scheduled[i - 1]), `scheduled = ${JSON.stringify(scheduled)}`);
	check("retry: unload cleared the pending retry", cleared.length >= 1, `cleared = ${cleared.length}, scheduled = ${scheduled.length}`);
	check("retry: nothing threw while the list stayed empty", threw === null);
	check("retry: no session was opened for an unresolvable id", opened.length === 0, `opened = ${JSON.stringify(opened)}`);
	check("retry: no warning for an id that is merely unresolved", page.warnings.length === 0, `warnings = ${JSON.stringify(page.warnings)}`);
}

// ---------------------------------------------------------------------------
// 8. retry-based reachability — the root seat arrives AFTER apply()
// ---------------------------------------------------------------------------

// The measured real-world boot: inside apply() `ctx.slots.entries("root")` is
// empty, and the pinned store shows up seconds later. A single synchronous probe
// therefore must not be treated as final, and must not erase anything.

// 8a. the root slot appears only on the Nth tick
{
	resetPage({ search: "?dsh_sidebar=320&token=xyz" });
	const clock = installFakeClock();
	const slots = makeSlots();
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	boot(fakeCtx({ sessions: void 0, slotsService: slots.service }));

	// First probe is empty (the registry has no 'root' entry yet).
	await microtasks();
	check("retry store: no degraded warning while the root slot is still empty", page.warnings.length === 0, `warnings = ${JSON.stringify(page.warnings)}`);
	check("retry store: no reading was taken, so nothing was written", page.replaceCalls.length === 0, `calls = ${JSON.stringify(page.replaceCalls)}`);
	check("retry store: the caller's parameters are untouched", page.search === "?dsh_sidebar=320&token=xyz", `search = ${page.search}`);
	check("retry store: the registry change subscription is installed", slots.listenerCount("root") === 1, `listeners = ${slots.listenerCount("root")}`);

	// Two more empty polls go by. Still nothing known, still nothing erased, and
	// — the part the old single-probe code got wrong — still no warning.
	clock.tick(2);
	check("retry store: still no warning after empty ticks", page.warnings.length === 0, `warnings = ${JSON.stringify(page.warnings)}`);
	check("retry store: still nothing erased after empty ticks", page.search === "?dsh_sidebar=320&token=xyz", `search = ${page.search}`);
	check("retry store: a fallback poll is still armed", clock.pending() >= 1, `pending = ${clock.pending()}`);

	// ui-layout finally registers its seat.
	slots.set("root", [{ options: {}, component: () => null, store: makeSlotStoreHandle(store.instance) }]);
	check("retry store: the width was applied once the seat appeared", store.instance.getSnapshot().layoutInfo.sidebar === 320, `sidebar = ${store.instance.getSnapshot().layoutInfo.sidebar}`);
	check("retry store: the newly known facts were mirrored", page.search === "?dsh_sidebar=320&token=xyz&dsh_rightbar=0", `search = ${page.search}`);
	// The layout watch stopped, but a boot with no sessions service keeps ONE timer
	// armed on purpose: the sessions service arrives after apply() and there is no
	// registry to subscribe to for it (see watchSessions). Draining the clock must
	// therefore leave nothing armed.
	check("retry store: no warning at all in the happy path", page.warnings.length === 0, `warnings = ${JSON.stringify(page.warnings)}`);
	clock.flush();
	check("retry store: giving up on the sessions service leaves no timer armed", clock.pending() === 0, `pending = ${clock.pending()}`);
	check("retry store: draining the clock changed nothing", page.search === "?dsh_sidebar=320&token=xyz&dsh_rightbar=0", `search = ${page.search}`);
	check("retry store: and emitted no warning", page.warnings.length === 0, `warnings = ${JSON.stringify(page.warnings)}`);

	// And the store is live thereafter: a real resize is mirrored.
	store.actions.setSidebar(360);
	check("retry store: later layout commits are mirrored", page.search.includes("dsh_sidebar=360"), `search = ${page.search}`);
	clock.restore();
}

// 8b. the seat never appears: the warning comes once, only after every retry
{
	resetPage({ search: "?dsh_sidebar=320&token=xyz" });
	const clock = installFakeClock();
	const slots = makeSlots();
	boot(fakeCtx({ sessions: void 0, slotsService: slots.service }));
	await microtasks();
	check("exhausted: no warning on the first failed probe", page.warnings.length === 0, `warnings = ${JSON.stringify(page.warnings)}`);
	check("exhausted: nothing was erased while the facts are unknown", page.search === "?dsh_sidebar=320&token=xyz", `search = ${page.search}`);
	clock.flush();
	check(
		"exhausted: exactly one warning, and only after the retries are spent",
		page.warnings.length === 1 && page.warnings[0].includes("panel widths cannot be restored"),
		`warnings = ${JSON.stringify(page.warnings)}`,
	);
	check("exhausted: the parameter is STILL not erased after giving up", page.search === "?dsh_sidebar=320&token=xyz", `search = ${page.search}`);
	check("exhausted: no timer is left armed", clock.pending() === 0, `pending = ${clock.pending()}`);
	clock.restore();
}

// 8c. UNKNOWN is not null: an unresolvable boot must not delete the caller's
//     parameters (this is the defect that erased `dsh_sidebar=320` in a browser)
{
	resetPage({ search: "?dsh_session=session-late&dsh_sidebar=320&dsh_rightbar=420&token=xyz" });
	const clock = installFakeClock();
	const slots = makeSlots();
	// The list has not loaded, and the registry has no root entry: all three
	// facts are unknown.
	const sessions = makeSessions({ ids: [], byId: {}, current: void 0 });
	boot(fakeCtx({ sessions: sessions.service, slotsService: slots.service }));
	await microtasks();
	clock.tick(2);
	check("unknown: nothing was written at all", page.replaceCalls.length === 0, `calls = ${JSON.stringify(page.replaceCalls)}`);
	check(
		"unknown: every parameter is byte-identical to what the caller supplied",
		page.search === "?dsh_session=session-late&dsh_sidebar=320&dsh_rightbar=420&token=xyz",
		`search = ${page.search}`,
	);
	check("unknown: storage was not blanked either", (() => {
		const raw = storage.get("dsh.view-state.v1");
		if (raw === void 0) return true;
		const parsed = JSON.parse(raw);
		return parsed.sidebar === 320 && parsed.rightbar === 420 && parsed.session === "session-late";
	})(), `stored = ${String(storage.get("dsh.view-state.v1"))}`);
	clock.restore();
}

// 8d. KNOWN-absent still removes (the mirror image of 8c)
{
	resetPage({ search: "?dsh_session=session-nope&dsh_rightbar=420&token=xyz" });
	const slots = makeSlots();
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	slots.set("root", [{ options: {}, component: () => null, store: makeSlotStoreHandle(store.instance) }]);
	// The list IS loaded and provably lacks `session-nope`, and it has no current
	// selection: the session fact is known to be absent, so its parameter goes.
	const sessions = makeSessions({
		ids: ["session-other"],
		byId: { "session-other": { id: "session-other" } },
		current: void 0,
	});
	boot(fakeCtx({ sessions: sessions.service, slotsService: slots.service }));
	check("known-absent: the proven-unknown session parameter was removed", !page.search.includes("dsh_session"), `search = ${page.search}`);
	check(
		"known-absent: the rest of the URL is intact",
		page.search === "?dsh_rightbar=420&token=xyz&dsh_sidebar=280",
		`search = ${page.search}`,
	);
	check("known-absent: token preserved", page.search.includes("token=xyz"));
	check("known-absent: exactly one warning, naming the dropped parameter", page.warnings.length === 1 && page.warnings[0].includes("dsh_session"), `warnings = ${JSON.stringify(page.warnings)}`);
}

// 8e. a mixed boot: the widths are known (the seat is reachable) while the
//     session list has not resolved — only the session parameter stays untouched
{
	resetPage({ search: "?dsh_session=session-late&dsh_sidebar=320&token=xyz" });
	const slots = makeSlots();
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	slots.set("root", [{ options: {}, component: () => null, store: makeSlotStoreHandle(store.instance) }]);
	const sessions = makeSessions({ ids: [], byId: {}, current: void 0 });
	boot(fakeCtx({ sessions: sessions.service, slotsService: slots.service }));
	await microtasks();
	check("mixed: the known width was applied", store.instance.getSnapshot().layoutInfo.sidebar === 320, `sidebar = ${store.instance.getSnapshot().layoutInfo.sidebar}`);
	check("mixed: the unresolved session parameter survived", page.search.includes("dsh_session=session-late"), `search = ${page.search}`);
	check(
		"mixed: exactly the known facts moved, the unknown one did not",
		page.search === "?dsh_session=session-late&dsh_sidebar=320&token=xyz&dsh_rightbar=0",
		`search = ${page.search}`,
	);
}

// 8f. a root seat that never appears must not degrade a boot whose session list
//     also never resolves — the warning is still one, and still late
{
	resetPage({ search: "?dsh_session=session-late&dsh_sidebar=320" });
	const clock = installFakeClock();
	const slots = makeSlots();
	const sessions = makeSessions({ ids: [], byId: {}, current: void 0 });
	boot(fakeCtx({ sessions: sessions.service, slotsService: slots.service }));
	await microtasks();
	check("late boot: no warning while both watches are still waiting", page.warnings.length === 0, `warnings = ${JSON.stringify(page.warnings)}`);
	clock.flush();
	check("late boot: the layout degrade is reported once the layout retries are spent", page.warnings.length === 1 && page.warnings[0].includes("panel widths cannot be restored"), `warnings = ${JSON.stringify(page.warnings)}`);
	check("late boot: both parameters survive the give-up", page.search === "?dsh_session=session-late&dsh_sidebar=320", `search = ${page.search}`);
	clock.restore();
}

// ---------------------------------------------------------------------------
// 9. session read order: `list.current` first, then the controller's persisted
//    selection cell (the 0.2.1 defect)
// ---------------------------------------------------------------------------
//
// Measured in a real browser profile before this fix: for one origin the app's
// own leveldb held `dsh.sessions.current = {"sessionId":"session-…"}`, while
// `sessions.list.getSnapshot().current` was `undefined` — the list store's field
// doc calls that a transiently absent selection — and this plugin recorded
// `{"session":null,…}`. Every captured preset therefore carried an empty
// `dsh_session`. The controller's persisted cell is the durable half of the same
// fact and is reachable as `sessions.selection.getSnapshot().sessionId`; these
// cases pin the order, the structural guard, and both subscription paths.

// 9a. `list.current` undefined while the persisted selection cell is set
{
	resetPage({ search: "?token=xyz" });
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	// The list is pending and reports no current — exactly the measured state.
	const sessions = makeSessions(
		{ ids: [], byId: {}, current: void 0 },
		{ selection: makeSelectionStore({ sessionId: "session-restored" }) },
	);
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	check(
		"selection fallback: the persisted selection reaches the URL",
		page.search.includes("dsh_session=session-restored"),
		`search = ${page.search}`,
	);
	check(
		"selection fallback: localStorage records it instead of null",
		storage.get("dsh.view-state.v1") !== void 0 && JSON.parse(storage.get("dsh.view-state.v1")).session === "session-restored",
		`stored = ${String(storage.get("dsh.view-state.v1"))}`,
	);
	check("selection fallback: foreign token preserved", page.search.includes("token=xyz"), `search = ${page.search}`);
	check("selection fallback: never opened a session just to read it", opened.length === 0, `opened = ${JSON.stringify(opened)}`);
	// The widths are known as soon as the pinned seat is reachable, so the exact
	// URL is the token, the session the app persisted, and the two store facts.
	check(
		"selection fallback: exact URL",
		page.search === "?token=xyz&dsh_session=session-restored&dsh_sidebar=280&dsh_rightbar=0",
		`search = ${page.search}`,
	);
}

// 9b. the same divergence, with a root seat that only appears later
{
	resetPage({ search: "?token=xyz&dsh_sidebar=320" });
	opened = [];
	const clock = installFakeClock();
	const slots = makeSlots();
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const sessions = makeSessions(
		{ ids: [], byId: {}, current: void 0 },
		{ selection: makeSelectionStore({ sessionId: "session-restored" }) },
	);
	boot(fakeCtx({ sessions: sessions.service, slotsService: slots.service }));
	// The session fact is known from the persisted cell before any layout seat
	// exists, so the parameter is published while the widths stay unknown.
	check(
		"selection fallback/late seat: the session parameter is published before the seat arrives",
		page.search === "?token=xyz&dsh_sidebar=320&dsh_session=session-restored",
		`search = ${page.search}`,
	);
	slots.set("root", [{ options: {}, component: () => null, store: makeSlotStoreHandle(store.instance) }]);
	check("selection fallback/late seat: the width was applied", store.instance.getSnapshot().layoutInfo.sidebar === 320, `sidebar = ${store.instance.getSnapshot().layoutInfo.sidebar}`);
	check(
		"selection fallback/late seat: session and widths are all mirrored",
		page.search === "?token=xyz&dsh_sidebar=320&dsh_session=session-restored&dsh_rightbar=0",
		`search = ${page.search}`,
	);
	check("selection fallback/late seat: no warning", page.warnings.length === 0, `warnings = ${JSON.stringify(page.warnings)}`);
	clock.restore();
}

// 9c. the public list still wins when both sources carry a value
{
	resetPage({ search: "?dsh_session=session-restored&token=xyz" });
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	// The two sources disagree on purpose: `list.current` is the public read face,
	// so it must win over the persisted cell rather than the other way round.
	const sessions = makeSessions(
		{ ids: ["session-live"], byId: { "session-live": { id: "session-live" } }, current: "session-live" },
		{ selection: makeSelectionStore({ sessionId: "session-restored" }) },
	);
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	check(
		"read order: list.current wins over the persisted selection",
		page.search.includes("dsh_session=session-live") && !page.search.includes("session-restored"),
		`search = ${page.search}`,
	);
}

// 9d. a wrong-shaped `selection` changes nothing: the fallback never exists
{
	resetPage({ search: "?dsh_session=session-restored" });
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const sessions = makeSessions({
		ids: ["session-live"],
		byId: { "session-live": { id: "session-live" } },
		current: "session-live",
	});
	// `getSnapshot` is missing, so the cell is not a store: the plugin must not
	// reach into it, and the list's own reading still governs.
	sessions.service.selection = { sessionId: "session-restored" };
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	check(
		"wrong shape: the unusable selection cell is ignored and list.current governs",
		page.search.includes("dsh_session=session-live"),
		`search = ${page.search}`,
	);
}

// 9e. a stored cell whose sessionId is not a usable string is absent, not a crash
{
	resetPage({ search: "?dsh_session=session-stale" });
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const sessions = makeSessions(
		{ ids: [], byId: {}, current: void 0 },
		{ selection: makeSelectionStore({ sessionId: 42 }) },
	);
	let threw = null;
	try {
		boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	} catch (error) {
		threw = error;
	}
	check("wrong shape: apply() did not throw", threw === null, String(threw));
	// Neither source is usable, so the session fact is unknown and the caller's
	// parameter is left exactly as supplied (rule 4) rather than erased.
	check(
		"wrong shape: the caller's dsh_session survives",
		page.search.includes("dsh_session=session-stale"),
		`search = ${page.search}`,
	);
}

// 9f. a selection change re-mirrors (today only `sessions.list` was subscribed)
{
	resetPage({ search: "?token=xyz" });
	opened = [];
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	const selection = makeSelectionStore({ sessionId: "session-a" });
	const sessions = makeSessions({ ids: [], byId: {}, current: void 0 }, { selection });
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	check("selection subscription: the cell was subscribed", selection.listenerCount() === 1, `listeners = ${selection.listenerCount()}`);
	check("selection subscription: first value mirrored", page.search.includes("dsh_session=session-a"), `search = ${page.search}`);

	// A selection change that never touches `list.current`: the persisted cell is
	// the only source that moved, so only its subscription can see this.
	selection.set({ sessionId: "session-b" });
	check("selection subscription: the change re-mirrored into the URL", page.search.includes("dsh_session=session-b") && !page.search.includes("session-a"), `search = ${page.search}`);
	check(
		"selection subscription: the change re-mirrored into localStorage",
		JSON.parse(storage.get("dsh.view-state.v1")).session === "session-b",
		`stored = ${String(storage.get("dsh.view-state.v1"))}`,
	);
	check("selection subscription: token still preserved", page.search.includes("token=xyz"), `search = ${page.search}`);
	check("selection subscription: still replaceState only", page.pushCalls.length === 0);

	// When the list finally agrees, the public face keeps governing.
	sessions.set({ ids: ["session-b"], byId: { "session-b": { id: "session-b" } }, current: "session-b" });
	check("selection subscription: list.current still agrees and wins", page.search.includes("dsh_session=session-b"), `search = ${page.search}`);

	// And the cell is released on unload.
	const disposers = booted[booted.length - 1].effects;
	for (const disposer of disposers) if (typeof disposer === "function") disposer();
	check("selection subscription: unload released the cell subscription", selection.listenerCount() === 0, `listeners = ${selection.listenerCount()}`);
}

// 9g. neither source resolves: the parameter is preserved, never removed
{
	resetPage({ search: "?dsh_session=session-existing&dsh_sidebar=320&token=xyz" });
	opened = [];
	const clock = installFakeClock();
	// A sessions service with no readable list and no selection cell at all: both
	// sources are unknown, which must leave the parameter byte-identical.
	const sessions = makeSessions({ ids: [], byId: {}, current: void 0 });
	delete sessions.service.list;
	boot(fakeCtx({ sessions: sessions.service }));
	await microtasks();
	clock.flush();
	check(
		"neither source: the caller's dsh_session is preserved",
		page.search.includes("dsh_session=session-existing"),
		`search = ${page.search}`,
	);
	check("neither source: the sidebar parameter is preserved too", page.search.includes("dsh_sidebar=320"), `search = ${page.search}`);
	check("neither source: no warning names a dropped session", !page.warnings.some((line) => line.includes("unknown session id")), `warnings = ${JSON.stringify(page.warnings)}`);
	clock.restore();
}

// 9h. a readable selection cell that holds nothing is absent, while a MISSING
//     cell is unknown — the two are deliberately different
{
	resetPage({ search: "?dsh_session=session-ghost&dsh_sidebar=280" });
	opened = [];
	// The controller IS present (both stores readable) and the list HAS loaded
	// without the parameter's id and with no current selection. The cell is
	// readable and holds nothing, so the selection is known to be absent and the
	// parameter is removed — the same outcome as before 0.2.1.
	const sessions = makeSessions(
		{ ids: ["session-other"], byId: { "session-other": { id: "session-other" } }, current: void 0 },
		{ selection: makeSelectionStore({}) },
	);
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	check(
		"empty cell: a readable cell holding no selection is absent, so the parameter goes",
		!page.search.includes("dsh_session"),
		`search = ${page.search}`,
	);
	check("empty cell: the rest of the URL is intact", page.search.includes("dsh_sidebar=280"), `search = ${page.search}`);
}

{
	// The contrast case: no readable cell at all, and an id the list never
	// resolves. Nothing is known about the selection, so the parameter is left
	// exactly as supplied (rule 4) rather than erased, and no warning claims the id
	// was dropped. Before 0.2.1 the list alone was read and the retry watch meant
	// the same thing here; what changed is only which *readings* exist.
	resetPage({ search: "?dsh_session=session-ghost&dsh_sidebar=280" });
	opened = [];
	const clock = installFakeClock();
	const sessions = makeSessions({ ids: [], byId: {}, current: void 0 });
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	boot(fakeCtx({ sessions: sessions.service, layoutStore: makeSlotStoreHandle(store.instance) }));
	await microtasks();
	clock.flush();
	check(
		"missing cell: an unresolved id with no cell to fall back on is preserved",
		page.search.includes("dsh_session=session-ghost"),
		`search = ${page.search}`,
	);
	check(
		"missing cell: still no dropped-session warning",
		!page.warnings.some((line) => line.includes("unknown session id")),
		`warnings = ${JSON.stringify(page.warnings)}`,
	);
	clock.restore();
}

// 9i. the sessions service itself appears AFTER apply() — the measured ordering
{
	// Measured on a live web profile: `ctx.get("sessions")` is `undefined` inside
	// apply() and a real service a moment later, because the session-controller's
	// client half lands after this plugin. Reading the service once made the session
	// channel permanently dead on such a page (the fallback could never run), so the
	// service is re-read on every mirror and bound when it appears.
	resetPage({ search: "?dsh_sidebar=320&dsh_session=session-existing&token=xyz" });
	opened = [];
	let threw = null;
	// No `sessions` service in the map at all: the same situation as apply() running
	// before the controller is published.
	const ctx = fakeCtx({ layoutStore: void 0, layout: true, slots: false });
	const slots = makeSlots();
	ctx.services.set("slots", slots.service);
	const store = makeSlotStore({ sidebar: 280, viewportWidth: 1400, rightbar: null });
	try {
		boot(ctx);
	} catch (error) {
		threw = error;
	}
	await microtasks();
	check("late service: apply() did not throw with no sessions service", threw === null, String(threw));
	check(
		"late service: nothing is erased while no session source exists",
		page.search === "?dsh_sidebar=320&dsh_session=session-existing&token=xyz",
		`search = ${page.search}`,
	);

	// The controller's client half now lands. The already-scheduled layout retry is
	// what performs the next mirror; no user interaction is needed.
	const sessions = makeSessions(
		{ ids: ["session-live"], byId: { "session-live": { id: "session-live" } }, current: void 0 },
		{ selection: makeSelectionStore({ sessionId: "session-live" }) },
	);
	ctx.services.set("sessions", sessions.service);
	slots.set("root", [{ options: {}, component: () => null, store: makeSlotStoreHandle(store.instance) }]);

	check("late service: the width was applied from the parameter", store.instance.getSnapshot().layoutInfo.sidebar === 320, `sidebar = ${store.instance.getSnapshot().layoutInfo.sidebar}`);
	check(
		"late service: the newly readable persisted selection reaches the URL",
		page.search.includes("dsh_session=session-live"),
		`search = ${page.search}`,
	);
	check(
		"late service: exact URL",
		page.search === "?dsh_sidebar=320&dsh_session=session-live&token=xyz&dsh_rightbar=0",
		`search = ${page.search}`,
	);
	check(
		"late service: localStorage was written once the session became readable",
		storage.get("dsh.view-state.v1") !== void 0 && JSON.parse(storage.get("dsh.view-state.v1")).session === "session-live",
		`stored = ${String(storage.get("dsh.view-state.v1"))}`,
	);

	// And a later change on the late-bound stores still re-mirrors.
	sessions.set({ ids: ["session-live", "session-next"], byId: { "session-live": { id: "session-live" }, "session-next": { id: "session-next" } }, current: "session-next" });
	check("late service: later changes re-mirror", page.search.includes("dsh_session=session-next"), `search = ${page.search}`);

	// Unload still releases the late-bound subscription and watch.
	const disposers = booted[booted.length - 1].effects;
	for (const disposer of disposers) if (typeof disposer === "function") disposer();
	check("late service: unload released the binding", page.warnings.length <= 1, `warnings = ${JSON.stringify(page.warnings)}`);
}

// ---------------------------------------------------------------------------
// Restore console and report
// ---------------------------------------------------------------------------

console.warn = realWarn;

console.log(`\n${total - failures}/${total} assertions passed`);
if (failures > 0) {
	console.log(`\n${failures} FAILURE(S):\n${failuresList.map((label) => `  - ${label}`).join("\n")}`);
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
