/**
 * account-balance — CLIENT half of the installed bundle.
 *
 * Registers two things:
 *
 *   1. one ambient entry into `conversation.composer.dock` — the band under the
 *      composer card, next to the shipped `stats` pills — showing the account
 *      balance, this conversation's token total, how long the conversation has
 *      been running, and the tokens-per-second that follows from the two;
 *   2. one page into `settings.section`, which turns each of those figures on
 *      or off.
 *
 * ## The balance comes from the account Remote, never from an API key
 *
 *   The shipped `@deepseek-ai/dsh-api-account-controller` publishes the `account`
 *   Remote namespace. Its `getBalance` forwards to the Host `deepseekAccount`
 *   service, which is the only component allowed to obtain a Platform request
 *   credential. This file therefore reads the balance exactly the way the
 *   shipped Settings → Account screen does, and never touches `DEEPSEEK_API_KEY`
 *   and never calls the public `/user/balance` endpoint itself.
 *
 * ## The token total comes from the shipped `tokenUsage` projection
 *
 *   `@deepseek-ai/dsh-token-meter` already folds every settled Assistant attempt
 *   into four DISJOINT buckets, replacing a repeated `(turn, step)` sample
 *   instead of adding it twice and closing the slot on `llm/retry-started` so a
 *   retry counts once:
 *
 *     { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
 *
 *   The names are the proof that the buckets do not overlap: the input side is
 *   `uncachedInputTokens + cacheReadTokens + cacheWriteTokens` (exactly what the
 *   shipped `StatsPills` calls "billed input") and `reasoningTokens` is already
 *   inside `outputTokens`, so the conversation's total is the sum of all four.
 *   Reading the shipped projection instead of folding session events here means
 *   one definition of the number instead of two.
 *
 * ## The running time is a stopwatch on the conversation's own running flag
 *
 *   `useSessionStatus(state => state.get(sessionId)?.running)` is the live
 *   boolean the shipped Agent-Team panel reads for member activity. The timer
 *   starts when it turns true and stops when it turns false. It is deliberately
 *   NOT derived from `sessionStats`' `llmMs`/`toolMs`: those accumulate only
 *   completed spans, so they cannot tick live and silently drop cancelled steps.
 *
 *   Elapsed time is accumulated per Session in the browser's own `localStorage`,
 *   the same choice the sibling `theme-studio` bundle makes for its preferences:
 *   it keeps this bundle free of a Host storage dependency, so editing this file
 *   needs only a page refresh and never a Harness restart. The trade-off is that
 *   the record lives in this browser rather than in the profile.
 *
 * Freshness:
 *
 *   `account.watch` streams the login *state*, not the wallet, so a spend does
 *   not push a frame; the balance is polled instead (60 s while reads succeed,
 *   15 s after a failure) and re-read when the tab regains focus or visibility.
 *   Reads are skipped while the document is hidden. The token total and the
 *   running flag are pushed — one by the projection registry, one by the Session
 *   status store — so neither is polled.
 *
 * Bundle rules this file follows (see the cordis-plugin-development skill):
 *   - the factory registers a lazy module whose id equals the package name;
 *   - React comes from the browser module table (`require('react')`), and no
 *     other Harness Client package is imported;
 *   - every registration is an effect of `apply`'s context, so disabling the
 *     bundle removes the slot entries and the dictionaries;
 *   - styles render as a React element, so unmounting removes them;
 *   - visible text is routed through the Client locale service;
 *   - styling uses only `--dsw-alias-*` / `--dsw-radius-*` theme tokens.
 *
 * ## Everything below lives inside one function scope, on purpose
 *
 *   A client half is served as a CLASSIC script and evaluated in the page's
 *   global scope. A top-level `const` there becomes a global lexical binding,
 *   and evaluating the same script a SECOND time in the same realm — a
 *   client-HMR revision bump, or a re-boot — dies with
 *
 *     Uncaught SyntaxError: Identifier 'NS' has already been declared
 *
 *   That is not cosmetic. The desktop shell reports the failed entry as
 *
 *     Error: web boot: 1 entry did not activate
 *     @local/account-balance: import failed
 *
 *   and treats it as fatal, exiting the whole application. This file used to
 *   crash DSH on refresh exactly this way.
 *
 *   The IIFE below makes re-evaluation harmless: every declaration becomes
 *   function-scoped, so a second evaluation gets a fresh scope instead of
 *   colliding with the first. Do NOT hoist a declaration back out of it.
 */

