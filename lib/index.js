// dsh-view-state — node half (host plugin).
//
// This package contributes browser behaviour only: it mirrors the web UI's
// per-tab view state into query parameters (`lib/client.js`, served from
// `exports["./client"]` and picked up by `@deepseek-ai/dsh-client-modules`
// through the `dsh.client` declaration in package.json).
//
// A host half is still required, and it is not optional. The bundle's
// `cordis.patch.yml` inserts one loader row whose `name` is this package, and
// the Loader imports the row's host entry (`main`, i.e. this file) to build the
// fiber; a package with no root export would fail that import and the row
// would never mount. This is the same shape the shipped browser-only plugins
// use — see `@deepseek-ai/dsh-client-ui-brand-official/lib/index.js`, whose
// host half is exactly this empty `apply` with the note "the empty apply gives
// Loader a host-side row while the browser half ships through
// `exports["./client"]`".
//
// So: no host-side service, no host-side state, nothing to clean up.

/**
 * Host plugin body. Provides no host-side behavior; the row exists so the
 * package's browser bundle has a Loader entry to ride on.
 */
function apply() {}

export { apply };
