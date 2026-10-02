# account-balance — a DSH plugin: balance · tokens · time · tokens/sec · usage stats

**English** | [中文](README.zh.md)

> **What this is**: a client plugin (bundle form, MIT) for the **DSH Harness Web UI**. It needs a
> working Harness — it brings no data source of its own: all four figures are read from Harness's
> own balance API and token projections.

It shows four live figures in the **stats strip below the composer** (to the right of the built-in
token pill), and adds a **Settings → Account & stats** page with switches plus a usage ledger
(hourly / daily / monthly charts; total tokens, average tokens per second, average **output**
tokens per second, and cost per million and per ten million tokens; the hourly chart can be
narrowed to any one day and any sub-range).

<img width="484" alt="The status row under the composer: balance ¥5.42 · this chat 213.9M tok · 1h06m · 53.5K tok/s" src="https://github.com/user-attachments/assets/4285aa72-fb02-43f6-b146-4a1b78e07113" />

*The row itself, captured in the Chinese UI — the strip follows the Harness locale.*

```
⚡ 12.3K tok/s · 88%              Balance ¥1,234.56 · This chat 12.3K tok · 1m24s · 146 tok/s
└────── built-in stats (order 0) ─┘ └────────────── this plugin (order 10) ──────────────┘
```

The strip follows the Harness locale; the plugin ships English and Simplified Chinese dictionaries,
and the built-in part is drawn by Harness itself.

- **Balance** — available DeepSeek account funds (top-up + granted, summed per currency); click to refresh;
- **This chat** — this conversation's tokens: uncached input + cache read + cache write + output;
- **Running time** — counts while the conversation runs, pauses while it is idle;
- **Tokens per second** — token total ÷ running time.

**The installable artefact is [`plugin/`](plugin/README.md)** (install, settings page and
verification details live in that document; it is written in Chinese with an English quick start at
the top).

## Install

**Prerequisite**: you already use DSH Harness (Web UI). The plugin is meaningless without it — it
reads Harness's own balance endpoint and token projections and fetches nothing by itself.

1. Clone anywhere:

   ```
   git clone https://github.com/lwx071001/dsh-account-meter.git
   ```

2. Ask your agent to install `plugin/` from that directory as a bundle into the current profile —
   replace `target` with **your own clone path** (`plugin/` is the first level inside the repo root):

   ```
   plugin_manager  action: install_bundle  target: <your clone path>/plugin
   ```

   The installer handles the pnpm install, selects the package into `dsh.profile.bundles` and wires
   the patch row the bundle ships — do **not** hand-write the profile's `package.json` /
   `cordis.patch.yml`. The sidebar **Plugins** page does the same thing.

3. **Refresh the page (F5).** The stats strip below the composer gains the balance, this
   conversation's tokens, the running time and the rate; **Settings → Account & stats** gains the
   switches and the statistics page. The itemised checklist is in [`plugin/README.md`](plugin/README.md).

> **Note for this machine (not a general step)**: profile `desktop` here already has it installed,
> as a **link** install — edit `client.js`, refresh the page, done. No reinstall and no Harness
> restart. The client half registers at page boot from `window.__DSH_BOOT__`; a running page does
> not pick up new code by itself.

## Layout

| Path | What it is |
|---|---|
| [`plugin/`](plugin/README.md) | **The installable bundle**: `package.json` + `cordis.patch.yml` + `index.js` (host half) + `client.js` (browser half) + `icon.svg` + `locale/` |
| [`tools/check-bundle.mjs`](tools/check-bundle.mjs) | Offline self-test (592 assertions): `node tools/check-bundle.mjs` |
| [`tools/asar.mjs`](tools/asar.mjs) | A minimal reader for Electron's `app.asar` — how the shipped implementation and docs were read during research |