;(function () {

const NS = 'account-balance'

/**
 * Milliseconds between balance reads while the last read succeeded.
 * The wallet moves only when a request settles, so a slow poll is enough.
 */
const REFRESH_MS = 60000
/** Milliseconds before retrying after a failed read. */
const RETRY_MS = 15000

/**
 * Identity this UI reports to the Platform on every account call. The Host
 * forwards `AccountClientMetadata` so Platform can tell which client asked; the
 * shipped Settings screen passes its own build constant the same way. Only
 * presence matters — replace it when upgrading the Harness.
 */
const CLIENT_VERSION = '0.2.0-rc.2'

/** Where the display preferences live. Versioned so a shape change can migrate. */
const SETTINGS_KEY = 'dsh.account-balance.settings.v1'
/** Prefix of the per-Session accumulated running time. */
const DURATION_KEY_PREFIX = 'dsh.account-balance.duration.v1.'
/** How often the open running span is written back while the conversation runs. */
const PERSIST_EVERY_TICKS = 5

/**
 * The usage ledger: hourly, daily and monthly rollups plus the running totals.
 *
 * v2 exists because v1's NUMBERS MEANT SOMETHING ELSE, not because its shape
 * changed: v1 credited a Session's whole log the first time it saw that Session,
 * so its token total mixed history the plugin never watched with usage it did,
 * while the money column could only ever cover what was watched. Every derived
 * figure was therefore a ratio of two different windows. See `migrateLedger`.
 */
const USAGE_KEY = 'dsh.account-balance.usage.v2'
/** The pre-v2 key. Read once, to migrate; never written again. */
const USAGE_KEY_LEGACY = 'dsh.account-balance.usage.v1'

/**
 * The budget a browser typically grants one origin for `localStorage`. Reported
 * as an approximate share rather than enforced: what this plugin owes the user is
 * the real figure, and this is only the yardstick that makes it readable.
 */
const STORAGE_QUOTA_BYTES = 5 * 1024 * 1024

/**
 * Past this many points the per-point hover circles are skipped and only the line
 * is drawn. They are a hover target, not the chart: at a screenful they merge into
 * a band that neither reads as data nor can be pointed at individually. Nothing is
 * dropped from the series or from the totals — this is a drawing decision only,
 * and retention is unlimited, so a long-lived ledger will reach it.
 */
const CHART_DOT_LIMIT = 120

const CSS = `
.ab-root {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.ab-part { display: inline-flex; align-items: baseline; gap: 4px; }
.ab-label { color: inherit; }
.ab-value { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.ab-sep { color: inherit; }
.ab-balance.ab-tone-muted .ab-value { color: inherit; font-weight: 400; }
.ab-balance.ab-tone-stale .ab-value, .ab-balance.ab-tone-warn .ab-value {
  color: var(--dsw-alias-state-warn-primary);
}
.ab-balance.ab-tone-error .ab-value { color: var(--dsw-alias-state-error-primary); }
.ab-button {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-variant-numeric: inherit;
  cursor: pointer;
}
.ab-button:hover .ab-value { text-decoration: underline; text-underline-offset: 2px; }
.ab-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.ab-button[aria-busy="true"] .ab-value { opacity: .72; }

/* The liquid-glass skin dresses the dock in glass capsules, and it finds the
   statistics line by position: it styles the dock's FIRST child, which is the
   shipped stats entry — a proxy for "the one entry" that a second occupant
   falls outside of. (That plugin's own comment calls the rule "StatsLine".) The
   result is this row sitting bare beside a capsule that belongs to the same
   line of text.

   So the capsule is mirrored here, under the SAME marker the skin sets on the
   body element and with the SAME custom properties, which buys two things: the
   two states stay consistent — with the skin off this rule is inert and the row
   is plain, just like its neighbour — and a change to the skin's own settings
   (blur, tint and radius live in the --lg-* properties) moves both capsules
   together rather than drifting apart.

   Mirrored deliberately: box-sizing, width, max-width, margin, padding,
   font-size, line-height, background, backdrop blur, border, radius and the
   inset highlight. NOT mirrored: height, overflow, text-overflow and
   white-space — the skin uses them to truncate a line that cannot wrap, while
   this row is built to wrap its cells instead of hiding figures, and clipping
   the tail off a balance would be worse than a second line. */
body[data-dsh-liquid-glass] [data-slot='conversation.composer.dock'] > .ab-root {
  box-sizing: border-box;
  width: fit-content;
  max-width: 100%;
  margin: 0 auto;
  padding: 4px 16px;
  font-size: 12px;
  line-height: 20px;
  background: var(--lg-control-bg);
  -webkit-backdrop-filter: blur(var(--lg-blur-card)) saturate(145%);
  backdrop-filter: blur(var(--lg-blur-card)) saturate(145%);
  border: 1px solid var(--lg-border);
  border-radius: var(--lg-radius-control);
  box-shadow: inset 0 1px 0 var(--lg-highlight);
}

/* The context meter is the other bare capsule on that line. The shipped
   composer renders it as a SIBLING of the dock anchor rather than an entry
   inside it — the anchor is a display:contents box holding the entries, and the
   meter is the next element after it — so the skin's positional rule cannot
   reach this one either. It is styled on the trigger button, not on the
   wrapper, for the same reason the skin styles SidebarSettings that way: the
   button is what carries the padding, the hover and the aria state.

   The anchor is addressed as the dock slot's FOLLOWING SIBLING. That needs no
   hashed class name from the shipped module (which changes on every build) and
   no build-time knowledge of the meter's internals — the slot key is public and
   the relation is the composer's own layout.

   The one view left out is the hero (new-session) composer: the shipped code
   renders no dock anchor there at all, yet still renders the meter. Reaching it
   would mean naming a hashed class or guessing at the meter's wrapper — and in
   that view this plugin's own row is not rendered either, so there is no line
   for the meter to be out of step with. */
body[data-dsh-liquid-glass] [data-slot='conversation.composer.dock'] ~ * button[aria-haspopup='dialog'] {
  box-sizing: border-box;
  width: fit-content;
  max-width: 100%;
  margin: 0 auto;
  padding: 4px 16px;
  font-size: 12px;
  line-height: 20px;
  background: var(--lg-control-bg);
  -webkit-backdrop-filter: blur(var(--lg-blur-card)) saturate(145%);
  backdrop-filter: blur(var(--lg-blur-card)) saturate(145%);
  border: 1px solid var(--lg-border);
  border-radius: var(--lg-radius-control);
  box-shadow: inset 0 1px 0 var(--lg-highlight);
}

/* This is the one capsule on the line that opens something, so the hover it
   already had has to survive being dressed: the shipped rule tints the text on
   hover and this one firms the rim, leaving the state legible without
   reintroducing the flat hover fill that would replace the glass. */
body[data-dsh-liquid-glass] [data-slot='conversation.composer.dock'] ~ * button[aria-haspopup='dialog']:hover,
body[data-dsh-liquid-glass] [data-slot='conversation.composer.dock'] ~ * button[aria-haspopup='dialog'][aria-expanded='true'] {
  border-color: var(--lg-border-strong);
  box-shadow: inset 0 1px 0 var(--lg-highlight), 0 0 0 1px var(--lg-border-strong);
}

.ab-page { display: flex; flex-direction: column; gap: 24px; padding-bottom: 32px; }
.ab-intro { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; margin: 0; }
.ab-group { display: flex; flex-direction: column; gap: 4px; }
.ab-groupTitle { color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; margin: 0; font-weight: 400; }
.ab-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; margin: 0; }
.ab-warn { color: var(--dsw-alias-state-warn-primary); }
.ab-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l1);
}
.ab-row:last-child { border-bottom: none; }
.ab-rowLabel { flex: 1; min-width: 0; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
.ab-rowLabel[data-disabled="true"] { color: var(--dsw-alias-label-tertiary); }
.ab-rowControl { display: inline-flex; align-items: center; gap: 8px; }
.ab-pill {
  box-sizing: border-box;
  min-width: 54px;
  height: 30px;
  padding: 0 12px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.ab-pill:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ab-pill:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.ab-pill[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.ab-pill:disabled { opacity: .5; cursor: default; }
.ab-pill:disabled:hover { background: none; }

.ab-tabs { display: flex; gap: 8px; }
.ab-range { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
.ab-field { display: inline-flex; align-items: center; gap: 6px; }
.ab-fieldLabel { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.ab-select {
  box-sizing: border-box;
  height: 30px;
  padding: 0 8px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.ab-select:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ab-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.ab-chart {
  box-sizing: border-box;
  width: 100%;
  height: auto;
  overflow: visible;
  color: var(--dsw-alias-label-tertiary);
}
.ab-chartAxis { stroke: var(--dsw-alias-border-l2); stroke-width: 1; }
.ab-chartLine { fill: none; stroke: var(--dsw-alias-brand-primary); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
.ab-chartDot { fill: var(--dsw-alias-brand-primary); }
.ab-chartMax { fill: var(--dsw-alias-label-secondary); font-size: 10px; }
.ab-chartTick { fill: var(--dsw-alias-label-tertiary); font-size: 10px; }
.ab-stats { display: flex; flex-direction: column; gap: 0; }
.ab-statValue { color: var(--dsw-alias-label-secondary); font-size: 13px; font-variant-numeric: tabular-nums; }
.ab-empty {
  box-sizing: border-box;
  padding: 16px;
  border: .5px dashed var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  margin: 0;
}
.ab-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
`

/** The display preferences and their defaults. */
const DEFAULT_SETTINGS = {
  show: true,
  balance: true,
  tokens: true,
  duration: true,
  rate: true,
}

/** Simplified Chinese dictionary (the key-set source of truth). */
const zh = {
  'aria': '账户余额与本对话统计',
  'balance.label': '余额',
  'tokens.label': '本对话',
  'balance.loading': '读取中…',
  'balance.signedOut': '未登录',
  'balance.unavailable': '余额不可用',
  'balance.empty': '无可读余额',
  'balance.error': '读取失败',
  'tokens.unavailable': '—',
  'tip.balanceTitle': 'DeepSeek 账户余额',
  'tip.total': '可用合计',
  'tip.recharge': '充值余额',
  'tip.bonus': '赠送余额',
  'tip.updated': '更新于',
  'tip.signedOut': '未登录：「设置 → 账户」登录后显示余额',
  'tip.error': '上次读取失败',
  'tip.hint': '点击余额刷新',
  'tip.tokensTitle': '本对话 token 消耗',
  'tip.tokensTotal': '合计',
  'tip.tokensInput': '未命中输入',
  'tip.tokensCacheRead': '缓存命中',
  'tip.tokensCacheWrite': '缓存写',
  'tip.tokensOutput': '输出',
  'tip.tokensNote': 'provider 计数，未命中输入 + 缓存命中 + 缓存写 + 输出；子代理不计入。',
  'tip.timingTitle': '运行时长与速率',
  'tip.runningNow': '运行中，正在计时',
  'tip.idleNow': '已暂停，空闲不计时',
  'tip.durationNote': '对话运行时计时、空闲时暂停；累计值存在本浏览器，刷新不丢。',
  'tip.rateNote': '每秒总 token = token 合计 ÷ 运行时长，是整段对话的平均值。',
  'settings.section': '账户与统计',
  'settings.intro': '控制输入框下方那条状态行显示什么。设置保存在本浏览器。',
  'settings.group': '显示内容',
  'settings.show': '显示状态行',
  'settings.balance': '账户余额',
  'settings.tokens': '本对话 token 总量',
  'settings.duration': '运行时长',
  'settings.rate': '每秒 token 数',
  'settings.on': '开',
  'settings.off': '关',
  'settings.hint': '关闭「显示状态行」后整条不再出现；其余各项只在状态行显示时生效。',
  'usage.group': '用量统计',
  'usage.intro': '按分时、每天、每月记录本浏览器观察到的 token 消耗，以及同一时段的账户扣费。分时可任选一天与时段查看。',
  'usage.retained': '保留策略：不限时 —— 所有时段都保留在本浏览器，直到你清空统计。',
  'usage.coverage': '统计范围：本浏览器**开始记录以来**观察到的用量，不含更早的历史——插件存在之前的余额变化无从得知，token 也不声称覆盖它。',
  'storage.group': '存储占用',
  'storage.intro': '这些数据在本浏览器里实际占用的空间。保留不限时，所以它会随时间增长。',
  'storage.usage': '统计台账',
  'storage.duration': '运行时长记录',
  'storage.legacy': '旧版台账（v1）',
  'storage.settings': '显示偏好',
  'storage.total': '合计',
  'storage.entries': '{n} 条',
  'storage.unavailable': '读不到 localStorage，无法统计占用。',
  'storage.note': '浏览器通常给每个来源约 {quota} 的配额，键与值都按 UTF-16 计费（每字符 2 字节）—— 当前约占其 {share}。',
  'storage.full': '上一次写入被浏览器拒绝（配额可能已满）：此后只在本页内存里记账，刷新即丢失。请在浏览器里清理本站点数据。',
  'usage.chartAria': 'token 消耗曲线',
  'usage.empty': '还没有记录。开始对话后这里会画出曲线。',
  'usage.rangeEmpty': '这一天的这个时段没有记录。换一天，或把起止放宽一些。',
  'usage.period.hour': '分时',
  'usage.period.day': '每天',
  'usage.period.month': '每月',
  'usage.rangeDay': '日期',
  'usage.rangeFrom': '起',
  'usage.rangeTo': '止',
  'usage.rangeSum': '区间合计',
  'usage.statTokens': '总 token',
  'usage.statTime': '记录时长',
  'usage.statRate': '平均每秒总 token',
  'usage.statOutputRate': '平均每秒输出 token',
  'usage.statCacheHit': '平均缓存命中率',
  'usage.statSpend': '累计消耗金额',
  'usage.statPerMillion': '每百万 token',
  'usage.statPerTenMillion': '每千万 token',
  'usage.none': '—',
  'usage.rateNote': '总速率 = 总 token ÷ 运行时长；输出速率 = provider 上报的解码时长内的输出 token ÷ 该时长，不含首字等待与工具调用时间。',
  'usage.cacheNote': '缓存命中率 = 缓存命中 token ÷ 提示词侧 token（未命中输入 + 缓存命中 + 缓存写），输出 token 不计入 —— 与输入框下方内建药丸同一口径。',
  'usage.note': '金额取自账户余额的减少量，因此只覆盖本浏览器打开的时段；充值、赠送到期等非用量变动不计入。',
  'usage.clear': '清空统计',
  'usage.clearConfirm': '确认清空？',
  'usage.clearHint': '清空后总额与曲线归零，之后的新增继续记录。',
}

/** English dictionary, checked complete against the zh key set. */
const en = {
  'aria': 'Account balance and conversation stats',
  'balance.label': 'Balance',
  'tokens.label': 'This chat',
  'balance.loading': 'Loading…',
  'balance.signedOut': 'Not signed in',
  'balance.unavailable': 'Balance unavailable',
  'balance.empty': 'No readable balance',
  'balance.error': 'Read failed',
  'tokens.unavailable': '—',
  'tip.balanceTitle': 'DeepSeek account balance',
  'tip.total': 'Available total',
  'tip.recharge': 'Topped-up',
  'tip.bonus': 'Granted',
  'tip.updated': 'Updated',
  'tip.signedOut': 'Not signed in — sign in under Settings → Account to show the balance',
  'tip.error': 'Last read failed',
  'tip.hint': 'Click the balance to refresh',
  'tip.tokensTitle': 'This conversation’s token usage',
  'tip.tokensTotal': 'Total',
  'tip.tokensInput': 'Uncached input',
  'tip.tokensCacheRead': 'Cache read',
  'tip.tokensCacheWrite': 'Cache write',
  'tip.tokensOutput': 'Output',
  'tip.tokensNote': 'Provider counts: uncached input + cache read + cache write + output. Subagents are not included.',
  'tip.timingTitle': 'Running time and rate',
  'tip.runningNow': 'Running — the timer is going',
  'tip.idleNow': 'Paused — idle time is not counted',
  'tip.durationNote': 'Times the conversation while it runs and pauses when it is idle. The total is kept in this browser, so a refresh does not lose it.',
  'tip.rateNote': 'Total tokens per second = token total ÷ running time, averaged over the whole conversation.',
  'settings.section': 'Account & stats',
  'settings.intro': 'Choose what the status row under the composer shows. Preferences are saved in this browser.',
  'settings.group': 'Shown figures',
  'settings.show': 'Show the status row',
  'settings.balance': 'Account balance',
  'settings.tokens': 'Conversation token total',
  'settings.duration': 'Running time',
  'settings.rate': 'Tokens per second',
  'settings.on': 'On',
  'settings.off': 'Off',
  'settings.hint': 'Turning off the status row hides the whole line; the other switches apply only while it is shown.',
  'usage.group': 'Usage statistics',
  'usage.intro': 'Token usage observed by this browser, rolled up by hour, day and month, with the account charge for the same span. The hourly chart can be narrowed to any one recorded day and span.',
  'usage.retained': 'Retention: unlimited — every recorded bucket stays in this browser until you clear the statistics.',
  'usage.coverage': 'Coverage: usage this browser has OBSERVED since it started recording. Earlier history is excluded — a balance change from before the plugin existed cannot be known, so the token totals do not claim to cover it either.',
  'storage.group': 'Storage used',
  'storage.intro': 'What this data actually costs in this browser. Retention is unlimited, so it grows over time.',
  'storage.usage': 'Usage ledger',
  'storage.duration': 'Running-time records',
  'storage.legacy': 'Legacy ledger (v1)',
  'storage.settings': 'Display preferences',
  'storage.total': 'Total',
  'storage.entries': '{n}',
  'storage.unavailable': 'localStorage is unreadable, so the footprint cannot be measured.',
  'storage.note': 'A browser typically allows about {quota} per origin, and charges keys and values as UTF-16 (2 bytes per code unit). This data is now using about {share} of that.',
  'storage.full': 'The browser refused the last write — the quota is probably full. Since then the ledger exists only in this page\'s memory and a reload will lose it. Clear this site\'s data in the browser to start over.',
  'usage.chartAria': 'Token usage chart',
  'usage.empty': 'Nothing recorded yet. Start a conversation and the curve will appear here.',
  'usage.rangeEmpty': 'Nothing recorded in this part of the day. Pick another day, or widen the hours.',
  'usage.period.hour': 'Hourly',
  'usage.period.day': 'Daily',
  'usage.period.month': 'Monthly',
  'usage.rangeDay': 'Day',
  'usage.rangeFrom': 'From',
  'usage.rangeTo': 'To',
  'usage.rangeSum': 'Span total',
  'usage.statTokens': 'Total tokens',
  'usage.statTime': 'Recorded time',
  'usage.statRate': 'Average total tokens/s',
  'usage.statOutputRate': 'Average output tokens/s',
  'usage.statCacheHit': 'Average cache hit rate',
  'usage.statSpend': 'Total spend',
  'usage.statPerMillion': 'Per million tokens',
  'usage.statPerTenMillion': 'Per ten million tokens',
  'usage.none': '—',
  'usage.rateNote': 'Total rate = token total ÷ running time. Output rate = the output tokens the provider timed by its own decode spans ÷ those spans, so first-token wait and tool time are in neither term.',
  'usage.cacheNote': 'Cache hit rate = cache-read tokens ÷ prompt-side tokens (uncached input + cache read + cache write), with output excluded — the same quantity the composer pill reports.',
  'usage.note': 'Spend is measured from the account balance dropping, so it only covers time this browser was open; top-ups and bonus expiry are not usage and are excluded.',
  'usage.clear': 'Clear statistics',
  'usage.clearConfirm': 'Confirm clear?',
  'usage.clearHint': 'Clearing zeroes the totals and the curve; new usage keeps recording from there.',
}

/**
 * Currency symbol. Only CNY and USD have one; the Remote schema pins `currency` to
 * exactly those two, so nothing else can arrive. An unknown code yields no symbol,
 * which leaves the bare number — `moneyText(123400, '') === '12.34'`, a pinned
 * behaviour — and the tooltip prints the code itself beside every row, so the
 * amount is never left unlabelled in the one place a second currency appears.
 */
function symbolOf(currency) {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return ''
}

/**
 * Parse one decimal money string into an exact signed integer of 1/10000 units.
 *
 * Money is carried as integers throughout, never as floats: the Platform sends
 * decimal strings, and summing floats would let a rounded cent appear out of
 * nowhere. Four fraction digits are kept so that summing wallets cannot lose a
 * sub-cent residue; the display rules below are applied only at the very end.
 * A leading `-` on an all-zero value yields `0` (`-0` compares equal to it), so
 * "-0.00" is a zero balance rather than a debit.
 *
 * @returns {number | null} exact amount in 1/10000 units, or null when malformed.
 */
function parseMoney(text) {
  if (typeof text !== 'string') return null
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text.trim())
  if (match === null) return null
  const frac = match[3] === undefined ? '' : match[3]
  const units = Number(match[2]) * 10000 + Number((frac + '0000').slice(0, 4))
  if (!Number.isFinite(units)) return null
  return match[1] === '-' ? -units : units
}

/** Signed cent count as grouped two-decimal text: 1234 -> "12.34". */
function group(cents) {
  const digits = String(Math.abs(cents)).padStart(3, '0')
  return Number(digits.slice(0, -2)).toLocaleString() + '.' + digits.slice(-2)
}

/**
 * One exact amount (1/10000 units) as full money text.
 *
 * Truncation, not rounding, matches the shipped account screen's positive branch:
 * an amount below one cent reads `<¥0.01` rather than collapsing to `¥0.00`. (The
 * shipped negative branch calls `toFixed(2)` and would round `-0.015` to `-¥0.02`;
 * this formatter truncates toward zero, so a debit is never shown larger than it
 * is — for amounts of a cent or more.)
 *
 * The sub-cent NEGATIVE branch is an exception and is documented rather than
 * fixed: it prints `-¥0.01` whatever the magnitude, so a debit of ¥0.0001 reads as
 * a whole cent. Every amount this plugin formats is non-negative by construction
 * — spend sums observed balance DROPS, and a wallet balance is never below zero —
 * so the branch is unreachable from the ledger, and inventing notation such as
 * `-<¥0.01` for a case the UI cannot produce would be worse than saying so.
 * @param units - exact amount, or null for an unreadable wallet.
 */
function moneyText(units, symbol) {
  if (units === null) return symbol + '—'
  const cents = Math.trunc(units / 100)
  if (cents === 0) {
    if (units === 0) return symbol + '0.00'
    return (units < 0 ? '-' : '<') + symbol + '0.01'
  }
  const body = group(cents)
  return cents < 0 ? '-' + symbol + body : symbol + body
}

/** Sum one wallet list per currency, preserving the payload's order. */
function walletTotals(list) {
  const rows = []
  const index = new Map()
  if (!Array.isArray(list)) return rows
  for (const wallet of list) {
    if (wallet === null || typeof wallet !== 'object') continue
    const units = parseMoney(wallet.balance)
    if (units === null) continue
    const currency = typeof wallet.currency === 'string' && wallet.currency.length > 0 ? wallet.currency : 'CNY'
    const known = index.get(currency)
    if (known === undefined) {
      const row = { currency, units }
      index.set(currency, row)
      rows.push(row)
    } else {
      known.units += units
    }
  }
  return rows
}

/**
 * Turn one `getBalance` payload into display rows.
 *
 * `value` holds the topped-up wallets and `bonusWallets` the granted ones; what
 * the user can still spend is their sum per currency, which is the headline.
 * @param balance - the `AccountDetails['balance']` payload, or null when signed out.
 */
function modelFrom(balance) {
  if (balance === null || balance === undefined) return { phase: 'signed-out', rows: [] }
  if (balance.status !== 'ready') return { phase: 'unavailable', rows: [] }

  const rows = []
  const index = new Map()
  const merge = (list, kind) => {
    for (const row of walletTotals(list)) {
      let entry = index.get(row.currency)
      if (entry === undefined) {
        entry = { currency: row.currency, total: 0, recharge: 0, bonus: 0, hasRecharge: false, hasBonus: false }
        index.set(row.currency, entry)
        rows.push(entry)
      }
      entry.total += row.units
      if (kind === 'recharge') {
        entry.recharge += row.units
        entry.hasRecharge = true
      } else {
        entry.bonus += row.units
        entry.hasBonus = true
      }
    }
  }
  merge(balance.value, 'recharge')
  merge(balance.bonusWallets, 'bonus')

  return { phase: 'ready', rows }
}

/** The row the widget headlines: CNY when present, else whatever came first. */
function pickPrimary(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  for (const row of rows) if (row.currency === 'CNY') return row
  return rows[0]
}

/** Finite non-negative integer, else 0 (`usage` fields are optional). */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/**
 * Read the four DISJOINT buckets the shipped `tokenUsage` projection publishes,
 * plus the two sums the widget needs. `input` is the prompt side (uncached input
 * plus both cache buckets) and `total` is everything the conversation billed.
 * @param usage - the `tokenUsage` projection value, or undefined while absent.
 * @returns {{uncachedInput: number, cacheRead: number, cacheWrite: number, output: number, input: number, total: number} | null}
 */
function tokenBuckets(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const uncachedInput = count(usage.uncachedInputTokens)
  const cacheRead = count(usage.cacheReadTokens)
  const cacheWrite = count(usage.cacheWriteTokens)
  const output = count(usage.outputTokens)
  const input = uncachedInput + cacheRead + cacheWrite
  return { uncachedInput, cacheRead, cacheWrite, output, input, total: input + output }
}

/**
 * Read the provider's own decode span out of the shipped `sessionStats`
 * projection.
 *
 * Both terms come from the same instrument, which is the point: the fold adds
 * `decodeMs` from the FIRST STREAMED TOKEN to the assembled assistant message,
 * and adds that message's `outputTokens` only on the steps where such a span
 * exists. Prefill (time to first token), tool execution and every non-output
 * token are therefore outside BOTH terms, so their quotient is a rate at which
 * output was actually written — not the conversation's whole wall clock.
 *
 * Mixing instruments would break that: dividing the `tokenUsage` output total by
 * this span would credit tokens that were never timed, and dividing this
 * projection's tokens by the running clock would charge the model for thinking
 * time it did not spend writing.
 *
 * @param stats - the `sessionStats` projection value, or undefined while absent.
 * @returns {{tokens: number, ms: number} | null} null while the projection is absent.
 */
function decodeSpan(stats) {
  if (stats === null || typeof stats !== 'object') return null
  return { tokens: count(stats.decodeTokens), ms: safeAmount(stats.decodeMs) }
}

/**
 * Which figure the balance cell shows, as a small enum.
 *
 * Pulled out as a pure function so EVERY branch can be asserted, not just the
 * happy one — the chain it replaces was an if/else that ended in a default, and a
 * default is exactly where an unhandled state hides.
 *
 * `empty` is the case that hid there: signed in, `status: 'ready'`, and no wallet
 * left after the ones whose balance would not parse were dropped. That is a real
 * outcome (a fresh account whose wallets are empty, or a payload whose amounts
 * this parser rejects), and it used to fall through to "loading" — a label that
 * never resolves, because no amount of waiting changes it.
 *
 * @param primary - the headline wallet row, or null.
 * @param phase - 'signed-out' | 'unavailable' | 'ready' | anything else while loading.
 * @param stale - whether the last read failed.
 * @returns {'value' | 'signed-out' | 'unavailable' | 'empty' | 'error' | 'loading'}
 */
function balanceCase(primary, phase, stale) {
  if (primary !== null && primary !== undefined) return 'value'
  if (phase === 'signed-out') return 'signed-out'
  if (phase === 'unavailable') return 'unavailable'
  if (phase === 'ready') return 'empty'
  if (stale === true) return 'error'
  return 'loading'
}

/** Token counts for the inline row: 517 / 12.2K / 1.2M. */
function compactTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(value)
  if (value < 1e6) return (Math.round(value / 100) / 10).toFixed(1) + 'K'
  return (Math.round(value / 100000) / 10).toFixed(1) + 'M'
}

