/**
 * Minimal asar reader.
 *
 * Electron's asar container is a JSON header plus a contiguous data area:
 *
 *   [ uint32 headerPickleSize ][ Pickle{ uint32 jsonBytes; json; pad } ][ file data ... ]
 *
 * Rather than reimplement Chromium's Pickle framing exactly, we locate the
 * header JSON by its first key, brace-match to its true end (string-aware), and
 * take the data area to start at the next 4-byte boundary. The layout is then
 * self-verified against `package.json`, whose offset must be "0" and whose
 * bytes must begin with "{".
 *
 * Usage:
 *   node asar.mjs list    <archive> [prefix]
 *   node asar.mjs read    <archive> <innerPath>
 *   node asar.mjs extract <archive> <innerPath> <outFile>
 *   node asar.mjs grep    <archive> <prefix> <regex>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const align4 = n => (n + 3) & ~3

/** Read `{ header, dataStart }` from one asar archive. */
export function openArchive(archive) {
  const buf = readFileSync(archive)
  const marker = buf.indexOf('{"files":')
  if (marker < 0) throw new Error('asar header not found (no {"files": marker)')

  // Brace-match the header object, skipping over JSON strings and escapes.
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = marker; i < buf.length; i += 1) {
    const c = buf[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === 0x5c) escaped = true
      else if (c === 0x22) inString = false
      continue
    }
    if (c === 0x22) inString = true
    else if (c === 0x7b) depth += 1
    else if (c === 0x7d) {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) throw new Error('asar header JSON is unterminated')

  const header = JSON.parse(buf.subarray(marker, end).toString('utf8'))
  const dataStart = align4(end)

  // Self-check: the root package.json is always the first stored file.
  const root = header.files?.['package.json']
  if (root && root.offset !== undefined && Number(root.offset) === 0) {
    if (buf[dataStart] !== 0x7b) throw new Error('asar data-area alignment self-check failed')
  }
  return { buf, header, dataStart, archive }
}

/** Walk the header tree along a slash-separated inner path. */
function lookup(header, innerPath) {
  const parts = innerPath.split('/').filter(p => p.length > 0)
  let node = { files: header.files }
  for (const part of parts) {
    if (node.files === undefined) return undefined
    node = node.files[part]
    if (node === undefined) return undefined
  }
  return node
}

/** Collect every stored file path under a prefix. */
function walk(node, prefix, out) {
  if (node.files !== undefined) {
    for (const [name, child] of Object.entries(node.files)) {
      walk(child, prefix === '' ? name : prefix + '/' + name, out)
    }
    return
  }
  out.push({ path: prefix, offset: Number(node.offset ?? 0), size: Number(node.size ?? 0), unpacked: node.unpacked === true })
}

/** Decode one stored file, honouring the `unpacked` escape. */
export function readEntry(archive, innerPath) {
  const { buf, header, dataStart } = archive
  const node = lookup(header, innerPath)
  if (node === undefined) throw new Error('not in archive: ' + innerPath)
  if (node.files !== undefined) throw new Error('is a directory: ' + innerPath)
  const size = Number(node.size ?? 0)
  if (node.unpacked === true) {
    return readFileSync(archive.archive + '.unpacked/' + innerPath)
  }
  const offset = Number(node.offset ?? 0)
  return buf.subarray(dataStart + offset, dataStart + offset + size)
}

function listArchive(archive, prefix) {
  const out = []
  walk({ files: archive.header.files }, '', out)
  return out.filter(e => prefix === undefined || e.path.startsWith(prefix))
}

const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
const [cmd, archivePath, ...rest] = process.argv.slice(2)
if (invokedDirectly && cmd !== undefined) {
  const archive = openArchive(archivePath)
  if (cmd === 'list') {
    for (const e of listArchive(archive, rest[0])) {
      console.log(String(e.size).padStart(9) + (e.unpacked ? ' U' : '  ') + '  ' + e.path)
    }
  } else if (cmd === 'read') {
    process.stdout.write(readEntry(archive, rest[0]))
  } else if (cmd === 'extract') {
    const [innerPath, outFile] = rest
    const bytes = readEntry(archive, innerPath)
    mkdirSync(dirname(outFile), { recursive: true })
    writeFileSync(outFile, bytes)
    console.log('wrote ' + bytes.length + ' bytes -> ' + outFile)
  } else if (cmd === 'grep') {
    const [prefix, pattern] = rest
    const re = new RegExp(pattern)
    for (const e of listArchive(archive, prefix)) {
      if (e.unpacked) continue
      const text = readEntry(archive, e.path).toString('utf8')
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (re.test(lines[i])) console.log(e.path + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 400))
      }
    }
  } else {
    console.error('unknown command: ' + cmd)
    process.exitCode = 2
  }
}