> **Four excerpt files stay local and are not published** (excluded by `.gitignore`):
> `account-controller-README.md`, `usage-projection.js`, `session-stats-projection.js`,
> `host-runner-README.md`. They are **excerpts** of the official account-controller docs and of two
> projection implementations that ship inside the Harness package, kept to check the token
> definitions and where the balance comes from. They are not this project's code, and shipping them
> in a public repo would be redistributing someone else's work — so they are not published. Every
> conclusion they supported is written out in this document, so nothing here depends on them.

## Key design decisions

### 1. All four figures come from sources Harness already has

| Figure | Source | Why not something else |
|---|---|---|
| Balance | `ctx.remote.account.getBalance(...)` → `@deepseek-ai/dsh-api-account-controller` → host `ctx.deepseekAccount` | The service doc says it plainly: *"only Host consumers can obtain a request credential"*. Calling the public [`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance/) with `DEEPSEEK_API_KEY` would invent a second authorization decision and drift away from the real login state after a key change or a sign-out |
| Token total | The shipped `tokenUsage` projection (`@deepseek-ai/dsh-token-meter`) | It already folds every assistant attempt into four **disjoint** buckets, replaces rather than accumulates at the same `(turn, step)`, and closes the replacement slot on `llm/retry-started` so a retry counts once. Folding it again would be a second definition of the same number |
| Running state | `useSessionStatus(state => state.get(sessionId)?.running)` | This is exactly what the installed Agent-Team panel uses to tell whether a member is active |
| Running time | A client-side stopwatch, started and stopped by `running` | See below |
| Output rate | `sessionStats`'s `decodeMs` / `decodeTokens` (the same projection key the installed chat panel reads) | Time-to-first-token and tool execution are in neither, so dividing them gives "how fast it wrote"; see §4 |

The four bucket names *are* the proof of disjointness: the input side is `uncachedInputTokens +
cacheReadTokens + cacheWriteTokens` (exactly what the built-in `StatsPills`'s `billedInputTokens()`
computes), and `reasoningTokens` is already inside `outputTokens`, so **total = the four added up**.

### 2. Why the timer is a stopwatch, not a sum of completed spans

The nearest ready-made data is `sessionStats`'s `llmMs` (`step/start → assistant/message`) and
`toolMs` (`tool/call → tool/result`). They accumulate **only when a boundary closes**, so:

- they cannot tick — a step that runs for 30 seconds moves neither number;
- **a cancelled step never lands at all** (the source comment says so outright: *A cancelled step
  assembles no message, so its partial stream time stays uncounted in every time figure*).

What was asked for is "count while the conversation runs, stop when it ends" — that means observing
the session's `running` directly, not approximating it with two counters that only record
successful spans.

(The same projection's `decodeMs` / `decodeTokens` are used after all — for the **output rate**,
see §4: there, "only successful spans" is exactly the property required. One property is a defect
for "how long has this run" and a precondition for "how fast did it write".)

### 3. The usage ledger: four columns, one window

The ledger is a three-level roll-up (hour / day / month) plus an all-time total, kept in
`localStorage`. Four decisions carry it:

**The first time a session is seen, it only establishes a baseline — nothing is credited.** This is
what makes the whole ledger valid. `tokenUsage` and `sessionStats` are both **cumulative over the
entire persisted log**; treating the first reading as "new" means that **the instant an old session
is opened, its whole history is recorded as "happening now"**. Money, meanwhile, can only come from
balance drops observed after installation — so the token column would cover history while the money
column covered the observation window.

That is not hypothetical. In one recorded case the panel showed **149,622,412** total tokens over
**51m59s** with **¥2.28** spent, giving **¥0.01 per million tokens** — two orders of magnitude below
any real price. The three columns were three different windows: tokens were **all of history** (I
checked the projections of 24 sessions on disk; their whole logs add up to 393,441,551 tokens, and
the 149.6M in the ledger was the subset that had been "seen for the first time"), the duration was
**the plugin's own stopwatch** (which only runs from first sight), and money was **the observed
balance decrease**. So "average tokens per second" and "cost per million tokens" were each one
window divided by another — self-consistent and meaningless, which is exactly the root cause of the
original "the money looks wrong" report.

All four columns now share one window: **usage observed since the ledger started recording**, and
the page says so in as many words.

**Incremental accounting.** The ledger remembers **how much has already been recorded** for each
session and credits only the delta to the current bucket. Without that memory, a page refresh would
record the whole conversation history again as "just now". The same memory is what makes a reset
safe: with it, no session's history can ever be recorded twice.

**When a reading drops, rebase rather than record a negative.** A session counter can fall back
after a fork or a projection reset, and keeping the old high-water mark would swallow all later
growth. So the **four counters rebase independently**: a token drop does not discard genuinely new
time in the same reading, and a decode-span drop does not eat the other three. **A missing reading
keeps the old value** rather than reading as 0 — treating "the projection has not published yet" as
"the decode span is zero" makes the next push re-record the entire span; likewise **a missing first
reading stores `null` (unknown), not 0**, otherwise the arrival of the projection would record the
whole history as new and put the freshly fixed bug straight back. A baseline (delta 0) **does not
create an empty bucket** either, or the chart would sprout a point saying "that hour cost 0".

**Money comes from the balance decrease.** Harness holds no price data (*no consumer reports spend
— so this is the absence of a fact, not a configurable rate*), so the plugin does not guess a unit
price: it watches the balance, records a **decrease** as spend, treats a **top-up** as a baseline
reset, and the **first reading as baseline only**. "Cost per million tokens" is therefore a
measured effective rate, and "per ten million" is the same figure scaled by ten.

**The key was bumped to `usage.v2`, and only two things are taken from the old document**: `seen`
(how much each session has already been recorded for) and the balance baseline; everything else is
zeroed. The discarded totals are not data but **the withdrawal of a measurement error** — and the
old document is left untouched at `usage.v1`. The reasoning matches "Clear statistics" exactly: a
reset needs `seen`, and `seen` is in the old document.

**Retention is unlimited, so key-shape validation is the only gate left.** Previously "keep only the
newest N" trimmed garbage as a side effect; now nothing is trimmed, and `BUCKET_PATTERN` validates
the shape of every key (`YYYY-MM-DDTHH` / `YYYY-MM-DD` / `YYYY-MM`) — a key that is read must be one
`bucketKey` could have written. All three shapes are zero-padded and fixed-width, so **string order
is time order**, and the chart and the date picker share one rule with no date parsing.

**The cost is a document that keeps growing, so the footprint has to be visible.** The bottom of the
settings page reports the measured footprint (bytes and entry counts for the ledger, the
running-time records, the legacy ledger and the display preferences, plus a total and a share of
quota). Three deliberate choices:

- **Measured, not book-kept**: every render enumerates `localStorage` directly. Only the storage
  itself knows how many per-session running-time keys exist; a derived count would drift from
  reality sooner or later — the two are written by different code at different times.
- **Charged the way the browser charges**: `(key length + value length) × 2`. `localStorage` stores
  UTF-16 and the quota is charged the same way; everything this plugin writes is ASCII, so "content
  bytes" is exactly half of it. The question being answered is "how far from the quota are we", so
  the quota's own unit is the right one.
- **A refused write takes over that row**: once the quota is full `setItem` throws, which used to be
  **swallowed silently** — the page kept accounting in memory and lost it all on refresh. That row
  now turns amber. This is the real end state of "unlimited retention", not a hypothetical one.

### 4. The output rate divides by output time only

"Average output tokens per second" is **not** divided by running time but by the **decode span the
provider itself timed**: the `sessionStats` projection measures `decodeMs` from the **first
streaming token** to message assembly, alongside the `decodeTokens` those steps reported.
Time-to-first-token (prefill), tool execution and any non-output token are in **neither**.

**Numerator and denominator must share a source.** Dividing `tokenUsage`'s output total by this span
would count tokens that were never timed; dividing this span's tokens by running time would make
the model pay for time it did not spend writing. Both figures therefore come from the `decodeMs` /
`decodeTokens` pair — the same projection key the installed chat panel reads.

This is not an invented definition: **the built-in `StatsPills` pill computes exactly this**
(`dsh-client-ui-chat/lib/client.js`: `stats.decodeTokens / (stats.decodeMs / 1e3)`, the same
`useProjection("sessionStats")`, the same slot prop). This plugin's figure is its **ledger-level
average**: across every recorded session rather than the current one.

### 5. The cache hit rate copies the official definition instead of inventing one

The built-in pill already defines it:

```js
// dsh-client-ui-chat/lib/client.js
const billedInputTokens = usage => usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
const cacheHitPercent = usage => formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage))
```

**Cache hits ÷ the prompt side**, and **output tokens are excluded**. Excluding output is mandatory:
the rate describes how much of the prompt was reused, and putting output in the denominator would
make it fall merely because the model wrote more. `tokenBuckets()`'s `input` field is exactly
`billedInputTokens`, and the ledger's added `inputTokens` / `cacheReadTokens` are that pair.

**A zero denominator returns null** ("no prompt to divide by") rather than a confident 0%.

**The display copies the rule that refuses to round up to 100%**: 99.6% shows as `99.6%`, and only a
perfect hit shows `100%`. "Almost everything hit" and "everything hit" are two different facts about
billing, and conflating them errs in the direction of **reporting a cache hit that did not happen**.

This pair was added later, so old `seen` records do not have it (they read as `null`, treated as
"not known yet" rather than 0). The cache-hit column therefore starts at the upgrade and is off by a
one-time amount against the token total, converging over time; to align them from the start, press
"Clear statistics" once — it keeps `seen` and the balance baseline, so it does not re-record history.

### 6. The hourly window belongs to the user

The hourly tab adds one more group of pickers: a date dropdown (only recorded days, newest first,
newest selected by default) and from / to hour dropdowns, drawing just that span of that day, with
**that span's own total** on the right. Both the date list and the span filter are pure functions
(`hourDays` / `hourRangeEntries`), so "what can be selected" and "what gets drawn once selected" are
both assertable.

Day and month deliberately have no pickers — they are overviews — and for the same reason the eight
summary rows below **always use the whole ledger**: narrowing the chart never silently rewrites the
numbers beneath it. An empty window says "no records in this span", not "no records yet", so the
reader is not sent looking for a counting bug.

### 7. The chart is hand-written SVG, with no charting library

A pure-JS bundle has no charting library available and should not add a dependency for this. The
geometry is a pure function, `chartGeometry`, so scaling is asserted rather than eyeballed: the
maximum lands exactly on the top edge, a single point is centred, **an all-zero series does not
divide by zero**, and the polyline point string is correct. Colours use theme tokens only, and every
data point carries a native `<title>` tooltip.

### 8. Why preferences and the ledger live in browser `localStorage`

The official path is: the host half declares `Config` with `@deepseek-ai/schemastery`, the client
reads and writes it through `ctx.configForms.get(namespace)`, and values land in the user settings
document (that is how `ui-conversation`'s "Composer Enter" works). This plugin does not use it:

- `@deepseek-ai/schemastery` lives inside `app.asar` and the profile's `node_modules/@deepseek-ai`
  is empty, so a pure-JS bundle cannot resolve it; `ctx.configForms` is not in the client Service
  directory either, so it could only be reached with a soft `ctx.get()`;
- the moment the host half has a real module, changing the browser half goes from "refresh the page"
  to "**restart Harness**".

So this state lives in browser `localStorage` — the same choice the `theme-studio` in this profile
made. The settings page **itself** is still registered at the official `settings.section`, so it
looks like every other settings page.

### 9. Why Remote + projections, not `host.call` or a hand-rolled HTTP route

| Channel | Verdict |
|---|---|
| The browser half's built-in `host.call(method, args)` | ❌ It belongs to **dynamic Cordis packages only**. `dsh-cordis-client-runner` says so: the browser half gets a fixed set of names — `React, console, styles, host` — supplied by the dynamic package runtime. A persistent bundle goes through `window.__ModuleLoader__` and does not get them |
| A host HTTP route (`ctx.webServer.register`) plus front-end `fetch` | ❌ Workable but redundant. The web carrier **is authenticated** (an unauthenticated request measurably returns `401`), so a hand-rolled route would either duplicate that authorization or bypass it |
| **A Remote namespace + the standard slot props** | ✅ This is exactly how official client plugins do it; `useProjection` / `useSessionStatus` are both standard props of the composer dock |

### 10. Liveness: three pushes and one poll

| Figure | Mechanism |
|---|---|
| Token total | Push (projection registry) |
| Running state | Push (session state store) |
| Running time | One tick per second while running; nothing while idle |
| Output rate | Push (`sessionStats` steps when a message is assembled) |
| Balance | Polling: 60s after success, 15s backoff after failure; also read immediately on becoming visible / gaining focus / on click; skipped while `document.hidden` |
| Ledger writes | Only when the ledger actually changed, and at most once per second (they depend on second-quantised values, not on a millisecond clock) |

### 11. Colour: one family, hierarchy from weight

Labels and separators use `--dsw-alias-label-tertiary`; **all four figures share**
`--dsw-alias-label-secondary` + `font-weight: 500`. State colours **apply to the balance cell only**
— an early version put the tone class on the root, so a failed balance read tinted the token figures
amber too. The class now comes from a pure function, `rowClasses(tone)`, locked down by an invariant
assertion. The dropdowns on the settings page (`.ab-select`) reuse the same border and radius tokens,
staying in the same family as the pill buttons.

**This row wears whatever its neighbour on the line wears.** The `dsh-liquid-glass` skin in this
profile wraps the row of figures below the composer in a glass capsule, and it picks its target **by
position** — `[data-slot='conversation.composer.dock'] > :first-child` — which matches the built-in
`stats`. That assumes the dock has exactly one occupant, and this plugin's registration is the
second, so it fell outside.

The plugin therefore **mirrors** that capsule under the same scope (`body[data-dsh-liquid-glass]`)
reading the same `--lg-*` variables: with the skin off the rule is inert and both rows stay plain,
with it on both capsules match, and a change to the skin's own blur / tint / radius moves both
together. Four declarations are deliberately **not** mirrored — `height` / `overflow` /
`text-overflow` / `white-space`: the skin uses them to truncate a line that cannot wrap, whereas
this row is built to **wrap its cells**, and clipping the tail off a balance would be worse than a
second line.

Duplicating declarations across plugins is bound to rot, so the self-test asserts that, whenever the
`liquid-glass` source sits next to this one, those 13 shared declarations are compared **one by
one** against the plugin's mirror. The root cause is in that plugin's selector (an "only one entry"
proxy); fixing it at the source is a one-character change, `> :first-child` → `> *`, after which
this mirror can be deleted — the mirror exists to avoid editing someone else's plugin, and to keep
that rule from affecting anything else that may register into this dock later.

**The context ring at the far right of the same line is the same story.** The shipped composer
renders it as a **sibling** of the dock anchor rather than an occupant, so a skin that looks for
occupants by position cannot reach it either. This plugin locates it by **sibling relation plus the
control's own role** (`~ * button[aria-haspopup]`), touching none of the hashed class names that
change on every build in the official module. It is the one capsule on that line that opens a panel,
so hover and expanded states are **given back explicitly** — otherwise this rule's higher
specificity would override the native hover fill and the feedback before a click would disappear.

### 12. The host half is empty, and that is a design conclusion

All four figures already have host owners, and the ledger and preferences are pure presentation
state. This plugin registers no Service, listens to no event, registers no projection and adds no
tool, so disabling the package leaves nothing to reclaim. The plugin row must still exist (the
bundle's patch inserts an entry and the Loader has to resolve the package), so `index.js` exports
the smallest possible plugin.

## Settings page

**Settings → Account & stats** (`settings.section`, `order: 13`, between Models at 10 and Plugins at
15):

- **Shown figures** — a master switch "Show the status row" plus four per-figure switches (balance /
  token total / running time / tokens per second); the per-figure switches are greyed out while the
  master switch is off;
- **Usage statistics** — hourly / daily / monthly tabs → the hourly window pickers (date + from /
  to) → the chart → eight summary rows (total tokens, recorded time, average tokens per second,
  average output tokens per second, average cache hit rate, total spend, cost per million tokens,
  cost per ten million tokens) → clear statistics (two-step confirmation that disarms itself after 4
  seconds);
- **Storage used** — measured size and entry count for the ledger / running-time records / legacy
  ledger / display preferences, plus a total and a share of quota; it turns into an amber warning
  once the quota is full.

<img width="620" alt="The eight summary rows: total tokens 384,301,631 · recorded time 2h21m · average 45.3K tok/s · average output 261 tok/s · cache hit 99.6% · spend ¥18.21 · per million tokens ¥0.04 · per ten million tokens ¥0.47" src="https://github.com/user-attachments/assets/1fa7a8e2-95d7-4c8f-9892-7d6abe30b2f5" />

*The eight summary rows, on real data.*

Changes take effect immediately — the status row and the settings page share one snapshot store.
Clearing keeps the "already recorded for each session" memory and the balance baseline, so it
restarts the count from now instead of re-recording the current conversation's history.

## Knobs

| Location | Constant | Default | Meaning |
|---|---|---|---|
| `plugin/client.js` | `REFRESH_MS` | `60000` | Poll interval after a successful balance read (ms) |
| `plugin/client.js` | `RETRY_MS` | `15000` | Retry interval after a failed balance read (ms) |
| `plugin/client.js` | `PERSIST_EVERY_TICKS` | `5` | Write the timer back every N seconds while running |
| `plugin/client.js` | `BUCKET_PATTERN` | three shapes | With trimming gone, the only thing keeping malformed keys out |
| `plugin/client.js` | `STORAGE_QUOTA_BYTES` | `5 MiB` | Quota estimate used for the share; not enforced, not used for accounting |
| `plugin/client.js` | `CHART_DOT_LIMIT` | `120` | Past this many points the hover dots are skipped (the polyline stays) |
| `plugin/client.js` | `DEFAULT_SETTINGS` | all on | Default visible figures |
| `plugin/client.js` | `CSS` | — | Colours and layout |

## Verification record

```
node tools/check-bundle.mjs     # 592 assertions, all passing
```

Thirteen layers: **execution** (including **whole-file compilation**, so a syntax error inside the
factory fails here), **manifest**, **money arithmetic**, **duration / rate / preferences**, **cache
hit rate**, **usage ledger**, **v1→v2 migration**, **storage footprint**, **balance-cell branches**,
**decode span**, **running-time records**, **hourly window**, **chart geometry**, **colour
invariants**, **dictionaries**, **render smoke**.

**Render smoke** was added last, because every assertion before it verified pure functions only —
and everything the user **sees** goes through a component, where a crash yields a blank page and the
offline assertions would not say a word. It captures the two registered components by applying the
plugin to a stub context, renders each once with a minimal React stand-in (`createElement` builds
the tree, hooks only read values and never run effects), then walks the text and asserts: both the
settings page and the status row render, the expected labels appear, **the expected figures
appear**, empty groups do not appear, and a missing optional hook prop degrades instead of throwing.

That layer **was verified to have teeth**: a single wrong `labels` key in `StorageSection`
immediately reports `the rendered settings page shows "统计台账"`, and asserting the entry count as 2
(the real value is 1 per group) fails just as fast.

These assertions caught twelve real defects during development: the money representation
contradicting itself between `parseMoney` (magnitude) and `addMoney` (sign); negative fractional
truncation disagreeing with the official formatter; the tone class on the root recolouring the
tokens when the balance failed; the dead-key scan missing ternary uses like `t(v ? 'on' : 'off')`;
the correspondence between settings-page row keys and `DEFAULT_SETTINGS` needing to be locked
explicitly; **no rebase when a session reading dropped**, which would leave the ledger frozen while
usage kept growing; conflating "reading missing" (the projection has not published) with "reading is
zero", which re-records the whole decode span on the next push; and **recording a session's entire
log as "just now" the first time it was seen**, which made the token column cover history and the
money column cover the observation window, putting `cost per million tokens` two orders of magnitude
too low.

The latest round caught four more, all of the "one state nobody handles" kind:

1. **The balance-cell decision chain ended in `else`, swallowing "signed in but no readable
   wallet"** (a wallet amount string that fails to parse is dropped, so `rows: []` is a real
   result). It fell through to the default branch and therefore **showed "Loading…" forever** — a
   label that would never resolve itself. That state is now named explicitly by the pure function
   `balanceCase`, and all six branches are assertable.
2. **Hooks passed in as props were called conditionally**: `useProjection` / `useSessionStatus` are
   hooks, and writing `typeof props.useX === 'function' ? props.useX(...) : ...` changes the hook
   count when the test flips, which makes React abort the render ("Rendered fewer hooks than
   expected") and empties the whole slot. Now there are **constant stand-ins and an unconditional
   call**, degrading as usual when the prop is missing.
3. **`compactRate` reused the count formatter in the 10–1000 band**: `compactTokens` maps an integer
   count straight through `String(v)`, which on a **quotient** renders `16.67` as
   `16.666666666666668 tok/s`. Every value the self-test used in that band happened to be a whole
   number, so it stayed hidden.
4. **The running time lost the span in progress on the way out, and could go backwards.** This one
   came from an **independent review** (below): `useRunningTime`'s interval cleanup only cleared the
   timer without writing back, leaving the write path to "one tick every 5 seconds" and "running
   flipped to false". Switching sessions, closing the tab or refreshing dropped the last span
   outright; and **while the tab is in the background `setInterval` is throttled by the browser to
   roughly once a minute**, so the loss could reach minutes. The symptom: the row shows `1m24s`, you
   switch away and back, and it reads `1m21s` — the timer walks backwards.

   Two fixes: the cleanup **computes from the stopwatch's state and writes that**, instead of reusing
   the number computed during the last render (minutes stale after background throttling), and
   `writeDuration` became a **high-water mark** that never goes back, so a queued tick cannot
   overwrite a newer value with an older, smaller one.

The first three came from my own review; the fourth from an **independent review** (the pure data
layer and the React layer were handed to two different perspectives). The independent review also
ran differential fuzzing — a BigInt reference implementation of `parseMoney` against 20,000 random
cases, 4,000 random ledger operations checking "total = sum of buckets", `normalizeLedger`
idempotence, and `hourDays` / `hourRangeEntries` against a reference — and **found no
counterexample**, while independently finding the same `balanceCase` problem in an earlier snapshot.

Live state (measured):

| Check | Result |
|---|---|
| `install_bundle` return | `application: "applied"`, `warnings: []` (first install) |
| Composition tree (`Config.listConfigs`, `name: "@local/account-balance"`) | `include:account-balance` is present |
| `Slots.listSubTree` `root: "conversation.composer.dock"` | `stats` (order 0) + `{ id: "account-balance", order: 10, active: true }` ✅ |
| `Slots.listSubTree` `root: "settings.section"` | contains `{ id: "account-balance", order: 13, active: true }`, exactly between Models (10) and Plugins (15) ✅ |
| Slot standard props | `conversation.composer.dock` declares `useProjection` and `useSessionStatus` itself — the two official channels this plugin reads through ✅ |
| Projection key availability | `@deepseek-ai/dsh-web-app/cordis.patch.yml` composes `session-stats`; the installed `dsh-client-ui-chat`'s `StatsPills` reads `useProjection("sessionStats")` in the same slot ✅ |

Both slots are registered in the **running page**, so the last refresh already brought the stats page
up. After this round's changes (ledger baseline + v2 migration) it needs **one more refresh**: the
browser half registers at page boot from `window.__DSH_BOOT__`, and a running page does not pick up
new code by itself. The host half and the manifest are untouched (this round changed only
`client.js`, `tools/check-bundle.mjs` and the two READMEs), so no Harness restart and no reinstall.

**The stats page will be empty after that refresh**: that is the v2 migration, not data loss — see
the migration note above.

**Not verified**: the rendering of the four figures, the timer behaviour, chart drawing, the hourly
window pickers, and the visual result of the colours. This session has no browser control, and the
web carrier is authenticated (an unauthenticated request returns 401, and hunting for the token is
not something to do), so this needs your eyes after a refresh.

## Known limitations

- The balance is a Platform wallet reading, **not** a bill derived from unit prices; every money
  figure comes from the actual balance decrease. A wallet amount that cannot be parsed is dropped, so
  "signed in but not one readable wallet" shows as **No readable balance** instead of sitting on
  "Loading…" forever.
- The token total is the provider's count (the sum of four disjoint buckets) and **excludes subagent
  / workflow** tokens.
- **The ledger only covers the span since this browser started recording**: if a conversation ran
  while the page was closed, that span's tokens and charge are not recorded. The totals and charts
  are therefore "observed", not "the whole bill". (The balance side does reconcile correctly: the
  baseline is persisted, so the first reading after reopening records the whole decrease that
  happened while away.)
- **A granted-credit expiry is recorded as spend.** Granted credit is a decrease with an unchanged
  currency, so the code does not reset the baseline; and the payload carries only
  `{currency, balance}` — no expiry date, no grant id — so **"expired" and "used up" cannot be told
  apart**. The only complete fix would be to count decreases of top-up wallets only, which would
  make any period funded by granted credit read as ¥0 — neither is perfect, so the known error is
  written down rather than silently picking a side.
- **Signing out and into another account, or a currency change**, has the same shape: with the
  currency unchanged the baseline is not reset and the whole difference is recorded as spend; with
  the currency changed `spend` only swaps the baseline and converts nothing. After either actually
  happens, press "Clear statistics" once.
- The ledger hangs off the status row below the conversation composer: **hiding the status row does
  not stop the accounting**, but the delta accumulated **while on a non-conversation panel** is
  merged into the bucket of the moment you return — it affects the hour distribution, not the total.
- Running time, display preferences and the usage ledger all live in **this browser's**
  `localStorage`; clearing site data loses them.
- **The output rate counts only the decode spans the provider timed**: a cancelled step assembles no
  message, so that streaming time never enters `decodeMs`. It measures "how fast completed output was
  written" — numerator and denominator share a source, so the ratio is self-consistent, but it is not
  "tokens produced ÷ all generation time".
- **Retention is unlimited, so the document keeps growing**: every commit stringifies and writes the
  whole thing back, which gets linearly more expensive; once the quota is full `setItem` throws and
  the settings page's "Storage used" turns into an amber warning saying that from then on it only
  accounts in this page's memory.
- **The hourly window no longer has a retention limit**: the date dropdown lists every day ever
  recorded, growing over time.
- **The cache hit rate starts later than the token total**: `inputTokens` / `cacheReadTokens` were
  added later, so old `seen` records read as "not known yet"; that column's window therefore starts
  at the upgrade and converges with the others over time. It is perfectly self-consistent (numerator
  and denominator start together) — it is just not the same span as the token total.
- **The v2 migration zeroes the old totals** (the old document is left untouched at
  `dsh.account-balance.usage.v1`).
- A brand-new session that has not run a request yet shows `—` for tokens; running for under a second
  produces no rate (avoiding a first-second spike), and a decode span under a second likewise
  produces no output rate.
- The render slot `conversation.composer.dock` is `scope: session`, so it does not appear on pages
  without a session.

## Licence

[MIT](LICENSE) © 2026 lwx071001 — use it, change it, redistribute it; keep this notice and expect no
warranty.