/** Exact token counts for the tooltip: 12345 -> "12,345". */
function exactTokens(value) {
  if (!Number.isFinite(value)) return '—'
  return value.toLocaleString()
}

/**
 * Fill `{name}` placeholders in a locale string from live values.
 *
 * The retention sentence has to state the real bucket limits, and a dictionary
 * entry cannot read a constant. Substituting the numbers in keeps the copy and
 * the pruning rule as one fact: change a limit and the sentence follows. An
 * unknown placeholder is left verbatim rather than blanked, so a typo shows up
 * in the UI instead of silently deleting a clause.
 */
function fill(template, values) {
  if (typeof template !== 'string') return ''
  return template.replace(/\{([a-z]+)\}/g, (match, key) => (
    Object.hasOwn(values, key) ? String(values[key]) : match
  ))
}

/**
 * One token rate for the inline row.
 *
 * A rate is not a token count, and the two cannot share one formatter. Below ten
 * a whole number would hide the difference between 0.4 and 4, so the fraction
 * keeps a decimal. Up to a thousand the whole number is the readable figure —
 * `compactTokens` is wrong here precisely because a COUNT below a thousand is
 * printable as-is, while a rate in that band is a quotient with sixteen decimals
 * behind it and would render as `16.666666666666668 tok/s`. Above a thousand the
 * two agree again, and the compact count is what belongs on screen.
 */
function compactRate(value) {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 10) return (Math.round(value * 10) / 10).toFixed(1)
  if (value < 1000) return String(Math.round(value))
  return compactTokens(value)
}

/** A duration as 45s / 2m05s / 1h02m — read at a glance, never wider than needed. */
function formatDuration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return hours + 'h' + String(minutes).padStart(2, '0') + 'm'
  if (minutes > 0) return minutes + 'm' + String(seconds).padStart(2, '0') + 's'
  return seconds + 's'
}

