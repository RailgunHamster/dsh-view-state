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

/** Reset everything that describes a single boot. */
function resetPage({ pathname = "/", search = "", hash = "", clearStorage = true } = {}) {
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

/** A sessions service whose list snapshot is mutable from the test. */
function makeSessions(initial) {
	let snapshot = initial;
	const listeners = new Set();
	return {
		service: {
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
		},
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
 * Build a fake client context.
 *
 * Services are optional on purpose — the plugin must survive without any of
 * them, so the test constructs ctxs with arbitrary subsets.
 */
function fakeCtx({ sessions, layoutStore, layout = true, slots = true, get = true } = {}) {
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
	if (slots && layoutStore !== void 0) {
		ctx.services.set("slots", {
			entries: (key) => (key === "root" ? [{ options: {}, component: () => null, store: layoutStore }] : []),
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

/** Run one boot of apply() against a ctx. */
function boot(ctx) {
	pluginExports.apply(ctx);
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
	check(
		"late id: mirrored",
		lastReplace() === "/?dsh_sidebar=280&dsh_rightbar=0&dsh_session=session-late",
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
	check(
		"never-listed id: dropped from the URL",
		lastReplace() === "/?dsh_sidebar=280&dsh_rightbar=0&dsh_session=session-other",
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
	// With no layout store there is no reading to take, so the panel parameters
	// are left exactly as they were rather than being overwritten with guesses;
	// the session parameter is dropped because no session can be selected.
	check(
		"no services: foreign params survive and panel params are left alone",
		lastReplace() === "/?token=xyz",
		`url = ${String(lastReplace())}`,
	);
	check("no services: token preserved", lastReplace() !== null && lastReplace().includes("token=xyz"));
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

// --- a slots service that throws, and a layout store that is not pinned ---
{
	resetPage({ search: "?dsh_sidebar=0&dsh_rightbar=320" });
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
	check("throwing slots registry: apply() did not throw", threw === null, String(threw));
	check("throwing slots registry: degrades to a warning", page.warnings.length <= 1, `warnings = ${JSON.stringify(page.warnings)}`);
}

// --- a store whose create() does NOT return the same object (not pinned) ---
{
	resetPage({ search: "?dsh_sidebar=0" });
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
	check("un-pinned store: apply() did not throw", threw === null, String(threw));
	check("un-pinned store: probe rejected it (create() called twice to test)", freshCalls === 2, `create() calls = ${freshCalls}`);
	check("un-pinned store: width left unrestored and reported", page.warnings.length === 1, `warnings = ${JSON.stringify(page.warnings)}`);
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
