/**
 * Offline self-test for the account-balance bundle.
 *
 *   node check-bundle.mjs
 *
 * Three layers, and deliberately no more:
 *
 *   1. **Execution** — both halves are imported for real, with only `window`
 *      stubbed for the Client half. That is a syntax check and an activation
 *      check at once: an `export` typo, a stray reference to a missing global,
 *      or a wrong module id all fail here.
 *   2. **Manifest** — the things `install_bundle` and Plugin Manager read
 *      without activating the package: exports targets, the patch row, the
 *      icon budget, the display locale files.
 *   3. **Money math** — the pure helpers are sliced out of `client.js` (the
 *      region above the `__ModuleLoader__.load` call) and exercised directly.
 *      This is where the actual risk lives: sub-cent display, sign handling,
 *      truncation instead of rounding, and the two-wallet merge.
 *
 * What this file cannot establish: that the widget renders correctly in the
 * page. That needs the connected browser, and is checked against the live slot
 * instead (see README "验证").
 */
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..', 'plugin')

let passed = 0
const failures = []

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
  } else {
    failures.push(label + (detail === undefined ? '' : ' — ' + detail))
  }
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(label, a === e, 'got ' + a + ', want ' + e)
}

// ---------------------------------------------------------------- execution

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { loaded = spec },
  },
}

// A stand-in for `localStorage`, declared up here because several sections below
// need it: the per-Session running-time record, the v1 -> v2 migration, the
// storage-footprint panel, and the render smoke test that seeds a known ledger.
// It implements the shape the code actually uses, including `length`/`key`.
const store = new Map()
globalThis.window.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)) },
  removeItem: key => { store.delete(key) },
  key: index => [...store.keys()][index] ?? null,
  get length() { return store.size },
}

const clientPath = join(pkgDir, 'client.js')
const clientSrc = readFileSync(clientPath, 'utf8')

const clientModule = await import(new URL('file:///' + clientPath.replace(/\\/g, '/')).href)
ok('client.js imports cleanly', clientModule !== undefined)
ok('client.js registers exactly one module', loaded !== null, 'no load() call reached the stub')
if (loaded !== null) {
  eq('registered module id equals the package name', loaded.id, pkg.name)
  ok('module exposes a factory', typeof loaded.factory === 'function')
}

const hostModule = await import(new URL('file:///' + join(pkgDir, 'index.js').replace(/\\/g, '/')).href)
ok('index.js imports cleanly', hostModule !== undefined)
ok('host half exports apply()', typeof hostModule.apply === 'function')

// The factory must return a plugin the Loader accepts: inject list + apply.
if (loaded !== null) {
  const reactStub = {
    createElement: () => null,
    Fragment: 'fragment',
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: undefined }),
    useCallback: fn => fn,
  }
  const plugin = loaded.factory(id => {
    if (id === 'react') return reactStub
    throw new Error('unexpected require: ' + id)
  })
  ok('factory returns a plugin with apply()', plugin !== null && typeof plugin.apply === 'function')
  const inject = plugin === null ? [] : plugin.inject
  for (const name of ['slots', 'locale', 'remote', 'remote.account']) {
    ok('plugin injects "' + name + '"', Array.isArray(inject) && inject.includes(name))
  }
}

// ----------------------------------------------------------------- manifest

eq('package name', pkg.name, '@local/account-balance')
ok('package is private', pkg.private === true)
ok('package is an ES module', pkg.type === 'module')
eq('bundle patch path', pkg.dsh?.bundle?.patch, './cordis.patch.yml')
eq('client platform', pkg.dsh?.client?.platform, 'web')
ok('client loads immediately', pkg.dsh?.client?.immediately === true)
ok(
  'client injects the conversation package',
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'),
)