/**
 * Tokens per second over the conversation's running time.
 *
 * A rate needs both terms: with no tokens or no measured running time there is
 * no average to report, so this answers null rather than a flattering zero or a
 * division spike from the first second of a run.
 * @param total - the conversation's token total, or null while unavailable.
 * @param activeMs - accumulated running time in milliseconds.
 */
function tokenRate(total, activeMs) {
  if (total === null || !Number.isFinite(total) || total <= 0) return null
  if (!Number.isFinite(activeMs) || activeMs < 1000) return null
  return total / (activeMs / 1000)
}

/**
 * The cache hit rate of the observed prompt side, as a percentage.
 *
 * Both terms come from the same instrument and the same SIDE of the bill: the
 * denominator is the shipped `billedInputTokens` — uncached input plus both cache
 * buckets — and the numerator is the cache-read part of it. Output tokens are in
 * neither. That is what makes this the same quantity the composer's own pill
 * reports, rather than a share of the grand total, which would fall every time
 * the model wrote more.
 *
 * Needs both terms: with no prompt side observed there is no rate to report, so
 * this answers null rather than a confident 0%.
 */
function cacheHitRate(cacheRead, input) {
  if (!Number.isFinite(input) || input <= 0) return null
  if (!Number.isFinite(cacheRead) || cacheRead <= 0) return 0
  return Math.min(100, (cacheRead / input) * 100)
}

/**
 * A percentage as text: `88%`, `99.6%`, `100%`.
 *
 * Below a full hit the figure keeps a decimal rather than rounding up, because
 * the shipped formatter refuses that same rounding for the same reason: 99.6% and
 * 100% are different facts about how a prompt was billed, and a display that
 * conflates them is wrong in the one direction that matters — it would claim a
 * cache hit that never happened.
 */
function percentText(value) {
  if (value === null || !Number.isFinite(value)) return '—'
  const clamped = Math.max(0, Math.min(100, value))
  if (clamped >= 100) return '100%'
  const whole = Math.round(clamped)
  if (whole < 100) return String(whole) + '%'
  return (Math.floor(clamped * 10) / 10).toFixed(1) + '%'
}

/**
 * The class strings of one rendered dock row.
 *
 * The colour scheme is deliberately one family: labels and the separators stay
 * at the root's tertiary colour, and EVERY figure shares one emphasis colour
 * (`--dsw-alias-label-secondary`), differing from its label by weight rather
 * than by hue. That is what keeps the row reading as a single ambient line
 * instead of four competing widgets.
 *
 * The tone therefore belongs to the balance cell ALONE. While it sat on the
 * root, a failed balance read also recoloured the token figure — one cell's
 * problem turning the whole row amber.
 *
 * @param tone - 'normal' | 'stale' | 'warn' | 'error' | 'muted'.
 */
function rowClasses(tone) {
  return {
    root: 'ab-root',
    balance: 'ab-button ab-balance' + (tone === 'normal' ? '' : ' ab-tone-' + tone),
    tokens: 'ab-part ab-tokens',
    duration: 'ab-part ab-duration',
    rate: 'ab-part ab-rate',
  }
}

// ---------------------------------------------------------------- usage ledger

/** Bucket key for one period; all three shapes sort chronologically as strings. */
function bucketKey(period, time) {
  const date = new Date(time)
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  if (period === 'month') return year + '-' + month
  if (period === 'day') return year + '-' + month + '-' + day
  return year + '-' + month + '-' + day + 'T' + String(date.getHours()).padStart(2, '0')
}

/** The 24 labels of the hourly range pickers: 00:00 … 23:00. */
const HOUR_LABELS = Array.from({ length: 24 }, (unused, hour) => String(hour).padStart(2, '0') + ':00')

/** Finite positive number, else 0 — every stored counter is a non-negative amount. */
function safeAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * A stored per-Session counter: a finite non-negative number, or null for
 * "not known yet".
 *
 * The distinction is load-bearing. A projection that has not been published yet
 * reads as ABSENT, and recording that as 0 would turn the first real reading
 * into growth from zero — crediting a session's entire log as if it had just
 * happened, which is the very bug v2 exists to fix. So "unknown" is stored as
 * null and survives a reload, while a genuine 0 stays 0.
 */
function maybeAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * A new, empty ledger.
 *
 * `tokens`/`activeMs` are the WHOLE conversation side — prompt and output, over
 * the running clock. `outputTokens`/`outputMs` are the provider's decode span
 * alone (see `decodeSpan`). They are separate totals rather than one, because
 * the output rate must be able to divide output by output time: folding the two
 * together would leave only a rate that charges the model for prefill and tool
 * time.
 *
 * `inputTokens`/`cacheReadTokens` are the PROMPT side, kept apart for the same
 * reason the decode span is: the cache hit rate is a ratio inside one side of the
 * bill, so it needs its own numerator and denominator rather than the grand
 * total. `inputTokens` is the shipped `billedInputTokens` — uncached input plus
 * both cache buckets, with output excluded — which is what makes this rate
 * comparable with the pill already in the composer.
 */
function emptyLedger() {
  return {
    v: 1,
    currency: null,
    tokens: 0,
    spend: 0,
    activeMs: 0,
    outputTokens: 0,
    outputMs: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    balance: null,
    seen: {},
    hours: {},
    days: {},
    months: {},
  }
}

/**
 * The key shape each rollup writes, used the way pruning used to be: as the one
 * gate that keeps the maps from filling up with junk now that nothing is dropped
 * for being old.
 *
 * Retention is unlimited, so a malformed key would otherwise live forever. Every
 * shape is also zero-padded and fixed-width, which is what lets a plain string
 * sort stay a chronological sort for the chart and the day picker.
 */
const BUCKET_PATTERN = {
  hours: /^\d{4}-\d{2}-\d{2}T\d{2}$/,
  days: /^\d{4}-\d{2}-\d{2}$/,
  months: /^\d{4}-\d{2}$/,
}

function addToBucket(map, key, tokens, spend) {
  const current = map[key] ?? { t: 0, s: 0 }
  return { ...map, [key]: { t: current.t + tokens, s: current.s + spend } }
}

/**
 * Add `added` tokens to one bucket.
 *
 * A non-positive delta returns the SAME map. Establishing a baseline — or
 * re-basing after a reset — credits nothing, and it must not leave an empty
 * bucket behind either: the chart would draw a point at zero for a period in
 * which nothing was consumed.
 */
function creditTokens(map, key, added) {
  if (!(added > 0)) return map
  return addToBucket(map, key, added, 0)
}

/**
 * Coerce one stored ledger into a complete, bounded one. A corrupt document, an
 * unknown field or a wrong type falls back per field, so one bad write cannot
 * discard months of history.
 */
function normalizeLedger(raw) {
  const next = emptyLedger()
  if (raw === null || typeof raw !== 'object') return next
  if (typeof raw.currency === 'string' && raw.currency.length > 0) next.currency = raw.currency
  next.tokens = safeAmount(raw.tokens)
  next.spend = safeAmount(raw.spend)
  next.activeMs = safeAmount(raw.activeMs)
  // Absent in a document written before the output rate existed. Reading 0 is
  // the honest default: the next reading credits that session's decode span from
  // scratch, exactly as if the older build had been recording it all along.
  next.outputTokens = safeAmount(raw.outputTokens)
  next.outputMs = safeAmount(raw.outputMs)
  // Absent in a document written before the cache rate existed, and read as 0 for
  // the same reason: the next reading credits that session's prompt side from
  // scratch. The per-Session memory below is where "unknown" has to survive.
  next.inputTokens = safeAmount(raw.inputTokens)
  next.cacheReadTokens = safeAmount(raw.cacheReadTokens)
  next.balance = typeof raw.balance === 'number' && Number.isFinite(raw.balance) && raw.balance >= 0 ? raw.balance : null
  if (raw.seen !== null && typeof raw.seen === 'object') {
    for (const [id, value] of Object.entries(raw.seen)) {
      if (value === null || typeof value !== 'object') continue
      next.seen[id] = {
        tokens: maybeAmount(value.tokens),
        ms: maybeAmount(value.ms),
        outputTokens: maybeAmount(value.outputTokens),
        outputMs: maybeAmount(value.outputMs),
        inputTokens: maybeAmount(value.inputTokens),
        cacheReadTokens: maybeAmount(value.cacheReadTokens),
      }
    }
  }
  for (const field of Object.keys(BUCKET_PATTERN)) {
    const source = raw[field]
    if (source === null || typeof source !== 'object') continue
    const rows = {}
    for (const [key, value] of Object.entries(source)) {
      if (value === null || typeof value !== 'object') continue
      // Retention is unlimited, so the key SHAPE is the only thing keeping a
      // stray entry from being stored forever. A key that cannot have come from
      // `bucketKey` is not a bucket and is not worth keeping.
      if (!BUCKET_PATTERN[field].test(key)) continue
      rows[key] = { t: safeAmount(value.t), s: safeAmount(value.s) }
    }
    next[field] = rows
  }
  return next
}

/**
 * One counter's growth since the last reading, with an independent re-base.
 *
 * The ledger remembers what it has ALREADY counted, so only the delta is
 * credited. Without that memory a page reload would re-count a conversation's
 * whole history as if it had just happened.
 *
 * A DECREASING reading is a reset (a fork, a cleared projection), not a refund:
 * the counter re-bases at its new, lower value. Without the re-base the stale
 * high-water mark would swallow every later increase — the count would keep
 * growing while the ledger sat still.
 *
 * Every counter re-bases on its own, so a reset in one never discards real
 * growth in another: a token reset must not eat the running time that arrived in
 * the same reading.
 *
 * `previous === null` means NO BASELINE YET, and that is the rule that makes the
 * ledger's columns comparable: the reading is adopted and NOTHING is credited.
 * The projections this reads are whole-log cumulative values, so crediting the
 * first one they ever showed would book a conversation's entire history to the
 * moment the plugin happened to open it — history the balance — and therefore
 * the money — can never cover. The same rule already governs the money side
 * ("the first reading only establishes that baseline"); this is its other half.
 *
 * @param previous - what the ledger already counted, or null with no baseline.
 * @param next - the fresh reading, or null/undefined while it is not published.
 * @returns {{value: number | null, added: number}} the value to remember and the growth.
 */
function growth(previous, next) {
  if (previous === null || previous === undefined) return { value: maybeAmount(next), added: 0 }
  if (next === null || next === undefined) return { value: previous, added: 0 }
  const value = safeAmount(next)
  const baseline = value < previous ? value : previous
  return { value, added: value - baseline }
}

/**
 * Credit the growth of one Session's counters.
 *
 * Six counters arrive together and four of them are optional: the conversation
 * total and its running time, the provider's decode span, and the prompt-side
 * pair the cache rate divides. A missing reading (the projection is not published
 * yet) leaves that remembered value alone rather than resetting it — which is why
 * an absent `sessionStats` cannot wipe the output rate the ledger has already
 * measured, and why a `tokenUsage` that has not arrived yet cannot turn the next
 * reading into a pile of fake history.
 *
 * @param tokens - the conversation's token total, or null while unavailable.
 * @param ms - its accumulated running time, or null while unavailable.
 * @param time - when the reading was taken; the bucket it is credited to.
 * @param decode - `{tokens, ms}` from `decodeSpan`, or null/undefined while the
 *   `sessionStats` projection is absent.
 * @param prompt - `{input, cacheRead}` from `tokenBuckets`, or null/undefined
 *   while the `tokenUsage` projection is absent. Pass null for `decode` when this
 *   is the only extra reading at hand.
 */
