/**
 * account-balance — HOST half of the installed bundle.
 *
 * The Host half registers nothing on purpose, and that is a design fact rather
 * than a stub. Every figure the widget shows already has a Host owner, and the
 * one piece that has none is presentation state:
 *
 *   - **The balance** is a Host operation. The shipped
 *     `@deepseek-ai/dsh-api-account-controller` exposes the authenticated
 *     `account` Remote namespace (`getBalance`, `watch`, ...) over
 *     `ctx.deepseekAccount`, and it is the only path that may obtain the
 *     Platform request credential ("only Host consumers can obtain a request
 *     credential"). Re-implementing that against the DeepSeek API
 *     (`GET /user/balance` with `DEEPSEEK_API_KEY`) would duplicate an
 *     authorization decision the Harness already owns and would read a second,
 *     differently-scoped credential.
 *
 *   - **The conversation's token total** is the shipped `tokenUsage` session
 *     projection, registered by `@deepseek-ai/dsh-token-meter`. It already folds
 *     every settled Assistant attempt into four disjoint buckets, replaces a
 *     repeated `(turn, step)` sample instead of double-counting it, and closes
 *     the replacement slot on `llm/retry-started` so a retry counts once.
 *     Registering a second unit here would create a second definition of the
 *     same number that could drift from the shipped one the built-in `stats`
 *     pills display.
 *
 *   - **The running flag** is the Session status store's own `running`, the same
 *     live boolean the shipped Agent-Team panel reads for member activity.
 *
 *   - **The accumulated running time and the display preferences** are the only
 *     genuinely plugin-owned state, and both are presentation state, so they
 *     live in the browser's own `localStorage`. That is the choice the sibling
 *     `theme-studio` bundle makes for the same reason: it keeps this bundle free
 *     of a Host storage dependency. The alternative — the official settings
 *     path, a Host `Config` in a settings namespace plus `ctx.configForms` on
 *     the Client (what `ui-conversation` does for its Composer Enter
 *     preference) — needs a schema built with `@deepseek-ai/schemastery`, which
 *     a profile-installed bundle cannot resolve, and would make every edit here
 *     require a Harness restart instead of a page refresh.
 *
 * The row still has to exist: a bundle's patch inserts a plugin entry, and the
 * Loader resolves that entry's package, so the package must export a plugin.
 * See `client.js` for everything the user actually sees.
 */

export const name = 'account-balance'

/** No Host capability is required; the Client half does the work. */
export function apply() {}