for (const [sub, target] of Object.entries(pkg.exports)) {
  if (target.includes('*')) continue
  const file = join(pkgDir, target.replace(/^\.\//, ''))
  let exists = false
  try { exists = statSync(file).isFile() } catch { exists = false }
  ok('exports "' + sub + '" resolves to a file', exists, file)
}

for (const entry of pkg.files ?? []) {
  if (entry.includes('*')) continue
  const file = join(pkgDir, entry)
  let exists = false
  try { exists = statSync(file).isFile() } catch { exists = false }
  ok('files entry "' + entry + '" exists', exists, file)
}

const iconPath = pkg.icon === undefined ? null : join(pkgDir, pkg.icon.replace(/^\.\//, ''))
if (iconPath === null) {
  ok('manifest declares an icon', false, 'no top-level "icon"')
} else {
  let size = -1
  try { size = statSync(iconPath).size } catch { size = -1 }
  ok('icon exists', size >= 0, iconPath)
  ok('icon is within the 256 KiB budget', size >= 0 && size <= 256 * 1024, String(size) + ' bytes')
  ok(
    'icon has an accepted extension',
    /\.(svg|png|jpe?g|webp)$/i.test(iconPath),
    iconPath,
  )
}

// ------------------------------------------------------------- patch + i18n

const patch = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8')
ok('patch inserts a row', /^\s*-\s*insert:/m.test(patch))
ok('patch row id is account-balance', /id:\s*account-balance\b/.test(patch))
ok('patch row name is the package name', patch.includes("name: '" + pkg.name + "'"))

for (const locale of ['en', 'zh']) {
  const path = join(pkgDir, 'locale', locale + '.json')
  let doc = null
  try { doc = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    failures.push('locale/' + locale + '.json parses — ' + error.message)
  }
  ok('locale/' + locale + '.json has meta.title', typeof doc?.meta?.title === 'string' && doc.meta.title.length > 0)
  ok(
    'locale/' + locale + '.json has meta.description',
    typeof doc?.meta?.description === 'string' && doc.meta.description.length > 0,
  )
}

// -------------------------------------------------------------- money math

// The client half is a CLASSIC script evaluated in the page's global scope, so
// a top-level `const` would become a global lexical binding and a SECOND
// evaluation of the same script in the same realm (a client-HMR revision bump,
// or a re-boot) would die with "Identifier 'X' has already been declared".
// The desktop shell reports that as a fatal "web boot: 1 entry did not
// activate" and exits the whole application, so the file wraps every
// declaration in one IIFE and these assertions keep it that way.
const GUARD_OPEN = ';(function () {'
const GUARD_CLOSE = '})()'
const LOADER_CALL = 'window.__ModuleLoader__.load({'

const guardAt = clientSrc.indexOf(GUARD_OPEN)
const guardEnd = clientSrc.lastIndexOf(GUARD_CLOSE)
const cut = clientSrc.indexOf(LOADER_CALL)

ok('client.js wraps itself in the re-evaluation guard',
  guardAt > 0 && guardEnd > guardAt, 'open @' + guardAt + ', close @' + guardEnd)
ok('the guard encloses the loader call',
  guardAt > 0 && guardEnd > cut, 'close @' + guardEnd + ', loader call @' + cut)
ok('the guard is the last thing in the file',
  clientSrc.slice(guardEnd + GUARD_CLOSE.length).trim() === '',
  JSON.stringify(clientSrc.slice(guardEnd + GUARD_CLOSE.length)))
ok('nothing lexical is declared outside the guard',
  guardAt > 0 && !/^(?:const|let|var|class)\s/m.test(
    clientSrc.slice(0, guardAt) + clientSrc.slice(guardEnd + GUARD_CLOSE.length),
  ),
  'a top-level const/let/var/class would collide on re-evaluation')

ok('client.js has exactly one loader call', cut > 0 && clientSrc.indexOf(LOADER_CALL, cut + 1) === -1)

// The slice below is EXECUTED, but everything inside the factory — every
// component — is only parsed by the browser. Compiling the whole file too means
// a syntax error in the factory fails here instead of blanking a slot in the UI.
let factoryError = ''
try {
  new Function(clientSrc)
} catch (error) {
  factoryError = error.message
}
ok('the whole client.js file parses, factory included', factoryError === '', factoryError)

// The body INSIDE the guard is executed here; the wrapper's own function scope
// is supplied by `new Function` instead, which is what makes the internals
// reachable for the arithmetic assertions below.
const guardedBody = clientSrc.slice(guardAt + GUARD_OPEN.length, guardEnd)

const H = new Function(
  guardedBody
  + '\nreturn { NS, REFRESH_MS, RETRY_MS, symbolOf, parseMoney, moneyText,'
  + ' modelFrom, pickPrimary, group, walletTotals, balanceCase,'
  + ' tokenBuckets, compactTokens, exactTokens, rowClasses, CSS, zh, en,'
  + ' DEFAULT_SETTINGS, SETTINGS_KEY, DURATION_KEY_PREFIX, normalizeSettings,'
  + ' compactRate, formatDuration, tokenRate, cacheHitRate, percentText,'
  + ' readDuration, writeDuration,'
  + ' USAGE_KEY, USAGE_KEY_LEGACY, emptyLedger, normalizeLedger, BUCKET_PATTERN,'
  + ' bucketKey, recordSession, recordBalance, bucketEntries, creditTokens,'
  + ' moneyPerTokens, chartGeometry, decodeSpan, growth, fill, HOUR_LABELS,'
  + ' hourDays, hourRangeEntries, seriesTotal, maybeAmount, migrateLedger, readLedger, writeLedger,'
  + ' ownedGroup, entryBytes, storageFootprint, formatBytes, quotaShare,'
  + ' STORAGE_GROUPS, STORAGE_QUOTA_BYTES, CHART_DOT_LIMIT, ledgerWriteFailed }',
)()

eq('locale namespace', H.NS, 'account-balance')
ok('refresh interval is a positive number', Number.isFinite(H.REFRESH_MS) && H.REFRESH_MS > 0)
ok('retry interval is shorter than the refresh interval', H.RETRY_MS < H.REFRESH_MS)

eq('symbolOf CNY', H.symbolOf('CNY'), '¥')
eq('symbolOf USD', H.symbolOf('USD'), '$')

// Exact integer carry: 1/10000 units, so sums never drift.
eq('parse 12.34', H.parseMoney('12.34'), 123400)
eq('parse 0', H.parseMoney('0'), 0)
eq('parse 1.2', H.parseMoney('1.2'), 12000)
eq('parse 1.239 keeps four digits', H.parseMoney('1.239'), 12390)
eq('parse 0.005 is a real sub-cent value', H.parseMoney('0.005'), 50)
eq('parse -0.005 keeps the sign', H.parseMoney('-0.005'), -50)
eq('parse -0.00 is zero', H.parseMoney('-0.00'), 0)
eq('parse -3.50', H.parseMoney('-3.50'), -35000)
eq('parse 007', H.parseMoney('007'), 70000)
eq('parse trims whitespace', H.parseMoney(' 4.20 '), 42000)
eq('parse truncates past four digits', H.parseMoney('0.00005'), 0)
eq('parse rejects empty', H.parseMoney(''), null)
eq('parse rejects text', H.parseMoney('abc'), null)
eq('parse rejects grouped input', H.parseMoney('1,234.56'), null)
eq('parse rejects a bare dot', H.parseMoney('.'), null)
eq('parse rejects a number', H.parseMoney(12.34), null)
eq('parse rejects exponent form', H.parseMoney('1e3'), null)
eq('parse rejects a trailing sign', H.parseMoney('12-'), null)

eq('group two decimals', H.group(1234), '12.34')
eq('group pads cents', H.group(5), '0.05')
eq('group separates thousands', H.group(123456), Number(1234).toLocaleString() + '.56')

// Display: truncation toward zero, and the shipped sub-cent rules.
eq('format 12.34', H.moneyText(123400, '¥'), '¥12.34')
eq('format thousands', H.moneyText(12343400, '¥'), '¥' + Number(1234).toLocaleString() + '.34')
eq('format zero', H.moneyText(0, '¥'), '¥0.00')
eq('format sub-cent', H.moneyText(50, '¥'), '<¥0.01')
eq('format negative sub-cent', H.moneyText(-50, '¥'), '-¥0.01')
eq('format negative', H.moneyText(-35000, '¥'), '-¥3.50')
eq('format five cents', H.moneyText(500, '¥'), '¥0.05')
eq('format truncates a negative instead of rounding up', H.moneyText(-150, '¥'), '-¥0.01')
eq('format an unreadable amount', H.moneyText(null, '¥'), '¥—')
eq('format with no symbol keeps the number', H.moneyText(123400, ''), '12.34')

// The wallet merge: `value` is topped-up, `bonusWallets` is granted.
const signedOut = H.modelFrom(null)
eq('null balance reads as signed out', signedOut.phase, 'signed-out')
eq('signed out carries no rows', signedOut.rows.length, 0)

const failed = H.modelFrom({ status: 'failed' })
eq('failed status reads as unavailable', failed.phase, 'unavailable')
eq('unavailable carries no rows', failed.rows.length, 0)

const ready = H.modelFrom({
  status: 'ready',
  value: [{ currency: 'CNY', balance: '10.00' }],
  bonusWallets: [{ currency: 'CNY', balance: '2.50' }],
})
eq('ready status', ready.phase, 'ready')
eq('one currency row', ready.rows.length, 1)
eq('total sums topped-up and granted', H.moneyText(ready.rows[0].total, '¥'), '¥12.50')
eq('topped-up part', H.moneyText(ready.rows[0].recharge, '¥'), '¥10.00')
eq('granted part', H.moneyText(ready.rows[0].bonus, '¥'), '¥2.50')
eq('both halves are flagged present', [ready.rows[0].hasRecharge, ready.rows[0].hasBonus], [true, true])

const multi = H.modelFrom({
  status: 'ready',
  value: [
    { currency: 'USD', balance: '1.00' },
    { currency: 'CNY', balance: '20.00' },
    { currency: 'CNY', balance: '5.00' },
  ],
  bonusWallets: [],
})
eq('one row per currency', multi.rows.length, 2)
eq('same-currency wallets merge', H.moneyText(multi.rows[1].total, '¥'), '¥25.00')
eq('CNY is headlined when present', H.pickPrimary(multi.rows).currency, 'CNY')
eq('USD keeps its own symbol', H.symbolOf(multi.rows[0].currency), '$')
eq('no granted wallet leaves the flag false', multi.rows[0].hasBonus, false)

const subCent = H.modelFrom({
  status: 'ready',
  value: [{ currency: 'CNY', balance: '0.005' }],
  bonusWallets: [],
})
eq('a lone sub-cent wallet stays below one cent', H.moneyText(subCent.rows[0].total, '¥'), '<¥0.01')

// Two half-cent residues must add up to a whole cent. Truncating each wallet
// before summing would show ¥0.00 here and silently lose the cent.
const carried = H.modelFrom({
  status: 'ready',
  value: [{ currency: 'CNY', balance: '0.005' }],
  bonusWallets: [{ currency: 'CNY', balance: '0.005' }],
})
eq('sub-cent residues carry into a whole cent', H.moneyText(carried.rows[0].total, '¥'), '¥0.01')

const usdOnly = H.modelFrom({ status: 'ready', value: [{ currency: 'USD', balance: '3.50' }], bonusWallets: [] })
eq('USD-only falls back to the first row', H.pickPrimary(usdOnly.rows).currency, 'USD')

const emptyWallets = H.modelFrom({ status: 'ready', value: [], bonusWallets: [] })
eq('ready with no wallets has no rows', emptyWallets.rows.length, 0)
eq('no rows means no headline', H.pickPrimary(emptyWallets.rows), null)

const missingLists = H.modelFrom({ status: 'ready' })
eq('a payload without wallet arrays is tolerated', missingLists.rows.length, 0)

const malformed = H.modelFrom({ status: 'ready', value: [{ currency: 'CNY', balance: 'n/a' }, null], bonusWallets: [] })
eq('unparsable wallets are dropped', malformed.rows.length, 0)

const defaultCurrency = H.modelFrom({ status: 'ready', value: [{ balance: '1.00' }], bonusWallets: [] })
eq('a wallet without a currency defaults to CNY', defaultCurrency.rows[0].currency, 'CNY')

// Every branch of the balance cell, including the one that used to be swallowed
// by the chain's final `else`: signed in, still 'ready', and no wallet left after
// the unreadable ones were dropped. Unknown phases (nothing read yet) must stay
// "loading", and a failure must outrank "empty".
eq('a readable wallet shows its figure', H.balanceCase(ready.rows[0], 'ready', false), 'value')
eq('a stale read still shows the figure', H.balanceCase(ready.rows[0], 'ready', true), 'value')
eq('a signed-out account says so', H.balanceCase(null, 'signed-out', false), 'signed-out')
eq('an unavailable balance says so', H.balanceCase(null, 'unavailable', false), 'unavailable')
eq('ready with nothing readable is its own case', H.balanceCase(null, 'ready', false), 'empty')
eq('ready with nothing readable and a failed read still says empty', H.balanceCase(null, 'ready', true), 'empty')
eq('an unknown phase is still loading', H.balanceCase(null, undefined, false), 'loading')
eq('a failed first read is an error, not loading', H.balanceCase(null, 'loading', true), 'error')
eq('a missing primary is tolerated', H.balanceCase(undefined, 'ready', false), 'empty')
// The chain this replaced ended in a default, so the two states it swallowed are
// the ones worth naming: an empty wallet list and an unparsable one.
eq('an empty wallet list reaches the empty case', H.balanceCase(H.pickPrimary(H.modelFrom({ status: 'ready', value: [], bonusWallets: [] }).rows), 'ready', false), 'empty')
eq('an unparsable wallet list reaches the empty case',
  H.balanceCase(H.pickPrimary(H.modelFrom({ status: 'ready', value: [{ currency: 'CNY', balance: '' }], bonusWallets: [] }).rows), 'ready', false), 'empty')

// ---------------------------------------------------------- token buckets

// This is the shape the shipped `tokenUsage` projection publishes; the four
// buckets are disjoint, so the conversation total is their sum.
eq('an absent projection reads as null', H.tokenBuckets(undefined), null)
eq('a null projection reads as null', H.tokenBuckets(null), null)

const usage = H.tokenBuckets({
  uncachedInputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 900,
  cacheWriteTokens: 10,
})
eq('uncached input is carried through', usage.uncachedInput, 100)
eq('cache read is carried through', usage.cacheRead, 900)
eq('cache write is carried through', usage.cacheWrite, 10)
eq('output is carried through', usage.output, 50)
eq('the input side sums the three prompt buckets', usage.input, 1010)
eq('the total sums all four disjoint buckets', usage.total, 1060)

const emptyUsage = H.tokenBuckets({})
eq('an all-empty reading is zero, not null', emptyUsage.total, 0)
eq('a zero reading keeps every bucket', [emptyUsage.input, emptyUsage.output], [0, 0])

const dirtyUsage = H.tokenBuckets({
  uncachedInputTokens: -5,
  outputTokens: Number.NaN,
  cacheReadTokens: undefined,
  cacheWriteTokens: 3.7,
})
eq('negative and NaN counts clamp to zero', [dirtyUsage.uncachedInput, dirtyUsage.output, dirtyUsage.cacheRead], [0, 0, 0])
eq('a fractional count is rounded', dirtyUsage.cacheWrite, 4)

// The decode span is the OUTPUT side alone. Both terms come from the same
// instrument — the provider's own stream-to-assembled-message timing — so their
// quotient is a real writing speed rather than a share of the conversation clock.
eq('an absent sessionStats reads as null', H.decodeSpan(undefined), null)
eq('a null sessionStats reads as null', H.decodeSpan(null), null)
eq('an empty sessionStats reads as a zero span', H.decodeSpan({}), { tokens: 0, ms: 0 })
eq('the decode span carries both terms', H.decodeSpan({ decodeTokens: 800, decodeMs: 4000 }), { tokens: 800, ms: 4000 })
eq('a fractional decode count is rounded', H.decodeSpan({ decodeTokens: 3.7 }).tokens, 4)
eq('a negative decode time clamps to zero', H.decodeSpan({ decodeMs: -5 }).ms, 0)
eq('the decode span ignores the input side', Object.keys(H.decodeSpan({ uncachedInputTokens: 900, decodeTokens: 1, decodeMs: 1000 })).sort(),
  ['ms', 'tokens'])

// Token formatting: compact inline, exact in the tooltip.
eq('compact zero', H.compactTokens(0), '0')
eq('compact hundreds', H.compactTokens(517), '517')
eq('compact thousands', H.compactTokens(12200), '12.2K')
eq('compact just over a thousand', H.compactTokens(1000), '1.0K')
eq('compact millions', H.compactTokens(1200000), '1.2M')
eq('compact rejects a non-number', H.compactTokens(Number.NaN), '0')
eq('exact thousands', H.exactTokens(12345), (12345).toLocaleString())
eq('exact rejects a non-number', H.exactTokens(Number.NaN), '—')

// ------------------------------------------------------- duration and rate

eq('zero duration', H.formatDuration(0), '0s')
eq('a sub-second duration floors to zero', H.formatDuration(999), '0s')
eq('one second', H.formatDuration(1000), '1s')
eq('seconds only', H.formatDuration(45000), '45s')
eq('a whole minute still shows seconds', H.formatDuration(60000), '1m00s')
eq('minutes pad the seconds', H.formatDuration(125000), '2m05s')
eq('an hour switches unit and drops seconds', H.formatDuration(3600000), '1h00m')
eq('hours pad the minutes', H.formatDuration(3720000), '1h02m')
eq('a non-number reads as zero', H.formatDuration(Number.NaN), '0s')
eq('a negative duration reads as zero', H.formatDuration(-5000), '0s')

// The rate needs BOTH terms; a missing one must not fabricate a number.
eq('no rate without tokens', H.tokenRate(0, 5000), null)
eq('no rate while the token total is unavailable', H.tokenRate(null, 5000), null)
eq('no rate without measured running time', H.tokenRate(1000, 0), null)
eq('no rate below one measured second', H.tokenRate(1000, 500), null)
eq('no rate from a non-finite duration', H.tokenRate(1000, Number.POSITIVE_INFINITY), null)
eq('one second of one thousand tokens', H.tokenRate(1000, 1000), 1000)
eq('ten thousand tokens over two seconds', H.tokenRate(10000, 2000), 5000)
eq('a slow average keeps its fraction', H.tokenRate(700, 60000), 700 / 60)

// The inline rate stays readable at both ends of its range.
eq('compact rate zero', H.compactRate(0), '0')
eq('compact rate below ten keeps a decimal', H.compactRate(0.4), '0.4')
eq('compact rate rounds to one decimal', H.compactRate(9.54), '9.5')
eq('compact rate at ten switches to the whole number', H.compactRate(12), '12')
eq('compact rate in the thousands', H.compactRate(1500), '1.5K')
eq('compact rate rejects a non-number', H.compactRate(Number.NaN), '0')

// A rate is a quotient, a token count is an integer, and the count formatter is
// only correct for one of them. Every value in the band between ten and a
// thousand used to be a whole number in this file, which is exactly why reusing
// `compactTokens` here looked fine: the moment a real rate landed in that band the
// row printed the division in full, sixteen decimals and all.
eq('a fractional rate in the tens is rounded, not printed raw', H.compactRate(1000 / 60), '17')
eq('a fractional rate in the hundreds is rounded', H.compactRate(123.456), '123')
eq('a rate just under a thousand stays plain', H.compactRate(999.4), '999')
eq('a rate that rounds up to a thousand keeps the plain form', H.compactRate(999.6), '1000')
eq('a rate at a thousand switches to the compact form', H.compactRate(1000), '1.0K')
eq('no rate text carries a long fraction', /\d+\.\d{4,}/.test(H.compactRate(1000 / 60)), false)
eq('no rate text carries a long fraction in the thousands', /\d+\.\d{4,}/.test(H.compactRate(1234.5678)), false)
eq('a token count is still printed raw below a thousand', H.compactTokens(16.67), '16.67')

// --------------------------------------------------------------- preferences

eq('preference keys are stable', Object.keys(H.DEFAULT_SETTINGS).sort(), ['balance', 'duration', 'rate', 'show', 'tokens'])
ok('every default is a boolean', Object.values(H.DEFAULT_SETTINGS).every(value => typeof value === 'boolean'))
ok('the settings key is namespaced and non-empty', H.SETTINGS_KEY.startsWith('dsh.'), H.SETTINGS_KEY)
ok('the duration key is namespaced and non-empty', H.DURATION_KEY_PREFIX.startsWith('dsh.'), H.DURATION_KEY_PREFIX)
ok('the two storage keys differ', H.SETTINGS_KEY !== H.DURATION_KEY_PREFIX)

eq('a corrupt settings document falls back to the defaults', H.normalizeSettings(null), H.DEFAULT_SETTINGS)
eq('a non-object document falls back to the defaults', H.normalizeSettings('nope'), H.DEFAULT_SETTINGS)
eq('an unknown key is dropped', H.normalizeSettings({ junk: true }), H.DEFAULT_SETTINGS)
eq('a wrongly typed field is dropped', H.normalizeSettings({ show: 'yes' }), H.DEFAULT_SETTINGS)
eq(
  'a valid field survives alongside junk',
  H.normalizeSettings({ balance: false, junk: 1, tokens: 'no' }),
  { ...H.DEFAULT_SETTINGS, balance: false },
)
eq('a complete document is preserved', H.normalizeSettings({
  show: false, balance: false, tokens: false, duration: false, rate: false,
}), { show: false, balance: false, tokens: false, duration: false, rate: false })

// Every declared preference needs a Settings row, and every row needs a
// preference: a mismatch means a switch that silently does nothing, or a stored
// value the user can never reach.
const rowKeys = [...clientSrc.matchAll(/\{ key: '([a-zA-Z]+)', label: t\('settings\.[a-zA-Z]+'\)/g)].map(m => m[1])
eq('the Settings page covers every preference exactly once', rowKeys.sort(), Object.keys(H.DEFAULT_SETTINGS).sort())

// ------------------------------------------------------------- usage ledger

// Local-time construction on both sides keeps these assertions timezone-proof.
const at = (y, mo, d, h) => new Date(y, mo - 1, d, h, 30, 0).getTime()
const T14 = at(2026, 3, 9, 14)
const T15 = at(2026, 3, 9, 15)

eq('hour bucket key', H.bucketKey('hour', T14), '2026-03-09T14')
eq('day bucket key', H.bucketKey('day', T14), '2026-03-09')
eq('month bucket key', H.bucketKey('month', T14), '2026-03')
const padded = at(2026, 1, 5, 9)
eq('hour key zero-pads', H.bucketKey('hour', padded), '2026-01-05T09')
eq('day key zero-pads', H.bucketKey('day', padded), '2026-01-05')
eq('month key zero-pads', H.bucketKey('month', padded), '2026-01')

// Bucket keys must sort chronologically as plain strings — pruning and the
// chart both rely on that instead of parsing dates.
const sorted = [
  H.bucketKey('hour', at(2026, 3, 9, 9)),
  H.bucketKey('hour', at(2026, 3, 9, 14)),
  H.bucketKey('hour', at(2026, 3, 10, 2)),
  H.bucketKey('hour', at(2026, 11, 1, 2)),
]
eq('bucket keys sort chronologically', [...sorted].sort(), sorted)

// Retention is unlimited, so nothing is dropped for being old — which leaves key
// VALIDATION as the only thing keeping a stored map from filling with junk.
const storedBuckets = H.normalizeLedger({
  hours: {
    '2026-03-09T14': { t: 5, s: 0 },
    '2019-01-01T00': { t: 1, s: 0 },
    '2026-03-09': { t: 9, s: 0 },
    '2026-03-09T14:00': { t: 9, s: 0 },
    'nonsense': { t: 9, s: 0 },
    '2026-3-9T14': { t: 9, s: 0 },
  },
  days: { '2026-03-09': { t: 5, s: 0 }, '2026-03': { t: 9, s: 0 }, 'x': { t: 9, s: 0 } },
  months: { '2026-03': { t: 5, s: 0 }, '2026-03-09': { t: 9, s: 0 } },
})
eq('an old bucket is kept, because nothing is pruned', Object.hasOwn(storedBuckets.hours, '2019-01-01T00'), true)
eq('only hour-shaped keys survive in the hour map', Object.keys(storedBuckets.hours).sort(), ['2019-01-01T00', '2026-03-09T14'])
eq('only day-shaped keys survive in the day map', Object.keys(storedBuckets.days), ['2026-03-09'])
eq('only month-shaped keys survive in the month map', Object.keys(storedBuckets.months), ['2026-03'])
eq('the hour pattern rejects a day key', H.BUCKET_PATTERN.hours.test('2026-03-09'), false)
eq('the hour pattern rejects an unpadded hour', H.BUCKET_PATTERN.hours.test('2026-3-9T14'), false)
eq('the day pattern rejects an hour key', H.BUCKET_PATTERN.days.test('2026-03-09T14'), false)
eq('the month pattern rejects a day key', H.BUCKET_PATTERN.months.test('2026-03-09'), false)
eq('every rollup has a pattern', Object.keys(H.BUCKET_PATTERN).sort(), ['days', 'hours', 'months'])

// The FIRST reading of a Session is a baseline, exactly like the balance's. The
// projections are whole-log cumulative values, so crediting the first one would
// book a conversation's entire history to the moment the plugin happened to open
// it — history the money column, which can only start observing now, can never
// match. That mismatch is what made "money per million tokens" meaningless, so
// every ledger assertion below establishes a baseline before measuring growth.
let ledger = H.emptyLedger()
ledger = H.recordSession(ledger, 's1', 100, 5000, T14)
eq('a first reading credits no tokens', ledger.tokens, 0)
eq('a first reading credits no running time', ledger.activeMs, 0)
eq('a first reading is remembered as the baseline', [ledger.seen.s1.tokens, ledger.seen.s1.ms], [100, 5000])
eq('a first reading opens no bucket', Object.keys(ledger.hours).length, 0)
ok('a first reading is still written, so the baseline survives a reload', ledger.seen.s1.tokens === 100)

// A baseline credits nothing, and must not leave an empty bucket behind either:
// the chart would draw a zero point for a period in which nothing was consumed.
const seededBuckets = { '2026-03-09T14': { t: 5, s: 0 } }
ok('a zero delta returns the same bucket map', H.creditTokens(seededBuckets, '2026-03-09T15', 0) === seededBuckets)
ok('a negative delta returns the same bucket map', H.creditTokens(seededBuckets, '2026-03-09T15', -5) === seededBuckets)
eq('a positive delta opens the bucket', H.creditTokens(seededBuckets, '2026-03-09T15', 7)['2026-03-09T15'], { t: 7, s: 0 })
ok('crediting does not mutate the map it was given', seededBuckets['2026-03-09T15'] === undefined)
eq('crediting keeps an old bucket alongside the new one',
  Object.keys(H.creditTokens({ '2019-01-01T00': { t: 1, s: 0 } }, '2026-03-09T15', 7)).sort(),
  ['2019-01-01T00', '2026-03-09T15'])

ledger = H.recordSession(ledger, 's1', 250, 9000, T14)
eq('growth after the baseline is credited', ledger.tokens, 150)
eq('time growth after the baseline is credited', ledger.activeMs, 4000)
eq('the hour bucket holds only the credited delta', ledger.hours['2026-03-09T14'], { t: 150, s: 0 })
eq('the day bucket holds only the credited delta', ledger.days['2026-03-09'], { t: 150, s: 0 })
eq('the month bucket holds only the credited delta', ledger.months['2026-03'], { t: 150, s: 0 })

ok('an unchanged reading returns the same ledger', H.recordSession(ledger, 's1', 250, 9000, T14) === ledger)
ok('a missing reading changes nothing', H.recordSession(ledger, 's1', null, null, T14) === ledger)

ledger = H.recordSession(ledger, 's2', 50, 1000, T14)
eq('a second conversation opens with its own baseline', ledger.tokens, 150)
eq('a second conversation adds no running time yet', ledger.activeMs, 4000)

const both = H.recordSession(ledger, 's2', 150, 2000, T15)
eq('a later reading credits only that session growth', both.tokens - ledger.tokens, 100)
eq('the growth lands in the later hour', both.hours['2026-03-09T15'], { t: 100, s: 0 })
eq('the earlier hour keeps its own total', both.hours['2026-03-09T14'], { t: 150, s: 0 })

// A conversation whose counter resets (fork, projection reset) must not be read
// as a negative delta — that would silently shrink history that really happened
// — but it must re-base, or the stale high-water mark would swallow every later
// increase and the ledger would sit still while usage kept growing.
const lowered = H.recordSession(both, 's1', 10, 100, T15)
eq('a lower reading never subtracts tokens', lowered.tokens, both.tokens)
eq('a lower reading never subtracts time', lowered.activeMs, both.activeMs)
eq('a lower reading re-bases the memory', lowered.seen.s1, {
  tokens: 10,
  ms: 100,
  outputTokens: null,
  outputMs: null,
  inputTokens: null,
  cacheReadTokens: null,
})

const recovered = H.recordSession(lowered, 's1', 60, 300, T15)
eq('growth after a reset is credited again', recovered.tokens - lowered.tokens, 50)
eq('time after a reset is credited again', recovered.activeMs - lowered.activeMs, 200)

// The two counters re-base independently: a token reset must not discard real
// running time that arrived in the same reading.
const half = H.recordSession(both, 's1', 10, 12000, T15)
eq('a token reset still credits new running time', half.activeMs - both.activeMs, 3000)
eq('a token reset credits no tokens', half.tokens, both.tokens)

// The re-base rule, asserted on the counter itself: this is the one place the
// four-counter fold can silently lose history, so it is pinned directly.
eq('growth credits the increase', H.growth(10, 25), { value: 25, added: 15 })
eq('growth of an unchanged reading is zero', H.growth(10, 10), { value: 10, added: 0 })
eq('growth re-bases a decrease instead of crediting a negative', H.growth(10, 4), { value: 4, added: 0 })
eq('a null reading keeps the remembered value', H.growth(10, null), { value: 10, added: 0 })
eq('an undefined reading keeps the remembered value', H.growth(10, undefined), { value: 10, added: 0 })
eq('a dirty reading clamps to zero and re-bases', H.growth(10, Number.NaN), { value: 0, added: 0 })
eq('growth still credits after a re-base', H.growth(4, 9).added, 5)

// No baseline yet: adopt the reading and credit NOTHING. This is the fix, so it
// is asserted on the counter and not only through the fold.
eq('a first reading is adopted without credit', H.growth(null, 60000000), { value: 60000000, added: 0 })
eq('a genuine zero first reading is still a baseline', H.growth(null, 0), { value: 0, added: 0 })
eq('an absent first reading stays unknown', H.growth(null, null), { value: null, added: 0 })
eq('an undefined first reading stays unknown', H.growth(null, undefined), { value: null, added: 0 })
eq('a dirty first reading becomes unknown, not zero', H.growth(null, Number.NaN), { value: null, added: 0 })
eq('a negative first reading becomes unknown', H.growth(null, -5), { value: null, added: 0 })
eq('growth after a baseline is credited', H.growth(60000000, 60000200).added, 200)

// The case the null-unknown marker exists for: the dock can render once before
// `tokenUsage` is published. Without the marker that render would baseline the
// session at 0, and the projection's arrival would credit its entire log.
const lateFirst = H.recordSession(H.emptyLedger(), 'late', null, 0, T14)
eq('a session read before its projection is memorized as unknown', lateFirst.seen.late.tokens, null)
const lateArrived = H.recordSession(lateFirst, 'late', 60000000, 1000, T14)
eq('the late projection is a baseline, not a pile of history', lateArrived.tokens, 0)
eq('growth after the late baseline is credited normally', H.recordSession(lateArrived, 'late', 60000050, 1000, T14).tokens, 50)

// The provider's decode span rides along in the SAME reading, with its own
// memory and its own re-base: a token reset must not eat it, and an absent
// sessionStats must not zero it.
const D1 = { tokens: 400, ms: 2000 }
const D2 = { tokens: 900, ms: 5000 }
let decodeLedger = H.emptyLedger()
eq('a new ledger counts no output yet', [decodeLedger.outputTokens, decodeLedger.outputMs], [0, 0])
decodeLedger = H.recordSession(decodeLedger, 's1', 100, 5000, T14, D1)
eq('a first decode reading credits nothing', [decodeLedger.outputTokens, decodeLedger.outputMs], [0, 0])
eq('the first decode span is remembered per session', [decodeLedger.seen.s1.outputTokens, decodeLedger.seen.s1.outputMs], [400, 2000])

decodeLedger = H.recordSession(decodeLedger, 's1', 250, 9000, T14, D2)
eq('the decode tokens accumulate from the baseline', decodeLedger.outputTokens, 500)
eq('the decode time accumulates from the baseline', decodeLedger.outputMs, 3000)
ok('an unchanged four-counter reading returns the same ledger',
  H.recordSession(decodeLedger, 's1', 250, 9000, T14, D2) === decodeLedger)

// This is why "not published yet" must mean "keep the memory": reading an absent
// projection as an empty span would credit nothing now and then re-credit the
// whole span on the next push, because the high-water mark had been thrown away.
const noStats = H.recordSession(decodeLedger, 's1', 300, 10000, T14)
eq('an absent sessionStats keeps the measured span', noStats.outputTokens, decodeLedger.outputTokens)
eq('an absent sessionStats still credits conversation tokens', noStats.tokens - decodeLedger.tokens, 50)
eq('the next push does not re-credit a span it already counted',
  H.recordSession(noStats, 's1', 300, 10000, T15, D2).outputTokens, decodeLedger.outputTokens)

// A decode counter that resets re-bases on its own, leaving the other three alone.
const decodeReset = H.recordSession(decodeLedger, 's1', 250, 9000, T15, { tokens: 10, ms: 100 })
eq('a decode reset never subtracts', decodeReset.outputTokens, decodeLedger.outputTokens)
eq('a decode reset re-bases the memory', [decodeReset.seen.s1.outputTokens, decodeReset.seen.s1.outputMs], [10, 100])
eq('a decode reset leaves the conversation total alone', decodeReset.tokens, decodeLedger.tokens)
const decodeRegrown = H.recordSession(decodeReset, 's1', 400, 20000, T15, { tokens: 60, ms: 1100 })
eq('decode tokens after a reset are credited again', decodeRegrown.outputTokens - decodeReset.outputTokens, 50)
eq('decode time after a reset is credited again', decodeRegrown.outputMs - decodeReset.outputMs, 1000)

// The prompt-side pair rides along in the same reading, with its own memory and
// its own re-base. `null` is passed for the decode span here on purpose: only one
// of the two extra readings is at hand, and that must be enough.
const P1 = { input: 1000, cacheRead: 800 }
const P2 = { input: 2500, cacheRead: 2100 }
let promptLedger = H.emptyLedger()
eq('a new ledger counts no prompt side yet', [promptLedger.inputTokens, promptLedger.cacheReadTokens], [0, 0])
promptLedger = H.recordSession(promptLedger, 's1', 50000, 5000, T14, null, P1)
eq('a first prompt reading credits nothing', [promptLedger.inputTokens, promptLedger.cacheReadTokens], [0, 0])
eq('the first prompt reading is remembered', [promptLedger.seen.s1.inputTokens, promptLedger.seen.s1.cacheReadTokens], [1000, 800])
eq('passing no decode span does not invent one', [promptLedger.seen.s1.outputTokens, promptLedger.seen.s1.outputMs], [null, null])
eq('the conversation baseline still applies alongside it', promptLedger.tokens, 0)

promptLedger = H.recordSession(promptLedger, 's1', 50100, 5000, T14, null, P2)
eq('the prompt side grows by its own delta', [promptLedger.inputTokens, promptLedger.cacheReadTokens], [1500, 1300])
eq('the pair divides into the rate the row shows',
  H.percentText(H.cacheHitRate(promptLedger.cacheReadTokens, promptLedger.inputTokens)), '87%')

// An absent prompt reading must not zero the pair — the same rule the decode span
// follows, and the reason the rate survives a render before tokenUsage lands.
const noPrompt = H.recordSession(promptLedger, 's1', 50200, 5000, T14)
eq('an absent prompt reading keeps the pair', [noPrompt.inputTokens, noPrompt.cacheReadTokens], [1500, 1300])
eq('an absent prompt reading still credits tokens', noPrompt.tokens - promptLedger.tokens, 100)

// A prompt counter that resets re-bases on its own, leaving the rest alone.
const promptReset = H.recordSession(promptLedger, 's1', 50100, 5000, T15, null, { input: 100, cacheRead: 10 })
eq('a prompt reset never subtracts', [promptReset.inputTokens, promptReset.cacheReadTokens], [1500, 1300])
eq('a prompt reset re-bases both halves', [promptReset.seen.s1.inputTokens, promptReset.seen.s1.cacheReadTokens], [100, 10])
const promptRegrown = H.recordSession(promptReset, 's1', 50300, 5000, T15, null, { input: 400, cacheRead: 310 })
eq('the prompt side grows again after a reset',
  [promptRegrown.inputTokens - promptReset.inputTokens, promptRegrown.cacheReadTokens - promptReset.cacheReadTokens], [300, 300])
eq('a fully cached pair reads as one hundred', H.percentText(H.cacheHitRate(300, 300)), '100%')

// The prompt pair can also arrive after the dock's first render, and the same
// baseline rule has to hold or its whole log lands at once.
const latePrompt = H.recordSession(H.emptyLedger(), 'late', 60000000, 0, T14, null, null)
eq('a session seen before its prompt side is memorized as unknown',
  [latePrompt.seen.late.inputTokens, latePrompt.seen.late.cacheReadTokens], [null, null])
const promptArrived = H.recordSession(latePrompt, 'late', 60000000, 0, T14, null, { input: 900000, cacheRead: 800000 })
eq('the late prompt reading is a baseline, not a pile of history',
  [promptArrived.inputTokens, promptArrived.cacheReadTokens], [0, 0])
eq('growth after the late prompt baseline is credited',
  H.recordSession(promptArrived, 'late', 60000000, 0, T14, null, { input: 901000, cacheRead: 800500 }).cacheReadTokens, 500)

// The output rate needs both decode terms, and reuses the total rate's guards:
// no tokens or no measured span means no average, never a division spike.
eq('no output rate without output tokens', H.tokenRate(0, 4000), null)
eq('no output rate without a measured span', H.tokenRate(900, 0), null)
eq('no output rate from a sub-second span', H.tokenRate(900, 999), null)
eq('the output rate divides the decode span', H.tokenRate(900, 3000), 300)
eq('a longer decode span lowers the output rate', H.tokenRate(900, 6000), 150)

// ---------------------------------------------------- cache hit rate
//
// The composer's own pill computes `cacheReadTokens / billedInputTokens` from the
// tokenUsage projection, where billedInputTokens is uncached input plus both
// cache buckets — output excluded. The ledger's average must be that same
// quantity, so the definition is pinned against the shipped one rather than
// restated. `tokenBuckets().input` is the ledger's name for it.
const shippedBuckets = H.tokenBuckets({
  uncachedInputTokens: 200,
  cacheReadTokens: 800,
  cacheWriteTokens: 50,
  outputTokens: 5000,
})
eq('the ledger prompt side IS the shipped billed-input side', shippedBuckets.input, 200 + 800 + 50)
eq('output tokens are outside the prompt side', shippedBuckets.input < shippedBuckets.total, true)
eq('the shipped rate is cacheRead over that side', H.cacheHitRate(800, shippedBuckets.input), (800 / 1050) * 100)
eq('an 800-of-1050 prompt is 76%', H.percentText(H.cacheHitRate(800, shippedBuckets.input)), '76%')

eq('no prompt side means no rate', H.cacheHitRate(0, 0), null)
eq('a negative prompt side means no rate', H.cacheHitRate(10, -5), null)
eq('an unreadable prompt side means no rate', H.cacheHitRate(10, Number.NaN), null)
eq('a prompt side with no hits is a real zero percent', H.cacheHitRate(0, 1000), 0)
eq('an unreadable hit count is a real zero percent', H.cacheHitRate(Number.NaN, 1000), 0)
eq('a full hit is one hundred', H.cacheHitRate(1000, 1000), 100)
eq('a rate never exceeds one hundred', H.cacheHitRate(5000, 1000), 100)
eq('half the prompt cached is fifty percent', H.cacheHitRate(500, 1000), 50)

// The display must never round UP to a full hit that did not happen.
eq('a whole percent drops the decimal', H.percentText(88.42), '88%')
eq('just under a full hit keeps a decimal', H.percentText(99.6), '99.6%')
eq('rounding must not claim one hundred', H.percentText(99.96), '99.9%')
eq('an exact full hit is one hundred', H.percentText(100), '100%')
eq('zero is a real figure', H.percentText(0), '0%')
eq('an absent rate is a dash', H.percentText(null), '—')
eq('an unreadable rate is a dash', H.percentText(Number.NaN), '—')
eq('a value above one hundred is clamped', H.percentText(140), '100%')
eq('a negative value is clamped', H.percentText(-5), '0%')

// --------------------------------------------------------- running-time record
//
// The per-Session record is a high-water mark. Running time only accumulates, so
// a smaller figure can only be stale — and writing it would make the timer
// visibly count DOWN after a session switch, because a tick queued when the run
// stopped (or a cleanup recomputing from state) can land after the stop-write.
store.set(H.DURATION_KEY_PREFIX + 's1', '5000')
H.writeDuration('s1', 3000)
eq('a shorter running time is refused', H.readDuration('s1'), 5000)
H.writeDuration('s1', 5000)
eq('an equal running time is not a move forward', H.readDuration('s1'), 5000)
H.writeDuration('s1', 9000)
eq('a longer running time is stored', H.readDuration('s1'), 9000)
H.writeDuration('s2', 1.6)
eq('a fractional figure is rounded before storing', H.readDuration('s2'), 2)
H.writeDuration('s2', -5)
eq('a negative figure is refused rather than stored as zero', H.readDuration('s2'), 2)
H.writeDuration('', 1000)
eq('an empty session id writes nothing', store.has(H.DURATION_KEY_PREFIX), false)
H.writeDuration(undefined, 1000)
eq('a missing session id writes nothing', store.has(H.DURATION_KEY_PREFIX + 'undefined'), false)
eq('a missing record reads as zero', H.readDuration('never-written'), 0)
eq('a missing session id reads as zero', H.readDuration(undefined), 0)
store.set(H.DURATION_KEY_PREFIX + 's3', 'not a number')
eq('an unparsable record reads as zero', H.readDuration('s3'), 0)

// The span in flight has to be flushed when the component goes away, and the
// flush has to compute the figure at that moment rather than reuse one from a
// render: a hidden tab throttles the tick that would have caused the render.
ok('the stopwatch flushes its open span when it goes away',
  clientSrc.includes('writeDuration(sessionId, currentMs())'))
ok('the flush is what reads the stopwatch state',
  clientSrc.includes('const timerRef = React.useRef(timer)'))
ok('the flush runs from an unmount cleanup',
  /React\.useEffect\(\(\) => \(\) => \{\s*writeDuration\(sessionId, currentMs\(\)\)/.test(clientSrc))
ok('the render-time total no longer comes from a stale ref',
  clientSrc.includes('const activeMs = currentMs()'))

// The shipped `StatsPills` pill in the composer dock computes
// `decodeTokens / (decodeMs / 1e3)` from this same projection. The ledger's
// output rate must be that same quantity, so the two are pinned together here:
// if the shipped formula ever changes, this says so instead of drifting silently.
const shippedTps = (decodeTokens, decodeMs) => (decodeMs > 0 ? decodeTokens / (decodeMs / 1e3) : null)
const shippedSpan = H.decodeSpan({ decodeTokens: 1200, decodeMs: 4000 })
eq('the output rate reproduces the shipped pill formula', H.tokenRate(shippedSpan.tokens, shippedSpan.ms), shippedTps(1200, 4000))

// One DELIBERATE divergence, stated rather than hidden: under a second of
// measured span the shipped pill still divides — a spike out of almost no data —
// while the ledger reports no rate at all.
const shortSpan = H.decodeSpan({ decodeTokens: 4, decodeMs: 500 })
eq('the ledger suppresses a sub-second span the shipped pill would divide',
  [H.tokenRate(shortSpan.tokens, shortSpan.ms), shippedTps(4, 500)], [null, 8])

// Money: only a decrease is spend, and the first reading is only a baseline.
let money = H.emptyLedger()
money = H.recordBalance(money, 'CNY', 100000, T14)
eq('the first reading books no spend', money.spend, 0)
eq('the first reading sets the baseline', money.balance, 100000)

money = H.recordBalance(money, 'CNY', 98000, T14)
eq('a drop is spend', money.spend, 2000)
eq('spend lands in the hour bucket', money.hours['2026-03-09T14'], { t: 0, s: 2000 })

money = H.recordBalance(money, 'CNY', 150000, T14)
eq('a top-up does not book negative spend', money.spend, 2000)
eq('a top-up rebases the baseline', money.balance, 150000)

const otherWallet = H.recordBalance(money, 'USD', 5000, T14)
eq('a currency change rebases instead of mixing', otherWallet.spend, 2000)
eq('the tracked currency follows the new wallet', otherWallet.currency, 'USD')

eq('an empty currency is ignored', H.recordBalance(money, '', 1, T14), money)
eq('a null reading is ignored', H.recordBalance(money, 'CNY', null, T14), money)
eq('a negative reading is ignored', H.recordBalance(money, 'CNY', -5, T14), money)

// ------------------------------------------------------- v1 -> v2 migration
//
// v1's totals were a ratio of two windows, so they are retracted rather than
// carried forward; its per-Session memory is what makes the retraction safe, and
// the balance baseline is kept for the same reason. The store is the stub
// declared at the top of this file, so the migration runs exactly as it does in
// the browser.
ok('the ledger key is namespaced and versioned', H.USAGE_KEY.startsWith('dsh.') && H.USAGE_KEY.endsWith('.v2'), H.USAGE_KEY)
eq('the legacy key is the pre-v2 one', H.USAGE_KEY_LEGACY, H.USAGE_KEY.replace(/\.v2$/, '.v1'))
ok('the two ledger keys are distinct', H.USAGE_KEY !== H.USAGE_KEY_LEGACY)

eq('an empty store reads as an empty ledger', H.readLedger(), H.emptyLedger())

const legacyDoc = {
  v: 1,
  currency: 'CNY',
  tokens: 149622412,
  spend: 22800,
  activeMs: 3119000,
  outputTokens: 1842839,
  outputMs: 6716584,
  balance: 100000,
  seen: { s1: { tokens: 60000000, ms: 1500000, outputTokens: 800000, outputMs: 2000000 } },
  hours: { '2026-03-09T14': { t: 149622412, s: 22800 } },
  days: { '2026-03-09': { t: 149622412, s: 22800 } },
  months: { '2026-03': { t: 149622412, s: 22800 } },
}
store.set(H.USAGE_KEY_LEGACY, JSON.stringify(legacyDoc))
const migrated = H.readLedger()
eq('the migration retracts the inflated token total', migrated.tokens, 0)
eq('the migration retracts the inflated running time', migrated.activeMs, 0)
eq('the migration retracts the inflated decode totals', [migrated.outputTokens, migrated.outputMs], [0, 0])
eq('the migration retracts the prompt pair too', [migrated.inputTokens, migrated.cacheReadTokens], [0, 0])
eq('the migration retracts the money so both columns restart on one clock', migrated.spend, 0)
eq('the migration clears the curve the inflated total was drawn from', Object.keys(migrated.hours).length, 0)
eq('the migration keeps the per-session memory', migrated.seen.s1.tokens, 60000000)
eq('the migration keeps the decode memory too', migrated.seen.s1.outputMs, 2000000)
// A v2 memory predates the cache rate, so its prompt pair reads as unknown — not
// as zero, which would credit that session's whole prompt side on the next push.
eq('a v2 memory has no prompt baseline yet',
  [migrated.seen.s1.inputTokens, migrated.seen.s1.cacheReadTokens], [null, null])
eq('the migration keeps the balance baseline', [migrated.currency, migrated.balance], ['CNY', 100000])
eq('the migration writes the new document', store.has(H.USAGE_KEY), true)
eq('the legacy document is left on disk as the only copy of the memory',
  JSON.parse(store.get(H.USAGE_KEY_LEGACY)).tokens, 149622412)
eq('a second read returns the migrated document instead of migrating again', H.readLedger().tokens, 0)

const afterMigration = H.recordSession(migrated, 's1', 60000050, 1501000, T14)
eq('the kept memory stops the history being credited a second time', afterMigration.tokens, 50)
const unseenAfterMigration = H.recordSession(migrated, 'fresh', 90000000, 1000, T14)
eq('a session the migration never saw is baselined, not credited', unseenAfterMigration.tokens, 0)

// With the new key gone, the legacy document is what a read has to fall back on.
store.delete(H.USAGE_KEY)
store.set(H.USAGE_KEY_LEGACY, 'not json')
eq('a corrupt legacy document yields an empty ledger instead of throwing', H.readLedger(), H.emptyLedger())
store.set(H.USAGE_KEY_LEGACY, '{')
eq('a truncated legacy document is tolerated too', H.readLedger().tokens, 0)

eq('entries come back oldest first', H.bucketEntries(ledger, 'hour').map(entry => entry[0]),
  Object.keys(ledger.hours).sort())
eq('an unknown period falls back to hourly', H.bucketEntries(ledger, 'nope').length, H.bucketEntries(ledger, 'hour').length)
eq('day entries read the day map', H.bucketEntries(ledger, 'day').length, Object.keys(ledger.days).length)

// Normalizing is per-field: one corrupt field must not discard the history.
eq('a corrupt ledger falls back to empty', H.normalizeLedger(null), H.emptyLedger())
eq('a non-object ledger falls back to empty', H.normalizeLedger('nope'), H.emptyLedger())
const dirty = H.normalizeLedger({
  tokens: -5,
  spend: Number.NaN,
  activeMs: 'lots',
  balance: -1,
  currency: '',
  seen: { s1: { tokens: 10, ms: 20 }, broken: 'nope' },
  hours: { '2026-01-01T00': { t: 5, s: 2 }, junk: null },
})
eq('a negative total clamps to zero', dirty.tokens, 0)
eq('a NaN total clamps to zero', dirty.spend, 0)
eq('a non-numeric total clamps to zero', dirty.activeMs, 0)
eq('a negative balance is dropped', dirty.balance, null)
eq('an empty currency is dropped', dirty.currency, null)
eq('a valid session memory survives', dirty.seen.s1, {
  tokens: 10,
  ms: 20,
  outputTokens: null,
  outputMs: null,
  inputTokens: null,
  cacheReadTokens: null,
})
eq('a malformed session memory is dropped', Object.hasOwn(dirty.seen, 'broken'), false)
eq('a valid bucket survives', dirty.hours['2026-01-01T00'], { t: 5, s: 2 })
eq('a malformed bucket is dropped', Object.hasOwn(dirty.hours, 'junk'), false)
eq('absent bucket maps become empty ones', [dirty.days, dirty.months], [{}, {}])
eq('an absent memory field reads as unknown, not as zero', H.maybeAmount(undefined), null)
eq('a stored zero survives as a real zero', H.maybeAmount(0), 0)
eq('a stored negative is not a counter', H.maybeAmount(-1), null)
eq('a stored non-number is not a counter', H.maybeAmount('5'), null)

// The decode totals fall back per field too, and a document written before the
// output rate existed reads as "nothing measured yet" rather than as a NaN.
const dirtyOutput = H.normalizeLedger({
  outputTokens: -1,
  outputMs: 'lots',
  seen: { s1: { tokens: 1, ms: 2, outputTokens: 3, outputMs: 4 } },
})
eq('a negative decode total clamps to zero', dirtyOutput.outputTokens, 0)
eq('a non-numeric decode time clamps to zero', dirtyOutput.outputMs, 0)
eq('a stored decode memory survives normalization', [dirtyOutput.seen.s1.outputTokens, dirtyOutput.seen.s1.outputMs], [3, 4])
const legacy = H.normalizeLedger({ tokens: 5, seen: { s1: { tokens: 1, ms: 2 } } })
eq('a document predating the output rate reads as zero decode', [legacy.outputTokens, legacy.outputMs], [0, 0])
eq('its session memory gains unknown decode fields, not zero ones', [legacy.seen.s1.outputTokens, legacy.seen.s1.outputMs], [null, null])

// Money per million / per ten million.
eq('no rate without spend', H.moneyPerTokens(0, 1000, 1e6), null)
eq('no rate without tokens', H.moneyPerTokens(100, 0, 1e6), null)
eq('no rate for a non-positive divisor', H.moneyPerTokens(100, 1000, 0), null)
eq('two yuan per million tokens', H.moneyPerTokens(20000, 1e6, 1e6), 20000)
eq('ten million is ten times the million rate', H.moneyPerTokens(20000, 1e6, 1e7), 200000)
eq('half the tokens doubles the per-million rate', H.moneyPerTokens(20000, 5e5, 1e6), 40000)

// Chart geometry: pure scaling, asserted rather than eyeballed.
const rising = H.chartGeometry([['a', { t: 0, s: 0 }], ['b', { t: 50, s: 0 }], ['c', { t: 100, s: 0 }]], 600, 100)
eq('the maximum is the largest value', rising.max, 100)
eq('the first point sits at the left baseline', [rising.dots[0].x, rising.dots[0].y], [0, 100])
eq('the last point sits at the right top edge', [rising.dots[2].x, rising.dots[2].y], [600, 0])
eq('the middle point is centred', rising.dots[1].x, 300)
eq('the middle point is half height', rising.dots[1].y, 50)
eq('the polyline joins the dots', rising.points, '0.0,100.0 300.0,50.0 600.0,0.0')

const single = H.chartGeometry([['only', { t: 7, s: 0 }]], 600, 100)
eq('a single point is centred', single.dots[0].x, 300)
eq('a single point scales to the top', single.dots[0].y, 0)

const noPoints = H.chartGeometry([], 600, 100)
eq('an empty series has no dots', noPoints.dots.length, 0)
eq('an empty series reports a zero maximum', noPoints.max, 0)
eq('an empty series has no polyline', noPoints.points, '')

const flatZero = H.chartGeometry([['a', { t: 0, s: 0 }], ['b', { t: 0, s: 0 }]], 600, 100)
eq('an all-zero series does not divide by zero', [flatZero.dots[0].y, flatZero.dots[1].y], [100, 100])
eq('an all-zero series reports a zero maximum', flatZero.max, 0)

// The hourly window picker: the recorded-day list and the span filter are pure
// functions, so what the picker can offer and what it then shows is asserted
// rather than clicked. `normalizeLedger` builds the fixture so the keys go
// through the same per-field gate a stored document does.
const rangeLedger = H.normalizeLedger({
  hours: {
    '2026-03-08T09': { t: 10, s: 0 },
    '2026-03-08T23': { t: 20, s: 0 },
    '2026-03-09T09': { t: 30, s: 0 },
    '2026-03-09T10': { t: 40, s: 0 },
    '2026-03-09T18': { t: 50, s: 0 },
    '2026-03-10T09': { t: 60, s: 0 },
  },
})
const hourSeries = H.bucketEntries(rangeLedger, 'hour')
eq('the day picker lists recorded days newest first', H.hourDays(hourSeries), ['2026-03-10', '2026-03-09', '2026-03-08'])
eq('a day with no buckets yields no days', H.hourDays([]), [])
eq('one day of the picker keeps only its own buckets',
  H.hourRangeEntries(hourSeries, '2026-03-09', 0, 23).map(e => e[0]),
  ['2026-03-09T09', '2026-03-09T10', '2026-03-09T18'])
eq('both span ends are inclusive',
  H.hourRangeEntries(hourSeries, '2026-03-09', 10, 18).map(e => e[0]),
  ['2026-03-09T10', '2026-03-09T18'])
eq('a single-hour span keeps one bucket', H.hourRangeEntries(hourSeries, '2026-03-09', 9, 9).map(e => e[0]), ['2026-03-09T09'])
eq('reversed span ends read as the same span',
  H.hourRangeEntries(hourSeries, '2026-03-09', 18, 10).map(e => e[0]),
  H.hourRangeEntries(hourSeries, '2026-03-09', 10, 18).map(e => e[0]))
eq('a span with no bucket is empty', H.hourRangeEntries(hourSeries, '2026-03-09', 2, 4).length, 0)
eq('a day with no recorded bucket is empty', H.hourRangeEntries(hourSeries, '2026-03-11', 0, 23).length, 0)
eq('an unchosen day passes every bucket through', H.hourRangeEntries(hourSeries, '', 0, 0).length, hourSeries.length)
eq('a span totals only its own buckets', H.seriesTotal(H.hourRangeEntries(hourSeries, '2026-03-09', 9, 10)), 70)
eq('an empty series totals zero', H.seriesTotal([]), 0)
eq('the pickers offer every hour of the day', [H.HOUR_LABELS.length, H.HOUR_LABELS[0], H.HOUR_LABELS[23]], [24, '00:00', '23:00'])

// Placeholder substitution, used by the storage sentence to state the live share.
eq('placeholders are filled from the values', H.fill('a {x} b {y}', { x: 3, y: 'z' }), 'a 3 b z')
eq('an unknown placeholder is left verbatim', H.fill('a {nope}', {}), 'a {nope}')
eq('a non-string template is empty', H.fill(null, {}), '')

// Retention is unlimited, which is exactly why the footprint has to be visible.
ok('the retention copy claims no window', /不限时/.test(H.zh['usage.retained']), H.zh['usage.retained'])
ok('the English retention copy says the same', /unlimited/i.test(H.en['usage.retained']), H.en['usage.retained'])
ok('the usage key is namespaced', H.USAGE_KEY.startsWith('dsh.'), H.USAGE_KEY)
ok('every key this plugin owns is distinct',
  new Set([H.SETTINGS_KEY, H.DURATION_KEY_PREFIX, H.USAGE_KEY, H.USAGE_KEY_LEGACY]).size === 4)

// ------------------------------------------------------------ storage footprint

// A stand-in for `Storage`: the three members the measurement uses, over a plain
// list, so what the panel reads can be asserted exactly.
const fakeStorage = entries => ({
  get length() { return entries.length },
  key: index => (index >= 0 && index < entries.length ? entries[index][0] : null),
  getItem: key => {
    const found = entries.find(entry => entry[0] === key)
    return found === undefined ? null : found[1]
  },
})

eq('the ledger key is our usage group', H.ownedGroup(H.USAGE_KEY), 'usage')
eq('the legacy key gets its own group', H.ownedGroup(H.USAGE_KEY_LEGACY), 'legacy')
eq('a session running-time key is ours', H.ownedGroup(H.DURATION_KEY_PREFIX + 'abc'), 'duration')
eq('the preferences key is ours', H.ownedGroup(H.SETTINGS_KEY), 'settings')
eq('another plugin\'s key is not ours', H.ownedGroup('dsh.theme-studio.settings.v1'), null)
eq('a key that merely shares a stem is not ours', H.ownedGroup(H.USAGE_KEY + '.extra'), null)
eq('the panel reports four groups', H.STORAGE_GROUPS, ['usage', 'duration', 'legacy', 'settings'])
// The panel takes its order and membership from this list, so every entry has to
// be labelled in both dictionaries — otherwise a group would render under a raw
// key name, or a measurement would be unreachable from the UI.
for (const id of H.STORAGE_GROUPS) {
  ok('group "' + id + '" is labelled in zh and en',
    typeof H.zh['storage.' + id] === 'string' && typeof H.en['storage.' + id] === 'string')
}

// Browsers charge UTF-16 — two bytes per code unit — for the key AND the value.
eq('an entry is charged for key and value together', H.entryBytes('abc', 'de'), 10)
eq('an empty value is still charged for its key', H.entryBytes('ab', ''), 4)
eq('a missing key contributes nothing', H.entryBytes(null, 'ab'), 4)
eq('a missing value contributes only its key', H.entryBytes('ab', null), 4)

const emptyFootprint = H.storageFootprint(fakeStorage([]))
eq('an empty store measures zero', [emptyFootprint.total, emptyFootprint.count], [0, 0])
eq('every group exists even when empty', Object.keys(emptyFootprint.groups).sort(), [...H.STORAGE_GROUPS].sort())
eq('each empty group reads zero', H.STORAGE_GROUPS.map(id => emptyFootprint.groups[id].bytes), [0, 0, 0, 0])

const measured = H.storageFootprint(fakeStorage([
  [H.USAGE_KEY, 'x'.repeat(90)],
  [H.USAGE_KEY_LEGACY, 'y'.repeat(10)],
  [H.DURATION_KEY_PREFIX + 's1', '1000'],
  [H.DURATION_KEY_PREFIX + 's2', '2000'],
  [H.SETTINGS_KEY, '{}'],
  ['some.other.plugin', 'z'.repeat(1000)],
]))
eq('the ledger is measured on its own', measured.groups.usage.count, 1)
eq('the ledger figure counts key and value', measured.groups.usage.bytes, (H.USAGE_KEY.length + 90) * 2)
eq('per-session records share one group', measured.groups.duration.count, 2)
eq('per-session figures are summed', measured.groups.duration.bytes, (H.DURATION_KEY_PREFIX.length + 2 + 4) * 2 * 2)
eq('the legacy document has its own group', measured.groups.legacy.count, 1)
eq('the preferences have their own group', measured.groups.settings.count, 1)
eq('the entry count covers our keys only', measured.count, 5)
eq('the total sums exactly the groups', measured.total,
  H.STORAGE_GROUPS.reduce((sum, id) => sum + measured.groups[id].bytes, 0))
ok('a foreign key is measured as zero', measured.total < 1000, String(measured.total))

eq('an absent store measures null', H.storageFootprint(null), null)
eq('an undefined store measures null', H.storageFootprint(undefined), null)
eq('a store that throws on length measures null', H.storageFootprint({ get length() { throw new Error('nope') } }), null)
eq('a store with no length measures null', H.storageFootprint({ key: () => null, getItem: () => null }), null)
eq('one unreadable entry does not blank the panel',
  H.storageFootprint({ length: 1, key: () => { throw new Error('nope') }, getItem: () => null }).total, 0)

eq('bytes stay in bytes', H.formatBytes(0), '0 B')
eq('bytes below a kilobyte are rounded', H.formatBytes(1023), '1023 B')
eq('a kilobyte switches unit', H.formatBytes(1024), '1.0 KB')
eq('kilobytes keep one decimal', H.formatBytes(2048), '2.0 KB')
eq('a megabyte switches unit again', H.formatBytes(1024 * 1024), '1.00 MB')
eq('a non-number size is unreadable', H.formatBytes(Number.NaN), '—')
eq('a negative size is unreadable', H.formatBytes(-1), '—')
eq('an empty footprint is zero percent', H.quotaShare(0, 1000), '0%')
eq('a tiny share keeps a decimal', H.quotaShare(1, 1000), '0.1%')
eq('a share under ten percent keeps a decimal', H.quotaShare(99, 1000), '9.9%')
eq('a share of ten percent is whole', H.quotaShare(100, 1000), '10%')
eq('a large share is whole', H.quotaShare(127, 1000), '13%')
eq('a missing quota is unreadable', H.quotaShare(100, 0), '—')
eq('the assumed quota is five megabytes', H.STORAGE_QUOTA_BYTES, 5 * 1024 * 1024)

// The chart drops hover DOTS, never points, once the series outgrows the viewBox.
eq('the dot limit is a screenful, not a data limit', H.CHART_DOT_LIMIT, 120)

// A refused write is a real end state under unlimited retention: the page keeps
// counting in memory while nothing survives a reload, so it is surfaced rather
// than swallowed. Exercised against the same stubbed store the migration uses.
const workingSetItem = globalThis.window.localStorage.setItem
globalThis.window.localStorage.setItem = () => { throw new Error('QuotaExceededError') }
eq('a refused write reports failure', H.writeLedger(H.emptyLedger()), false)
eq('a refused write raises the flag', H.ledgerWriteFailed(), true)
globalThis.window.localStorage.setItem = workingSetItem
eq('a write that lands reports success', H.writeLedger(H.emptyLedger()), true)
eq('a write that lands clears the flag', H.ledgerWriteFailed(), false)

const storageSrc = clientSrc.slice(clientSrc.indexOf('function StorageSection'), clientSrc.indexOf('function UsageSection'))
ok('the storage panel is defined before the section that renders it', storageSrc.length > 0)
ok('the storage panel re-measures when the ledger changes', /useStore\(usageStore\)/.test(storageSrc))
ok('the storage panel measures the real store', /storageFootprint\(storage\)/.test(storageSrc))
ok('the storage panel has an unreadable-store branch', /footprint === null/.test(storageSrc))
ok('the storage panel hides groups that hold nothing', /count > 0/.test(storageSrc))
ok('the storage panel surfaces a refused write', /ledgerWriteFailed\(\)/.test(storageSrc))
ok('the chart keeps the line when it drops the dots',
  clientSrc.includes('const dots = entries.length <= CHART_DOT_LIMIT'))

// The period tabs must offer exactly the periods the ledger stores, or a stored
// series would be unreachable from the UI.
const periodTabs = [...clientSrc.matchAll(/\{ id: '([a-z]+)', label: t\('usage\.period\./g)].map(m => m[1])
eq('the chart offers every recorded period', periodTabs.sort(), ['day', 'hour', 'month'])

// The statistics list, read off the source in render order. The output rate was
// asked for directly UNDER the total rate, and the two rates must divide
// different denominators — otherwise the second row would just repeat the first.
// Scoped to the usage section: the storage panel lists rows too, and it is
// defined first, so an unscoped scan would report its total as the first figure.
const usageSrc = clientSrc.slice(clientSrc.indexOf('function UsageSection'), clientSrc.indexOf('function SettingsRow'))
ok('the usage section was found', usageSrc.length > 0)
const statKeys = [...usageSrc.matchAll(/h\(StatRow, \{\s*key: '([a-zA-Z]+)'/g)].map(m => m[1])
eq('the statistics list opens with the token total and the recorded time', statKeys.slice(0, 2), ['tokens', 'time'])
eq('the total rate follows the recorded time', statKeys[2], 'rate')
eq('the output rate sits directly under the total rate', statKeys[3], 'outputRate')
eq('every statistic is listed exactly once', [...statKeys].sort(), [...new Set(statKeys)].sort())
eq('the cache hit rate follows the output rate', statKeys[4], 'cacheHit')
ok('the dock feeds the prompt side into the ledger',
  clientSrc.includes('{ input: recordedPromptTokens, cacheRead: recordedCacheRead }'))

const rateLines = [...clientSrc.matchAll(/const rate = tokenRate\([^\n]+/g)].map(m => m[0])
ok('the total rate divides the conversation total by its running time',
  rateLines.some(line => line.includes('tokenRate(ledger.tokens, ledger.activeMs)')), rateLines.join(' | '))
ok('the output rate divides the decode span by its own time',
  clientSrc.includes('const outputRate = tokenRate(ledger.outputTokens, ledger.outputMs)'))
ok('the dock reads the shipped sessionStats projection', clientSrc.includes("useProjection('sessionStats')"))
ok('the dock feeds the decode span into the ledger',
  clientSrc.includes('{ tokens: recordedOutputTokens, ms: recordedOutputMs }'))
ok('the day picker is offered for the hourly chart only',
  clientSrc.includes("period === 'hour' ? hourDays(periodEntries) : []"))
ok('a narrowed window gets its own empty message, not "no data yet"',
  clientSrc.includes("empty: day === null ? t('usage.empty') : t('usage.rangeEmpty')"))

// ------------------------------------------------------------- row classes
//
// The row is one ambient line, so both figures must be styled by the SAME
// class and one cell's state must not recolour the other. These assertions pin
// that down, because the failure mode is invisible in a diff: a tone class on
// the root silently turns the token figure amber whenever the balance read
// fails.

const normalRow = H.rowClasses('normal')
eq('the root carries no tone', normalRow.root, 'ab-root')
ok('a healthy balance carries no tone class', normalRow.balance.includes('ab-tone-') === false, normalRow.balance)
ok('the balance cell is addressable for toning', normalRow.balance.includes('ab-balance'))
ok('both figures share the value class', normalRow.tokens.includes('ab-part') && normalRow.balance.includes('ab-button'))

for (const tone of ['stale', 'warn', 'error', 'muted']) {
  const row = H.rowClasses(tone)
  eq('tone "' + tone + '" stays off the root', row.root.includes('ab-tone-'), false)
  eq('tone "' + tone + '" stays off the token cell', row.tokens.includes('ab-tone-'), false)
  ok('tone "' + tone + '" reaches the balance cell', row.balance.includes('ab-tone-' + tone), row.balance)
}

// Static colour invariants over the stylesheet.
const cssRules = []
for (const chunk of H.CSS.split('}')) {
  const at = chunk.indexOf('{')
  if (at >= 0) cssRules.push({ selector: chunk.slice(0, at).trim(), body: chunk.slice(at + 1).trim() })
}
const ruleFor = selector => cssRules.find(rule => rule.selector === selector)
const rulesTouching = fragment => cssRules.filter(rule => rule.selector.includes(fragment))

const toneRules = rulesTouching('.ab-tone-')
ok('the stylesheet declares tone rules', toneRules.length > 0)
eq(
  'every tone rule is scoped to the balance cell',
  toneRules.filter(rule => !rule.selector.includes('.ab-balance')).map(rule => rule.selector),
  [],
)

const valueRule = ruleFor('.ab-value')
ok('the shared value rule exists', valueRule !== undefined)
eq(
  'the value rule names exactly one colour token',
  valueRule === undefined ? [] : valueRule.body.match(/--dsw-alias-[a-z0-9-]+/g) ?? [],
  ['--dsw-alias-label-secondary'],
)

const labelRule = ruleFor('.ab-label')
eq('the label inherits the row colour instead of naming a second one', /color:\s*inherit/.test(labelRule?.body ?? ''), true)

const sepRule = ruleFor('.ab-sep')
ok('the separator declares its own rule', sepRule !== undefined)
eq('the separator uses a text token, never a border token', /border/.test(sepRule?.body ?? ''), false)

// Nothing may restyle one figure without the other: every other rule touching
// `.ab-value` has to be scoped to a cell (its state or its interaction).
eq(
  'no rule restyles a lone figure',
  rulesTouching('.ab-value')
    .filter(rule => rule.selector !== '.ab-value')
    .filter(rule => !rule.selector.includes('.ab-balance') && !rule.selector.includes('.ab-button'))
    .map(rule => rule.selector),
  [],
)

// ------------------------------------------------- the liquid-glass capsule
//
// The `dsh-liquid-glass` skin dresses the composer dock in glass capsules and
// finds the statistics line BY POSITION — it styles the dock's first child,
// which is the shipped stats entry. That is a proxy for "the one entry", and
// this plugin's registration is a second one, so its row sat bare beside a
// capsule belonging to the same line of text.
//
// The row therefore mirrors the capsule under the same marker. Duplicating
// declarations is the risk in that, so while the skin's source is present the
// two sets are compared declaration by declaration: if it changes its capsule,
// this fails rather than letting the two quietly drift apart.

const declarationsOf = body => {
  const map = new Map()
  if (typeof body !== 'string') return map
  for (const part of body.split(';')) {
    const at = part.indexOf(':')
    if (at < 0) continue
    const name = part.slice(0, at).trim()
    if (name.length === 0) continue
    map.set(name, part.slice(at + 1).replace(/\s+/g, ' ').trim())
  }
  return map
}

// The capsule, as the skin spells it: these are shared with it verbatim.
const CAPSULE_DECLS = [
  'box-sizing',
  'width',
  'max-width',
  'margin',
  'padding',
  'font-size',
  'line-height',
  'background',
  '-webkit-backdrop-filter',
  'backdrop-filter',
  'border',
  'border-radius',
  'box-shadow',
]
// And these four are left out on purpose, not forgotten: the skin uses them to
// truncate a line that cannot wrap, while this row wraps its cells — clipping
// the tail off a balance would be worse than a second line.
const OMITTED_DECLS = ['height', 'overflow', 'text-overflow', 'white-space']

const ruleBodyOf = (source, selector) => {
  const at = source.indexOf(selector)
  if (at < 0) return null
  const open = source.indexOf('{', at)
  return source.slice(open + 1, source.indexOf('}', open))
}

const mirrorSelector = "body[data-dsh-liquid-glass] [data-slot='conversation.composer.dock'] > .ab-root"
const mirrorBody = ruleBodyOf(H.CSS, mirrorSelector)
ok('the row mirrors the glass capsule under the skin marker', mirrorBody !== null)
const mirrorDecls = declarationsOf(mirrorBody)
eq('the mirrored capsule carries every shared declaration', mirrorDecls.size, CAPSULE_DECLS.length)

// The context meter is the other bare capsule on that line, and it is bare for
// the same reason: the shipped composer renders it as a SIBLING of the dock
// anchor rather than an entry inside it, so a rule that styles the anchor's
// children cannot reach it. It is addressed through that public relation and
// through the control's own role — never through a hashed class name from the
// shipped module, which changes on every build.
const meterSelector = "body[data-dsh-liquid-glass] [data-slot='conversation.composer.dock'] ~ * button[aria-haspopup='dialog']"
const meterBody = ruleBodyOf(H.CSS, meterSelector)
ok('the context meter wears the same capsule', meterBody !== null)
const meterDecls = declarationsOf(meterBody)
eq('the meter capsule carries every shared declaration', meterDecls.size, CAPSULE_DECLS.length)
eq('the meter is reached by role and relation, not a hashed class name',
  /\.[A-Za-z0-9_-]+_/.test(meterSelector), false)

// The meter is the one capsule on that line that opens a panel, so the hover it
// already had must survive being dressed: the shipped rule tints the text on
// hover, and this firms the rim without dropping the glass back to a flat fill.
const meterHoverDecls = declarationsOf(ruleBodyOf(H.CSS, meterSelector + ':hover'))
eq('the dressed meter still answers hover', meterHoverDecls.get('border-color'), 'var(--lg-border-strong)')
eq('the hover keeps the inset highlight',
  meterHoverDecls.get('box-shadow'),
  'inset 0 1px 0 var(--lg-highlight), 0 0 0 1px var(--lg-border-strong)')
const meterOpenDecls = declarationsOf(ruleBodyOf(H.CSS, meterSelector + "[aria-expanded='true']"))
eq('the open meter reads as pressed', meterOpenDecls.get('border-color'), 'var(--lg-border-strong)')

const glassDir = join(pkgDir, '..', '..', 'liquid-glass', 'src', 'client', 'css')
let glassCards = null
try {
  glassCards = readFileSync(join(glassDir, 'cards.js'), 'utf8')
} catch {
  glassCards = null
}

if (glassCards === null) {
  ok('the liquid-glass skin is not beside this plugin, so its capsule cannot be compared', true)
} else {
  const anchor = glassCards.indexOf("data-slot='conversation.composer.dock'")
  ok('the skin still targets the composer dock', anchor > 0)
  const open = glassCards.indexOf('{', anchor)
  const glassDecls = declarationsOf(glassCards.slice(open + 1, glassCards.indexOf('}', open)))
  // Everything the two have in common must be identical, declaration for
  // declaration — that is what makes the two capsules one look rather than two.
  for (const [label, decls] of [['the mirrored capsule', mirrorDecls], ['the meter capsule', meterDecls]]) {
    for (const name of CAPSULE_DECLS) {
      eq(label + ' matches the skin for "' + name + '"', decls.get(name), glassDecls.get(name))
    }
    for (const name of OMITTED_DECLS) {
      eq(label + ' deliberately omits "' + name + '"', decls.has(name), false)
    }
  }
  ok('the mirror scopes to the marker the skin actually sets', glassCards.includes('body[data-dsh-liquid-glass]'))
  const glassTokens = readFileSync(join(glassDir, 'tokens.js'), 'utf8')
  eq('the skin still defines every token the capsules read',
    ['--lg-control-bg', '--lg-border', '--lg-border-strong', '--lg-highlight', '--lg-radius-control', '--lg-blur-card']
      .filter(token => !glassTokens.includes(token)),
    [])
}

// ------------------------------------------------------------- dictionaries

const zhKeys = Object.keys(H.zh).sort()
const enKeys = Object.keys(H.en).sort()
eq('en covers exactly the zh key set', enKeys, zhKeys)
ok('the dictionary is non-trivial', zhKeys.length > 10, String(zhKeys.length) + ' keys')

// Every literal key the component asks for must exist, and no key may be dead:
// a missing one renders the raw key name into the UI, a dead one is uncleaned
// copy left behind by a rewrite.
const asked = new Set()
// Collect every literal appearing inside a `t(...)` call, rather than only the
// single-literal form: a ternary such as t(value ? 'on' : 'off') is a use too,
// and missing it reports a live key as dead. `\bt\(` keeps `format(` and
// `split(` from being mistaken for translate calls.
for (const start of clientSrc.matchAll(/\bt\(/g)) {
  let depth = 0
  let end = -1
  for (let i = start.index + 1; i < clientSrc.length; i += 1) {
    const ch = clientSrc[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) continue
  for (const literal of clientSrc.slice(start.index, end).matchAll(/'([^']+)'/g)) asked.add(literal[1])
}
// The slot's `label` thunk cannot use the component's `t`; it binds the
// namespace directly, so that call form counts as a use too.
for (const match of clientSrc.matchAll(/bind\(NS\)\('([^']+)'\)/g)) asked.add(match[1])
const missing = [...asked].filter(key => !Object.hasOwn(H.zh, key)).sort()
eq('every t() key exists in the dictionary', missing, [])
const unused = zhKeys.filter(key => !asked.has(key))
eq('no dictionary key is unused', unused, [])

// --------------------------------------------------------------- render smoke
//
// Everything above this line exercises pure functions. What a user actually SEES
// runs through the components, and a crash there is invisible to the offline
// harness — it would simply blank the section on a real page, with nothing in
// this file to say so. So the plugin is applied to a stub context to capture the
// components it registers, and they are rendered once against a minimal React
// stand-in whose `createElement` builds a walkable tree.
//
// Effects are COLLECTED, not run: running them would start the balance poll, the
// one-second tick and the store subscriptions, which is a different test.

const zhText = key => (Object.hasOwn(H.zh, key) ? H.zh[key] : key)
const makeReact = () => ({
  Fragment: 'fragment',
  createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() {},
  useRef(initial) { return { current: initial } },
  useCallback(fn) { return fn },
})

/** Walk a rendered tree depth-first, calling function components along the way. */
function renderTree(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    const parts = node.map(child => renderTree(child)).filter(part => part !== null)
    return parts.length === 0 ? null : parts
  }
  if (node.type === 'fragment') return renderTree(node.children)
  if (typeof node.type === 'function') return renderTree(node.type({ ...node.props, children: node.children }))
  return { tag: node.type, props: node.props, children: renderTree(node.children) }
}

/** Every text node in a rendered tree, in order. */
function treeText(node, out = []) {
  if (node === null) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { for (const child of node) treeText(child, out); return out }
  return treeText(node.children, out)
}

// A KNOWN store, written before the factory creates its stores, so the rendered
// figures can be asserted and not only the structure. 1,000 tokens over a minute
// is a rate of 16.67/s, which has to reach the page as `17 tok/s` rather than as
// the division printed in full; the cache pair is a real zero, which has to read
// `0%` rather than a dash. One running-time record gives the storage panel two
// groups to report, so its total row is exercised too.
store.clear()
store.set(H.USAGE_KEY, JSON.stringify({
  ...H.emptyLedger(),
  tokens: 1000,
  activeMs: 60000,
  outputTokens: 400,
  outputMs: 1000,
  inputTokens: 1000,
  cacheReadTokens: 0,
  hours: { '2026-03-09T14': { t: 1000, s: 0 } },
}))
store.set(H.DURATION_KEY_PREFIX + 's1', '1000')

const renderReact = makeReact()
const capturing = []
const renderPlugin = loaded.factory(id => {
  if (id === 'react') return renderReact
  throw new Error('unexpected require: ' + id)
})
renderPlugin.apply({
  effect(fn) { fn(); return () => {} },
  locale: { register() {}, bind: () => zhText, getSnapshot: () => ({ active: 'zh' }) },
  slots: {
    inject(name, register) { register() },
    register(definition, component) { capturing.push({ definition, component }); return () => {} },
  },
  remote: { account: { getBalance: async () => ({ ok: true, value: null }) } },
})

eq('the plugin registers one component per slot', capturing.map(entry => entry.definition.name),
  ['conversation.composer.dock', 'settings.section'])
eq('both registered entries share the plugin id', [...new Set(capturing.map(entry => entry.definition.id))], ['account-balance'])
eq('the registered orders are the documented ones', capturing.map(entry => entry.definition.order), [10, 13])

// A known store, so the storage panel has something real to measure: the ledger
// and one per-Session running-time record. Nothing else is written.
const settingsEntry = capturing.find(entry => entry.definition.name === 'settings.section')
const page = renderTree(renderReact.createElement(settingsEntry.component, {}))
const pageText = treeText(page).join(' | ')
ok('the settings page renders to a tree', page !== null)
for (const label of [
  H.zh['storage.group'],
  H.zh['storage.usage'],
  H.zh['storage.duration'],
  H.zh['storage.total'],
  H.zh['usage.statCacheHit'],
  H.zh['usage.statOutputRate'],
  H.zh['usage.period.hour'],
  H.zh['usage.clear'],
  H.zh['settings.show'],
]) {
  ok('the rendered settings page shows "' + label + '"', pageText.includes(label))
}
// The panel hides a group that holds nothing, so the legacy key and the never
// written preferences key must not appear as rows.
ok('an empty storage group is not rendered as a row', pageText.includes(H.zh['storage.legacy']) === false)
ok('the unreadable-store branch is not taken while a store is readable',
  pageText.includes(H.zh['storage.unavailable']) === false)
// With a real ledger of ~0 bytes the share is a real figure, not a dash.
ok('the storage note states a share', /0\.0%/.test(pageText), pageText.slice(0, 200))

// The FIGURES, not just the labels: this is the only place the whole path runs —
// ledger -> helper -> formatter -> rendered text.
ok('the rendered page shows the total token count', pageText.includes(H.exactTokens(1000) + ' tok'))
ok('the rendered page shows the recorded time', pageText.includes(H.formatDuration(60000)))
ok('the rendered page shows the rounded rate, not the division',
  pageText.includes(H.compactRate(1000 / 60) + ' tok/s'), pageText.slice(0, 300))
ok('a real zero cache rate is a figure, not a dash', pageText.includes('0%'))
ok('the rendered page carries no long fraction', /\d+\.\d{4,}/.test(pageText) === false, pageText.slice(0, 300))
// Two groups, one stored entry each — the ledger, and one session's running time.
eq('the panel counts each stored entry',
  pageText.split(H.fill(H.zh['storage.entries'], { n: 1 })).length - 1, 2)

// The dock is the other half: rendered with no projections published yet, which
// is the state of the very first frame of a fresh page.
const dockEntry = capturing.find(entry => entry.definition.name === 'conversation.composer.dock')
const dock = renderTree(renderReact.createElement(dockEntry.component, {
  sessionId: 's1',
  useProjection: () => undefined,
  useSessionStatus: () => false,
}))
const dockText = treeText(dock).join(' | ')
ok('the dock renders to a tree', dock !== null)
for (const label of [H.zh['balance.label'], H.zh['tokens.label'], H.zh['balance.loading']]) {
  ok('the rendered dock shows "' + label + '"', dockText.includes(label))
}
ok('the dock shows a dash while no projection is published', dockText.includes(H.zh['tokens.unavailable']))

// A published projection must reach the row: this is the path the user watches.
const published = renderTree(renderReact.createElement(dockEntry.component, {
  sessionId: 's1',
  useProjection: key => (key === 'tokenUsage'
    ? { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 500 }
    : undefined),
  useSessionStatus: () => false,
}))
ok('a published projection reaches the dock figure',
  treeText(published).join(' | ').includes(H.compactTokens(1500) + ' tok'),
  treeText(published).join(' | '))

// An assembly that omits both hook props must still render. This is the case the
// conditional call would have broken the moment the props appeared or vanished:
// substituting a constant keeps the hook count at one either way.
const bare = renderTree(renderReact.createElement(dockEntry.component, { sessionId: 's1' }))
ok('the dock renders without the optional hook props', bare !== null)
ok('the dock degrades to a dash without a projection',
  treeText(bare).join(' | ').includes(H.zh['tokens.unavailable']))
ok('a missing session id does not throw through the stand-in',
  renderTree(renderReact.createElement(dockEntry.component, {})) !== null)

// Both hook props must be CALLED unconditionally, through a stand-in when absent.
ok('the dock calls useSessionStatus through a stand-in',
  clientSrc.includes('? props.useSessionStatus : NO_SESSION_STATUS'))
ok('the dock calls useProjection through a stand-in',
  clientSrc.includes('? props.useProjection : NO_PROJECTION'))
ok('the session-status hook call itself is unconditional',
  /const running = useSessionStatus\(/.test(clientSrc))
ok('the projection hook calls themselves are unconditional',
  /const usage = useProjection\('tokenUsage'\)/.test(clientSrc)
  && /const stats = useProjection\('sessionStats'\)/.test(clientSrc))
ok('no hook is invoked inside a typeof test',
  /typeof props\.[a-zA-Z]+ === 'function' \? props\.[a-zA-Z]+\(/.test(clientSrc) === false)

// ------------------------------------------------------------------ report

console.log('account-balance bundle self-test')
console.log('  passed: ' + passed)
if (failures.length === 0) {
  console.log('  failed: 0')
  console.log('OK')
} else {
  console.log('  failed: ' + failures.length)
  for (const failure of failures) console.log('  - ' + failure)
  process.exitCode = 1
}