function recordSession(ledger, sessionId, tokens, ms, time, decode, prompt) {
  const seen = Object.hasOwn(ledger.seen, sessionId) ? ledger.seen[sessionId] : null
  const hasDecode = decode !== null && decode !== undefined
  const hasPrompt = prompt !== null && prompt !== undefined
  const before = {
    tokens: seen === null ? null : seen.tokens,
    ms: seen === null ? null : seen.ms,
    outputTokens: seen === null ? null : seen.outputTokens,
    outputMs: seen === null ? null : seen.outputMs,
    inputTokens: seen === null ? null : seen.inputTokens,
    cacheReadTokens: seen === null ? null : seen.cacheReadTokens,
  }
  const tokenGrowth = growth(before.tokens, tokens)
  const msGrowth = growth(before.ms, ms)
  const outputTokenGrowth = growth(before.outputTokens, hasDecode ? decode.tokens : null)
  const outputMsGrowth = growth(before.outputMs, hasDecode ? decode.ms : null)
  const inputGrowth = growth(before.inputTokens, hasPrompt ? prompt.input : null)
  const cacheReadGrowth = growth(before.cacheReadTokens, hasPrompt ? prompt.cacheRead : null)

  // Nothing new: return the same reference so the store neither writes nor
  // notifies. A re-base always changes the remembered value, so it is not caught
  // here — and neither is the first sight of a Session, whose memory is the one
  // thing that must be written even though it credits nothing.
  if (
    tokenGrowth.value === before.tokens
    && msGrowth.value === before.ms
    && outputTokenGrowth.value === before.outputTokens
    && outputMsGrowth.value === before.outputMs
    && inputGrowth.value === before.inputTokens
    && cacheReadGrowth.value === before.cacheReadTokens
  ) return ledger

  return {
    ...ledger,
    seen: {
      ...ledger.seen,
      [sessionId]: {
        tokens: tokenGrowth.value,
        ms: msGrowth.value,
        outputTokens: outputTokenGrowth.value,
        outputMs: outputMsGrowth.value,
        inputTokens: inputGrowth.value,
        cacheReadTokens: cacheReadGrowth.value,
      },
    },
    tokens: ledger.tokens + tokenGrowth.added,
    activeMs: ledger.activeMs + msGrowth.added,
    outputTokens: ledger.outputTokens + outputTokenGrowth.added,
    outputMs: ledger.outputMs + outputMsGrowth.added,
    inputTokens: ledger.inputTokens + inputGrowth.added,
    cacheReadTokens: ledger.cacheReadTokens + cacheReadGrowth.added,
    hours: creditTokens(ledger.hours, bucketKey('hour', time), tokenGrowth.added),
    days: creditTokens(ledger.days, bucketKey('day', time), tokenGrowth.added),
    months: creditTokens(ledger.months, bucketKey('month', time), tokenGrowth.added),
  }
}

/**
 * Credit an observed balance reading as spend.
 *
 * Only a DECREASE is spend: a top-up, a granted bonus or a different signed-in
 * wallet rebases the baseline instead of booking a negative charge, and the
 * first reading only establishes that baseline — there is no earlier value to
 * compare against, so booking spend there would be a fabrication.
 */
function recordBalance(ledger, currency, units, time) {
  if (typeof currency !== 'string' || currency.length === 0) return ledger
  if (units === null || !Number.isFinite(units) || units < 0) return ledger
  if (ledger.balance === null || ledger.currency !== currency) {
    return { ...ledger, currency, balance: units }
  }
  const dropped = ledger.balance - units
  if (dropped <= 0) return { ...ledger, currency, balance: units }
  return {
    ...ledger,
    currency,
    balance: units,
    spend: ledger.spend + dropped,
    hours: addToBucket(ledger.hours, bucketKey('hour', time), 0, dropped),
    days: addToBucket(ledger.days, bucketKey('day', time), 0, dropped),
    months: addToBucket(ledger.months, bucketKey('month', time), 0, dropped),
  }
}

/** One period's buckets as `[key, {t, s}]`, oldest first. */
function bucketEntries(ledger, period) {
  const field = period === 'month' ? 'months' : period === 'day' ? 'days' : 'hours'
  const map = ledger[field]
  if (map === null || typeof map !== 'object') return []
  return Object.keys(map).sort().map(key => [key, map[key]])
}

/**
 * The distinct days present in the hourly buckets, NEWEST first — the order the
 * day picker offers them, so the most recent day is both the first entry and the
 * default selection.
 *
 * The entries arrive sorted, so equal days are adjacent and remembering the last
 * day seen is enough: no set, no second sort.
 */
function hourDays(entries) {
  const days = []
  for (const entry of entries) {
    const day = entry[0].slice(0, 10)
    if (days.length === 0 || days[days.length - 1] !== day) days.push(day)
  }
  return days.reverse()
}

/**
 * The hourly buckets inside one day and one inclusive hour span.
 *
 * A `day` of '' (nothing chosen yet, or no recorded day) passes everything
 * through. The two hour ends are tolerated in either order, so dragging one past
 * the other shows the span rather than an empty chart.
 */
function hourRangeEntries(entries, day, from, to) {
  if (typeof day !== 'string' || day.length === 0) return entries
  const low = Math.min(from, to)
  const high = Math.max(from, to)
  return entries.filter(entry => {
    if (entry[0].slice(0, 10) !== day) return false
    const hour = Number(entry[0].slice(11, 13))
    return hour >= low && hour <= high
  })
}

/** The token column of one series, summed — what a chosen span actually cost. */
function seriesTotal(entries) {
  let total = 0
  for (const entry of entries) total += entry[1].t
  return total
}

/**
 * Money per `per` tokens, in the same 1/10000 currency units `spend` uses.
 *
 * Needs both terms: with no observed spend or no counted tokens there is no rate
 * to report, so this answers null rather than a confident zero.
 */
function moneyPerTokens(spend, tokens, per) {
  if (!Number.isFinite(spend) || spend <= 0) return null
  if (!Number.isFinite(tokens) || tokens <= 0) return null
  if (!Number.isFinite(per) || per <= 0) return null
  return spend / (tokens / per)
}

/**
 * Map one series onto chart coordinates in a `width × height` box whose bottom
 * edge is zero.
 *
 * Geometry is separated from drawing so the scaling can be asserted directly: a
 * single point sits centred, an all-zero series must not divide by zero, and the
 * largest value must land exactly on the top edge.
 * @param entries - `[key, {t, s}]` pairs, oldest first.
 */
function chartGeometry(entries, width, height) {
  let max = 0
  for (const entry of entries) if (entry[1].t > max) max = entry[1].t
  const scale = max > 0 ? max : 1
  const count = entries.length
  const dots = entries.map((entry, index) => ({
    key: entry[0],
    x: count <= 1 ? width / 2 : (index / (count - 1)) * width,
    y: height - (entry[1].t / scale) * height,
    tokens: entry[1].t,
    spend: entry[1].s,
  }))
  return {
    max,
    dots,
    points: dots.map(dot => dot.x.toFixed(1) + ',' + dot.y.toFixed(1)).join(' '),
  }
}

// ------------------------------------------------------------------ preferences

/**
 * Coerce one stored document into a complete settings object. An unknown key, a
 * wrong type, or a corrupt document falls back per field rather than discarding
 * the user's other choices.
 */
function normalizeSettings(raw) {
  const next = { ...DEFAULT_SETTINGS }
  if (raw === null || typeof raw !== 'object') return next
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof raw[key] === 'boolean') next[key] = raw[key]
  }
  return next
}

/** Read the stored preferences; a hostile or absent store yields the defaults. */
function readSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY)
    return raw === null ? { ...DEFAULT_SETTINGS } : normalizeSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * The one preference store both slot entries share, so toggling a row in
 * Settings reaches the running status row without a reload.
 */
function createSettingsStore() {
  let snapshot = readSettings()
  const listeners = new Set()
  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(patch) {
      snapshot = normalizeSettings({ ...snapshot, ...patch })
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot))
      } catch {
        // A full or disabled store must not break the widget; the in-memory
        // value still applies for this page.
      }
      for (const listener of [...listeners]) listener()
    },
  }
}

// ------------------------------------------------------------------ usage store

/**
 * Migrate a pre-v2 ledger document.
 *
 * v1 credited a Session's WHOLE log the first time it saw that Session. The
 * projections it reads (`tokenUsage`, `sessionStats`) are cumulative over the
 * entire durable log, and v1 had no baseline for a Session it had never seen, so
 * opening an old conversation booked that conversation's whole history to the
 * present moment. Its token total therefore covered history, while its running
 * time (a stopwatch that starts when the Session is first seen) and its spend (a
 * balance that can only be observed from now on) covered only what was watched.
 * Every derived figure — the rate, and money per million — divided one window by
 * another.
 *
 * The per-Session memory is both the part worth keeping and exactly what a reset
 * needs: with it, no Session's history can be credited a second time, because
 * the next reading is compared against the value already there. So this keeps
 * `seen` and the balance baseline and zeroes everything else — the same shape
 * `clear()` produces, for the same reason. The discarded totals are not data
 * being thrown away; they are a measurement error being retracted.
 *
 * @param raw - the parsed pre-v2 document.
 * @returns a v2 ledger with the memory and baseline carried over.
 */
function migrateLedger(raw) {
  const legacy = normalizeLedger(raw)
  return {
    ...emptyLedger(),
    currency: legacy.currency,
    balance: legacy.balance,
    seen: legacy.seen,
  }
}

/** Read the stored usage ledger; a hostile or absent store yields an empty one. */
function readLedger() {
  try {
    const raw = window.localStorage.getItem(USAGE_KEY)
    if (raw !== null) return normalizeLedger(JSON.parse(raw))
    const legacy = window.localStorage.getItem(USAGE_KEY_LEGACY)
    if (legacy === null) return emptyLedger()
    // Writing the migrated document back means the retraction happens once, and
    // the stale key is left alone rather than deleted: it is the only copy of the
    // memory if this build is ever rolled back.
    const migrated = migrateLedger(JSON.parse(legacy))
    writeLedger(migrated)
    return migrated
  } catch {
    return emptyLedger()
  }
}

/**
 * Set when the browser refused the last ledger write, which in practice means the
 * origin's quota is full. Retention is unlimited, so this is a real end state
 * rather than a hypothetical one, and a silent one would be the worst kind: the
 * page keeps counting in memory while nothing survives a reload.
 */
let ledgerWriteRefused = false

/** Whether the most recent ledger write was refused. */
function ledgerWriteFailed() {
  return ledgerWriteRefused
}

function writeLedger(ledger) {
  try {
    window.localStorage.setItem(USAGE_KEY, JSON.stringify(ledger))
    ledgerWriteRefused = false
    return true
  } catch {
    // Storage may be unavailable or full. The in-memory ledger still drives the
    // chart for this page; only the across-reload record is lost — and the flag
    // makes that visible in the storage panel instead of leaving it silent.
    ledgerWriteRefused = true
    return false
  }
}

// ------------------------------------------------------------------- footprint

/**
 * Which group one stored key belongs to, or null when it is not ours.
 *
 * There is no namespace prefix common to all four, so the match is explicit per
 * key rather than a `startsWith` on a shared root: a prefix match would also
 * claim any future key of another plugin that happened to share a stem.
 */
function ownedGroup(key) {
  if (key === USAGE_KEY) return 'usage'
  if (key === USAGE_KEY_LEGACY) return 'legacy'
  if (key === SETTINGS_KEY) return 'settings'
  if (key.startsWith(DURATION_KEY_PREFIX)) return 'duration'
  return null
}

