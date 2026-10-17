import zlib from 'node:zlib'

/**
 * Dependency-free reader for the first column of the first worksheet of an
 * .xlsx file (used for "Import XLSX" title lists). Supports the common
 * stored/deflated zip entries and shared/inline strings.
 */

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localHeaderOffset: number
}

function readEntries(buf: Buffer): ZipEntry[] {
  // Locate End Of Central Directory
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a valid xlsx (zip) file')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localHeaderOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    entries.push({ name, method, compressedSize, localHeaderOffset })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function readEntryData(buf: Buffer, e: ZipEntry): Buffer {
  const lh = e.localHeaderOffset
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('Corrupt zip local header')
  const nameLen = buf.readUInt16LE(lh + 26)
  const extraLen = buf.readUInt16LE(lh + 28)
  const start = lh + 30 + nameLen + extraLen
  const data = buf.subarray(start, start + e.compressedSize)
  if (e.method === 0) return Buffer.from(data)
  if (e.method === 8) return zlib.inflateRawSync(data)
  throw new Error(`Unsupported zip compression method ${e.method}`)
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

export function xlsxFirstColumn(file: Buffer): string[] {
  const entries = readEntries(file)
  const byName = new Map(entries.map((e) => [e.name, e]))
  const sharedStrings: string[] = []
  const ss = byName.get('xl/sharedStrings.xml')
  if (ss) {
    const xml = readEntryData(file, ss).toString('utf8')
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const texts = [...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]!))
      sharedStrings.push(texts.join(''))
    }
  }
  const sheetName = [...byName.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0]
  if (!sheetName) throw new Error('The workbook has no worksheets')
  const xml = readEntryData(file, byName.get(sheetName)!).toString('utf8')
  const out: string[] = []
  for (const cell of xml.matchAll(/<c r="A\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
    const attrs = cell[1]!
    const inner = cell[2]!
    const type = attrs.match(/t="(\w+)"/)?.[1]
    let value = ''
    if (type === 's') {
      const idx = Number(inner.match(/<v>(\d+)<\/v>/)?.[1] ?? -1)
      value = sharedStrings[idx] ?? ''
    } else if (type === 'inlineStr') {
      value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]!)).join('')
    } else {
      value = decodeXml(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '')
    }
    if (value.trim()) out.push(value.trim())
  }
  if (out.length > 1 && /^(title|game|name|product)s?$/i.test(out[0]!)) out.shift()
  return out
}