/**
 * What one stored entry costs against the browser's quota.
 *
 * `localStorage` holds strings as UTF-16, so a browser charges two bytes per code
 * unit — key AND value — rather than the UTF-8 byte count a file would use. Every
 * string this plugin writes is ASCII (UUIDs, ISO-shaped dates, digits), so for
 * its own data the two differ only by that factor of two. Measuring the charge
 * rather than the content is the point: the figure exists to answer "how close am
 * I to the quota", and the quota is charged this way.
 */
function entryBytes(key, value) {
  return ((key === null ? 0 : key.length) + (value === null ? 0 : value.length)) * 2
}

/** The groups the storage panel reports, in display order. */
const STORAGE_GROUPS = ['usage', 'duration', 'legacy', 'settings']

/**
 * Measure everything this plugin has stored.
 *
 * Enumeration, not bookkeeping: only `localStorage` knows which per-Session
 * running-time keys exist, and a count derived from the ledger's own memory would
 * drift from it — the two are written at different times and by different code.
 *
 * @param storage - a `Storage`, or undefined when the browser refuses access.
 * @returns {{groups: object, total: number, count: number} | null} null when the
 *   store cannot be read at all, so the panel can say so instead of showing 0.
 */
function storageFootprint(storage) {
  if (storage === null || typeof storage !== 'object') return null
  const groups = {}
  let total = 0
  let count = 0
  let length = 0
  try {
    length = Number(storage.length)
  } catch {
    return null
  }
  if (!Number.isFinite(length) || length < 0) return null
  for (const id of STORAGE_GROUPS) groups[id] = { bytes: 0, count: 0 }
  for (let index = 0; index < length; index += 1) {
    let key = null
    let value = null
    try {
      key = storage.key(index)
      if (key === null) continue
      value = storage.getItem(key)
    } catch {
      // One unreadable entry must not blank the whole panel; it is simply not
      // counted, and the total stays a lower bound rather than becoming null.
      continue
    }
    const group = ownedGroup(key)
    if (group === null) continue
    const bytes = entryBytes(key, value)
    groups[group].bytes += bytes
    groups[group].count += 1
    total += bytes
    count += 1
  }
  return { groups, total, count }
}

/** `1.4 MB` / `812 KB` / `96 B` — one unit, chosen so the figure stays readable. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return Math.round(bytes) + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

/** The share of the typical quota, as a percentage string: `0.4%` / `12.7%`. */
function quotaShare(bytes, quota) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0%'
  if (!Number.isFinite(quota) || quota <= 0) return '—'
  const percent = (bytes / quota) * 100
  return (percent < 10 ? percent.toFixed(1) : String(Math.round(percent))) + '%'
}

/**
 * The usage ledger store.
 *
 * Every `observe*` call folds one reading in and notifies only when the ledger
 * actually changed, and the ledger keeps its own per-Session memory, so a caller
 * may invoke these from an effect without provoking a render loop and without a
 * reload re-counting history.
 */
function createUsageStore() {
  let snapshot = readLedger()
  const listeners = new Set()
  const commit = next => {
    if (next === snapshot) return
    snapshot = next
    writeLedger(snapshot)
    for (const listener of [...listeners]) listener()
  }
  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    observeSession(sessionId, tokens, ms, decode, prompt) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      commit(recordSession(snapshot, sessionId, tokens, ms, Date.now(), decode, prompt))
    },
    observeBalance(currency, units) {
      commit(recordBalance(snapshot, currency, units, Date.now()))
    },
    clear() {
      // Keep `seen` and the balance baseline: clearing means "start counting
      // from now", not "count this open conversation's history a second time".
      commit({
        ...emptyLedger(),
        seen: snapshot.seen,
        balance: snapshot.balance,
        currency: snapshot.currency,
      })
    },
  }
}

// ---------------------------------------------------------------- running time

/** Accumulated running time for one Session, in milliseconds. */
function readDuration(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return 0
  try {
    const raw = window.localStorage.getItem(DURATION_KEY_PREFIX + sessionId)
    const value = raw === null ? 0 : Number(raw)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

/**
 * Persist one Session's accumulated running time.
 *
 * A HIGH-WATER MARK, never a move backwards. Running time only ever accumulates
 * for a Session — nothing in this plugin resets one — so a smaller figure can only
 * be stale, and writing it would make the timer visibly count down. That is not
 * hypothetical: a tick already queued when a run stops can land after the
 * stop-write, and a cleanup that recomputes from state can race a tick the same
 * way. Refusing the move is cheaper, and more honest, than ordering the writers.
 */
function writeDuration(sessionId, ms) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return
  try {
    const next = Math.max(0, Math.round(ms))
    if (next <= readDuration(sessionId)) return
    window.localStorage.setItem(DURATION_KEY_PREFIX + sessionId, String(next))
  } catch {
    // Storage may be unavailable (private mode, quota). The timer still works
    // for this page; only the across-reload record is lost.
  }
}

window.__ModuleLoader__.load({
  id: '@local/account-balance',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * The plugin context, captured by `apply`. The registration callbacks run
     * before React mounts either entry, so the components can rely on it;
     * keeping it in the factory scope (rather than closing over `apply`) gives
     * them one stable identity across re-registrations.
     */
    let pluginCtx = null

    const settings = createSettingsStore()
    const usageStore = createUsageStore()

    /** Subscribe a component to a snapshot store (no `useSyncExternalStore`). */
    function useStore(store) {
      const [value, setValue] = React.useState(store.get)
      React.useEffect(() => store.subscribe(() => setValue(store.get())), [store])
      return value
    }

    /**
     * A stopwatch over the conversation's own running flag.
     *
     * Starts when `running` turns true and stops when it turns false — the timer
     * brackets the periods the conversation is actually working, so the derived
     * tokens-per-second is an average over work rather than over the wall clock.
     * The accumulated total is restored and written back per Session, so a
     * refresh does not silently reset the record.
     *
     * @param sessionId - the Session the total belongs to.
     * @param running - the live running flag from `useSessionStatus`.
     * @returns accumulated running time in milliseconds, including the open span.
     */
    function useRunningTime(sessionId, running) {
      const [timer, setTimer] = React.useState(() => ({ accumulated: readDuration(sessionId), startedAt: null }))
      const [, setTick] = React.useState(0)
      /**
       * The stopwatch STATE, readable from a callback created by an earlier render.
       *
       * A tick and an unmount cleanup must not depend on a render having happened
       * since they were created, and a hidden tab throttles the very tick that
       * would cause one. Reading the ref instead of a render-time number is what
       * keeps a flush accurate after minutes in the background.
       */
      const timerRef = React.useRef(timer)
      timerRef.current = timer

      /** The accumulated figure INCLUDING the open span, computed at call time. */
      const currentMs = () => {
        const { accumulated, startedAt } = timerRef.current
        return accumulated + (startedAt === null ? 0 : Math.max(0, Date.now() - startedAt))
      }

      // A reused component must never carry the previous conversation's total.
      React.useEffect(() => {
        setTimer({ accumulated: readDuration(sessionId), startedAt: null })
      }, [sessionId])

      // Going away is not a reason to lose the span in flight. This cleanup runs on
      // unmount AND on a Session switch (before the reset effect above replaces the
      // state), and it is the only thing that writes the span when neither the
      // 5-tick persist nor the stop transition got the chance to. Without it the
      // figure visibly counts BACKWARDS: the dock shows `1m24s`, you switch away and
      // back, and it shows `1m21s`.
      React.useEffect(() => () => {
        writeDuration(sessionId, currentMs())
      }, [sessionId])

      // Start on run, stop on idle — the core of the feature.
      React.useEffect(() => {
        setTimer(prev => {
          if (running) return prev.startedAt === null ? { ...prev, startedAt: Date.now() } : prev
          if (prev.startedAt === null) return prev
          const accumulated = prev.accumulated + Math.max(0, Date.now() - prev.startedAt)
          writeDuration(sessionId, accumulated)
          return { accumulated, startedAt: null }
        })
      }, [running, sessionId])

      const activeMs = currentMs()

      // A one-second tick keeps the figure moving while the conversation runs, and
      // periodically writes the open span back so a reload mid-run is not a total
      // loss. It asks for the figure rather than reusing one from a render, because
      // a hidden tab can leave that render minutes old.
      React.useEffect(() => {
        if (!running) return undefined
        let ticks = 0
        const id = setInterval(() => {
          ticks += 1
          if (ticks % PERSIST_EVERY_TICKS === 0) writeDuration(sessionId, currentMs())
          setTick(value => value + 1)
        }, 1000)
        return () => { clearInterval(id) }
      }, [running, sessionId])

      return activeMs
    }

    /**
     * A hand-rolled SVG line chart. No chart library is available to a plain-JS
     * bundle and none is wanted: the geometry is pure arithmetic (see
     * `chartGeometry`), the colours are theme tokens, and each point carries a
     * native `<title>` tooltip.
     *
     * `empty` is the label for a series with no points. It is passed in rather
     * than fixed, because "nothing recorded yet" and "nothing in the window you
     * picked" are different facts and only the caller knows which one it is.
     */
    function TokenChart(props) {
      const t = props.t
      const entries = props.entries
      if (entries.length === 0) return h('p', { className: 'ab-empty' }, props.empty ?? t('usage.empty'))

      const width = 600
      const height = 120
      const geometry = chartGeometry(entries, width, height)
      const first = entries[0][0]
      const last = entries[entries.length - 1][0]
      // Retention is unlimited, so a long-lived ledger can carry more points than
      // the viewBox has room for. Past that the circles are dropped and the line
      // is kept: no value leaves the series or the totals, only the hover targets
      // that had already merged into a band.
      const dots = entries.length <= CHART_DOT_LIMIT
        ? geometry.dots.map(dot => h('circle', {
            key: 'dot-' + dot.key,
            className: 'ab-chartDot',
            cx: dot.x,
            cy: dot.y,
            r: 2.5,
          }, h('title', null, dot.key + ' · ' + exactTokens(dot.tokens) + ' tok')))
        : null

      return h('svg', {
        className: 'ab-chart',
        viewBox: '0 0 ' + width + ' ' + (height + 16),
        role: 'img',
        'aria-label': t('usage.chartAria'),
      },
        h('line', { key: 'axis', className: 'ab-chartAxis', x1: 0, y1: height, x2: width, y2: height }),
        h('polyline', { key: 'line', className: 'ab-chartLine', points: geometry.points }),
        dots,
        h('text', { key: 'max', className: 'ab-chartMax', x: 0, y: 10 }, compactTokens(geometry.max) + ' tok'),
        h('text', { key: 'from', className: 'ab-chartTick', x: 0, y: height + 12, textAnchor: 'start' }, first),
        h('text', { key: 'to', className: 'ab-chartTick', x: width, y: height + 12, textAnchor: 'end' }, last),
      )
    }

    /** One label/value row of the usage statistics. */
    function StatRow(props) {
      return h('div', { className: 'ab-row' },
        h('span', { className: 'ab-rowLabel' }, props.label),
        h('span', { className: 'ab-statValue' }, props.value),
      )
    }

    /**
     * What this plugin costs in `localStorage`, so "unlimited retention" can be
     * watched rather than assumed.
     *
     * Measured from the store itself on every render instead of being tracked: the
     * ledger knows about its own buckets, but only `localStorage` knows how many
     * per-Session running-time keys exist, and a derived count would drift from
     * the real one. Subscribing to the ledger is what re-measures the panel — the
     * ledger is rewritten by the same events that rewrite those records, so a
     * render from that store is exactly when the footprint can have moved.
     */
    function StorageSection(props) {
      const t = props.t
      useStore(usageStore)
      let storage = null
      try {
        storage = window.localStorage
      } catch {
        // Some privacy modes throw on the property itself, not on `getItem`.
        storage = null
      }
      const footprint = storageFootprint(storage)

      if (footprint === null) {
        return h('div', { className: 'ab-group' },
          h('h3', { key: 'title', className: 'ab-groupTitle' }, t('storage.group')),
          h('p', { key: 'unavailable', className: 'ab-hint' }, t('storage.unavailable')),
        )
      }

      // Order and membership come from the same list the measurement fills, so a
      // group can never be added to one and forgotten in the other — reading a
      // group that was never measured would be `undefined.count`.
      const labels = {
        usage: t('storage.usage'),
        duration: t('storage.duration'),
        legacy: t('storage.legacy'),
        settings: t('storage.settings'),
      }
      // A group holding nothing is not a row: "0 B · 0 条" is noise, and the
      // legacy key only exists on an installation that predates v2.
      const shown = STORAGE_GROUPS.filter(id => footprint.groups[id].count > 0)

      return h('div', { className: 'ab-group' },
        h('h3', { key: 'title', className: 'ab-groupTitle' }, t('storage.group')),
        h('p', { key: 'intro', className: 'ab-hint' }, t('storage.intro')),
        h('div', { key: 'rows', className: 'ab-stats' },
          shown.map(id => h(StatRow, {
            key: id,
            label: labels[id],
            value: formatBytes(footprint.groups[id].bytes)
              + ' · ' + fill(t('storage.entries'), { n: footprint.groups[id].count }),
          })),
          // With one group on screen the total would just repeat it.
          shown.length > 1
            ? h(StatRow, { key: 'total', label: t('storage.total'), value: formatBytes(footprint.total) })
            : null,
        ),
        h('p', {
          key: 'note',
          // A refused write outranks the share: the quota has already been hit, so
          // reporting how full it is would be reporting the wrong thing.
          className: ledgerWriteFailed() ? 'ab-hint ab-warn' : 'ab-hint',
        }, ledgerWriteFailed()
          ? t('storage.full')
          : fill(t('storage.note'), {
              quota: formatBytes(STORAGE_QUOTA_BYTES),
              share: quotaShare(footprint.total, STORAGE_QUOTA_BYTES),
            })),
      )
    }

    /**
     * The usage statistics: the recorded curve, the totals it rolls up to, and
     * the money those totals work out to per million and per ten million tokens.
     *
     * The hourly chart is the one series with a reader-chosen window. Every other
     * figure on the page is a ledger-wide total and stays one, so a narrowed chart
     * never silently rewrites the numbers underneath it; the span's own total is
     * reported next to the curve instead.
     */
    function UsageSection(props) {
      const t = props.t
      const ledger = useStore(usageStore)
      const [period, setPeriod] = React.useState('day')
      const [confirmingClear, setConfirmingClear] = React.useState(false)
      // The hourly window the reader picked. `day: null` means "follow the data":
      // the newest recorded day, which is also the picker's first entry.
      const [span, setSpan] = React.useState({ day: null, from: 0, to: 23 })

      // An armed confirmation must not sit there indefinitely.
      React.useEffect(() => {
        if (!confirmingClear) return undefined
        const id = setTimeout(() => setConfirmingClear(false), 4000)
        return () => clearTimeout(id)
      }, [confirmingClear])

      const periodEntries = bucketEntries(ledger, period)
      const days = period === 'hour' ? hourDays(periodEntries) : []
      const day = days.length === 0 ? null : (days.includes(span.day) ? span.day : days[0])
      // Ends are interchangeable in a span, so they are ordered here — the filter,
      // the two pickers and the caption then all read the same way round.
      const from = Math.min(span.from, span.to)
      const to = Math.max(span.from, span.to)
      const entries = day === null
        ? periodEntries
        : hourRangeEntries(periodEntries, day, span.from, span.to)

      const symbol = symbolOf(ledger.currency === null ? 'CNY' : ledger.currency)
      const rate = tokenRate(ledger.tokens, ledger.activeMs)
      const outputRate = tokenRate(ledger.outputTokens, ledger.outputMs)
      const cacheHit = cacheHitRate(ledger.cacheReadTokens, ledger.inputTokens)
      const perMillion = moneyPerTokens(ledger.spend, ledger.tokens, 1e6)
      const perTenMillion = moneyPerTokens(ledger.spend, ledger.tokens, 1e7)
      const none = t('usage.none')

      const periods = [
        { id: 'hour', label: t('usage.period.hour') },
        { id: 'day', label: t('usage.period.day') },
        { id: 'month', label: t('usage.period.month') },
      ]

      // Both pickers carry the ORDERED ends, so dragging one past the other reads
      // as the two ends swapping rather than as a chart that ignores its labels.
      const hourPicker = (value, key, onPick) => h('select', {
        key,
        className: 'ab-select',
        value: String(value),
        onChange: event => onPick(Number(event.target.value)),
      }, HOUR_LABELS.map((label, hour) => h('option', { key: hour, value: String(hour) }, label)))

      const range = day === null ? null : h('div', { key: 'range', className: 'ab-range' },
        h('label', { key: 'day', className: 'ab-field' },
          h('span', { className: 'ab-fieldLabel' }, t('usage.rangeDay')),
          h('select', {
            className: 'ab-select',
            value: day,
            onChange: event => setSpan(prev => ({ ...prev, day: event.target.value })),
          }, days.map(entry => h('option', { key: entry, value: entry }, entry))),
        ),
        h('label', { key: 'from', className: 'ab-field' },
          h('span', { className: 'ab-fieldLabel' }, t('usage.rangeFrom')),
          hourPicker(from, 'fromValue', value => setSpan(prev => ({ ...prev, from: value }))),
        ),
        h('label', { key: 'to', className: 'ab-field' },
          h('span', { className: 'ab-fieldLabel' }, t('usage.rangeTo')),
          hourPicker(to, 'toValue', value => setSpan(prev => ({ ...prev, to: value }))),
        ),
        h('span', { key: 'sum', className: 'ab-hint' },
          t('usage.rangeSum') + ' ' + exactTokens(seriesTotal(entries)) + ' tok'),
      )

      return h('div', { className: 'ab-group' },
        h('h3', { key: 'title', className: 'ab-groupTitle' }, t('usage.group')),
        h('p', { key: 'intro', className: 'ab-hint' }, t('usage.intro')),
        h('p', { key: 'retained', className: 'ab-hint' }, t('usage.retained')),
        h('p', { key: 'coverage', className: 'ab-hint' }, t('usage.coverage')),
        h('div', { key: 'tabs', className: 'ab-tabs' },
          periods.map(entry => h('button', {
            key: entry.id,
            type: 'button',
            className: 'ab-pill',
            'aria-pressed': period === entry.id,
            onClick: () => setPeriod(entry.id),
          }, entry.label)),
        ),
        range,
        h(TokenChart, {
          key: 'chart',
          entries,
          t,
          // A narrowed window that matches nothing is NOT "no data recorded yet":
          // saying that would send the reader looking in the wrong place.
          empty: day === null ? t('usage.empty') : t('usage.rangeEmpty'),
        }),
        h('div', { key: 'stats', className: 'ab-stats' },
          h(StatRow, { key: 'tokens', label: t('usage.statTokens'), value: exactTokens(ledger.tokens) + ' tok' }),
          h(StatRow, { key: 'time', label: t('usage.statTime'), value: formatDuration(ledger.activeMs) }),
          h(StatRow, { key: 'rate', label: t('usage.statRate'), value: rate === null ? none : compactRate(rate) + ' tok/s' }),
          h(StatRow, {
            key: 'outputRate',
            label: t('usage.statOutputRate'),
            value: outputRate === null ? none : compactRate(outputRate) + ' tok/s',
          }),
          h(StatRow, {
            key: 'cacheHit',
            label: t('usage.statCacheHit'),
            value: cacheHit === null ? none : percentText(cacheHit),
          }),
          h(StatRow, {
            key: 'spend',
            label: t('usage.statSpend'),
            value: ledger.spend > 0 ? moneyText(ledger.spend, symbol) : none,
          }),
          h(StatRow, {
            key: 'perMillion',
            label: t('usage.statPerMillion'),
            value: perMillion === null ? none : moneyText(perMillion, symbol),
          }),
          h(StatRow, {
            key: 'perTenMillion',
            label: t('usage.statPerTenMillion'),
            value: perTenMillion === null ? none : moneyText(perTenMillion, symbol),
          }),
        ),
        h('p', { key: 'rateNote', className: 'ab-hint' }, t('usage.rateNote')),
        h('p', { key: 'cacheNote', className: 'ab-hint' }, t('usage.cacheNote')),
        h('p', { key: 'note', className: 'ab-hint' }, t('usage.note')),
        h('div', { key: 'clear', className: 'ab-row' },
          h('span', { className: 'ab-rowLabel' }, t('usage.clearHint')),
          h('span', { className: 'ab-rowControl' },
            confirmingClear
              ? h('button', {
                  key: 'confirm',
                  type: 'button',
                  className: 'ab-pill ab-danger',
                  onClick: () => { usageStore.clear(); setConfirmingClear(false) },
                }, t('usage.clearConfirm'))
              : h('button', {
                  key: 'clear',
                  type: 'button',
                  className: 'ab-pill',
                  onClick: () => setConfirmingClear(true),
                }, t('usage.clear')),
          ),
        ),
      )
    }

    /** One label/control row of the Settings page. */
    function SettingsRow(props) {
      const t = props.t
      const disabled = props.disabled === true
      const button = value => h('button', {
        key: value ? 'on' : 'off',
        type: 'button',
        className: 'ab-pill',
        'aria-pressed': props.value === value,
        disabled,
        onClick: () => { props.onChange(value) },
      }, t(value ? 'settings.on' : 'settings.off'))

      return h('div', { className: 'ab-row' },
        h('span', { className: 'ab-rowLabel', 'data-disabled': disabled ? 'true' : undefined }, props.label),
        h('span', { className: 'ab-rowControl' }, button(true), button(false)),
      )
    }

    /** The Settings page: the display switches, then the usage statistics. */
    function SettingsSection() {
      const ctx = pluginCtx
      const value = useStore(settings)
      const t = ctx === null ? key => key : ctx.locale.bind(NS)

      const rows = [
        { key: 'show', label: t('settings.show'), master: true },
        { key: 'balance', label: t('settings.balance') },
        { key: 'tokens', label: t('settings.tokens') },
        { key: 'duration', label: t('settings.duration') },
        { key: 'rate', label: t('settings.rate') },
      ]

      return h('div', { className: 'ab-page' },
        h('style', { key: 'style' }, CSS),
        h('p', { key: 'intro', className: 'ab-intro' }, t('settings.intro')),
        h('div', { key: 'group', className: 'ab-group' },
          h('h3', { key: 'title', className: 'ab-groupTitle' }, t('settings.group')),
          rows.map(row => h(SettingsRow, {
            key: row.key,
            label: row.label,
            value: value[row.key],
            // The individual switches only matter while the row itself is shown.
            disabled: row.master !== true && value.show !== true,
            onChange: next => settings.set({ [row.key]: next }),
            t,
          })),
        ),
        h('p', { key: 'hint', className: 'ab-hint' }, t('settings.hint')),
        h(UsageSection, { key: 'usage', t }),
        h(StorageSection, { key: 'storage', t }),
      )
    }

    /**
     * Stand-ins for the two slot props that are THEMSELVES hooks.
     *
     * `useProjection` and `useSessionStatus` arrive as props (the shipped
     * `StatsPills` calls them the same way), and a hook may not be called
     * conditionally. Writing `typeof props.useSessionStatus === 'function' ? props
     * .useSessionStatus(...) : false` inside the component does exactly that, and
     * the day the answer changes the hook count changes with it — React aborts the
     * render with "Rendered fewer hooks than expected", blanking the slot.
     *
     * Substituting a constant and calling THAT unconditionally keeps the call
     * count fixed at one whatever the props say, while an assembly without the
     * prop still degrades to "no data" instead of throwing. Module constants, so
     * the identity is stable across renders.
     */
    const NO_SESSION_STATUS = () => false
    const NO_PROJECTION = () => undefined

    function AccountBalance(props) {
      const ctx = pluginCtx
      const settingsValue = useStore(settings)
      const sessionId = props.sessionId

      // The same live flag the shipped Agent-Team panel reads for member activity.
      const useSessionStatus = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : NO_SESSION_STATUS
      const running = useSessionStatus(state => state.get(sessionId)?.running) === true
      const activeMs = useRunningTime(sessionId, running)

      const [state, setState] = React.useState({ phase: 'loading', rows: [], at: 0, error: null, reading: true })
      const alive = React.useRef(true)
      const busy = React.useRef(false)
      const failed = React.useRef(false)

      const refresh = React.useCallback(async () => {
        if (ctx === null || busy.current) return
        busy.current = true
        setState(prev => ({ ...prev, reading: true }))
        try {
          // Read at call time so the metadata carries the language in effect now.
          const client = {
            version: CLIENT_VERSION,
            locale: ctx.locale.getSnapshot().active,
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          }
          const result = await ctx.remote.account.getBalance(client)
          if (!alive.current) return
          if (!result.ok) {
            const failure = result.error
            throw new Error(
              failure !== null && failure !== undefined && typeof failure.message === 'string' && failure.message.length > 0
                ? failure.message
                : 'the account Remote refused the request',
            )
          }
          const model = modelFrom(result.value)
          failed.current = false
          setState({ phase: model.phase, rows: model.rows, at: Date.now(), error: null, reading: false })
        } catch (error) {
          if (!alive.current) return
          failed.current = true
          // Keep the last known figure: a stale balance beats a blank row.
          setState(prev => ({
            ...prev,
            error: error instanceof Error ? error.message : String(error),
            reading: false,
          }))
        } finally {
          busy.current = false
        }
      }, [ctx])

      React.useEffect(() => {
        alive.current = true
        refresh()
        return () => { alive.current = false }
      }, [refresh])

      // Polling loop: a fresh delay each round, so a failure retries sooner.
      React.useEffect(() => {
        let timer = null
        let stopped = false
        const schedule = () => {
          timer = setTimeout(async () => {
            if (stopped) return
            if (typeof document === 'undefined' || !document.hidden) await refresh()
            if (!stopped) schedule()
          }, failed.current ? RETRY_MS : REFRESH_MS)
        }
        schedule()
        return () => {
          stopped = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [refresh])

      // Returning to the page is the cheapest moment to be current again.
      React.useEffect(() => {
        const wake = () => {
          if (typeof document === 'undefined' || !document.hidden) refresh()
        }
        window.addEventListener('focus', wake)
        document.addEventListener('visibilitychange', wake)
        return () => {
          window.removeEventListener('focus', wake)
          document.removeEventListener('visibilitychange', wake)
        }
      }, [refresh])

      const t = ctx === null ? key => key : ctx.locale.bind(NS)
      // The registry pushes these values; there is no subscription of our own.
      // Called unconditionally, through the stand-in when the prop is absent.
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : NO_PROJECTION
      const usage = useProjection('tokenUsage')
      const stats = useProjection('sessionStats')
      const buckets = tokenBuckets(usage)
      const decode = decodeSpan(stats)
      const primary = pickPrimary(state.rows)
      const stale = state.error !== null
      const rate = tokenRate(buckets === null ? null : buckets.total, activeMs)

      // Feed the rolling ledger. The dependencies are the displayed precision,
      // not the raw values: the millisecond clock changes on every render, so
      // keying the effect on it directly would fire continuously. The store
      // notifies only on a real change, so this cannot loop.
      const recordedTokens = buckets === null ? null : buckets.total
      const recordedSeconds = Math.floor(activeMs / 1000)
      // The decode span reports completed spans, so it steps rather than ticking:
      // keying the effect on its two numbers keeps the call off the render clock
      // without dropping a span that lands between two second-boundaries.
      const recordedOutputTokens = decode === null ? null : decode.tokens
      const recordedOutputMs = decode === null ? null : decode.ms
      // Same treatment for the prompt side: both numbers come from one
      // `tokenBuckets` reading, so they move together or not at all.
      const recordedPromptTokens = buckets === null ? null : buckets.input
      const recordedCacheRead = buckets === null ? null : buckets.cacheRead
      React.useEffect(() => {
        usageStore.observeSession(
          sessionId,
          recordedTokens,
          recordedSeconds * 1000,
          recordedOutputTokens === null ? null : { tokens: recordedOutputTokens, ms: recordedOutputMs },
          recordedPromptTokens === null ? null : { input: recordedPromptTokens, cacheRead: recordedCacheRead },
        )
      }, [
        sessionId,
        recordedTokens,
        recordedSeconds,
        recordedOutputTokens,
        recordedOutputMs,
        recordedPromptTokens,
        recordedCacheRead,
      ])

      // Attribute the drop since the previous reading to the same window.
      const balanceCurrency = primary === null ? null : primary.currency
      const balanceUnits = primary === null ? null : primary.total
      React.useEffect(() => {
        if (balanceCurrency === null || balanceUnits === null) return
        usageStore.observeBalance(balanceCurrency, balanceUnits)
      }, [balanceCurrency, balanceUnits])

      let balanceText
      let tone
      const figure = balanceCase(primary, state.phase, stale)
      if (figure === 'value') {
        // Exact, not abbreviated: this band is wide enough, and for money a
        // rounded `¥1.2K` would be a worse answer than `¥1,234.56`.
        balanceText = moneyText(primary.total, symbolOf(primary.currency))
        tone = stale ? 'stale' : 'normal'
      } else if (figure === 'signed-out') {
        balanceText = t('balance.signedOut')
        tone = 'warn'
      } else if (figure === 'unavailable') {
        balanceText = t('balance.unavailable')
        tone = 'warn'
      } else if (figure === 'empty') {
        balanceText = t('balance.empty')
        tone = 'muted'
      } else if (figure === 'error') {
        balanceText = t('balance.error')
        tone = 'error'
      } else {
        balanceText = t('balance.loading')
        tone = 'muted'
      }

      // Nothing to show at all: stay silent rather than render an empty line.
      if (settingsValue.show !== true) return null

      const classes = rowClasses(tone)
      const cells = []

      if (settingsValue.balance === true) {
        cells.push(h('button', {
          key: 'balance',
          type: 'button',
          className: classes.balance,
          'aria-busy': state.reading ? 'true' : undefined,
          onClick: () => { refresh() },
        },
          h('span', { key: 'label', className: 'ab-label' }, t('balance.label')),
          h('span', { key: 'value', className: 'ab-value' }, balanceText),
        ))
      }

      if (settingsValue.tokens === true) {
        cells.push(h('span', { key: 'tokens', className: classes.tokens },
          h('span', { key: 'label', className: 'ab-label' }, t('tokens.label')),
          h('span', { key: 'value', className: 'ab-value' },
            buckets === null ? t('tokens.unavailable') : compactTokens(buckets.total) + ' tok'),
        ))
      }

      if (settingsValue.duration === true) {
        cells.push(h('span', { key: 'duration', className: classes.duration },
          h('span', { key: 'value', className: 'ab-value' }, formatDuration(activeMs)),
        ))
      }

      if (settingsValue.rate === true) {
        cells.push(h('span', { key: 'rate', className: classes.rate },
          h('span', { key: 'value', className: 'ab-value' },
            rate === null ? '—' : compactRate(rate) + ' tok/s'),
        ))
      }

      // Separators exist only between the cells that are actually shown.
      const children = []
      for (const cell of cells) {
        if (children.length > 0) {
          children.push(h('span', { key: 'sep-' + cell.key, className: 'ab-sep', 'aria-hidden': true }, '·'))
        }
        children.push(cell)
      }

      const lines = [t('tip.balanceTitle')]
      if (primary !== null) {
        for (const row of state.rows) {
          const symbol = symbolOf(row.currency)
          const named = state.rows.length > 1
          lines.push('  ' + (named ? row.currency + ' · ' : '') + t('tip.total') + ' ' + moneyText(row.total, symbol))
          if (row.hasRecharge) lines.push('  ' + t('tip.recharge') + ' ' + moneyText(row.recharge, symbol))
          if (row.hasBonus) lines.push('  ' + t('tip.bonus') + ' ' + moneyText(row.bonus, symbol))
        }
        if (state.at > 0) lines.push('  ' + t('tip.updated') + ' ' + new Date(state.at).toLocaleTimeString())
      } else if (state.phase === 'signed-out') {
        lines.push('  ' + t('tip.signedOut'))
      } else if (state.phase === 'ready') {
        // Signed in with nothing readable to report: say so, rather than let the
        // tooltip sit there looking like a read still in flight.
        lines.push('  ' + t('balance.empty'))
      }
      if (stale) lines.push('  ' + t('tip.error') + ': ' + state.error)
      lines.push('  ' + t('tip.hint') + ' · ' + Math.round((stale ? RETRY_MS : REFRESH_MS) / 1000) + 's')

      lines.push('')
      lines.push(t('tip.tokensTitle'))
      if (buckets === null) {
        lines.push('  ' + t('tokens.unavailable'))
      } else {
        lines.push('  ' + t('tip.tokensTotal') + '  ' + exactTokens(buckets.total))
        lines.push('  ' + t('tip.tokensInput') + '  ' + exactTokens(buckets.uncachedInput))
        lines.push('  ' + t('tip.tokensCacheRead') + '  ' + exactTokens(buckets.cacheRead))
        lines.push('  ' + t('tip.tokensCacheWrite') + '  ' + exactTokens(buckets.cacheWrite))
        lines.push('  ' + t('tip.tokensOutput') + '  ' + exactTokens(buckets.output))
        lines.push('  ' + t('tip.tokensNote'))
      }

      lines.push('')
      lines.push(t('tip.timingTitle'))
      lines.push('  ' + (running ? t('tip.runningNow') : t('tip.idleNow')))
      lines.push('  ' + t('tip.durationNote'))
      lines.push('  ' + t('tip.rateNote'))

      return h(React.Fragment, null,
        h('style', { key: 'style' }, CSS),
        h('div', { key: 'root', className: classes.root, title: lines.join('\n') }, children),
      )
    }

    return {
      /**
       * `remote.account` is the shipped account Remote namespace. Declaring it
       * keeps this plugin inactive — rather than crashing the slots — on a
       * composition that has no account controller. Everything else arrives
       * through standard slot props (`useProjection`, `useSessionStatus`), which
       * simply read undefined when their source is absent.
       */
      inject: ['slots', 'locale', 'remote', 'remote.account'],
      apply(ctx) {
        pluginCtx = ctx
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'account-balance: dictionaries')

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'account-balance',
          order: 10,
          label: () => ctx.locale.bind(NS)('aria'),
        }, AccountBalance))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'account-balance',
          // Beside the shipped sections, after Models (10) and theme-studio (12).
          order: 13,
          label: () => ctx.locale.bind(NS)('settings.section'),
        }, SettingsSection))
      },
    }
  },
})

})()
