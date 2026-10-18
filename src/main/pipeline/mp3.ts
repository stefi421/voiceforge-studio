/**
 * Minimal MPEG audio frame parser used to (a) verify that bytes returned by
 * the TTS provider are a real MP3 stream, (b) compute duration without any
 * native dependency, and (c) concatenate chunks safely by stripping ID3 tags
 * from every chunk after the first so the result is one continuous stream.
 */

const BITRATES: Record<string, number[]> = {
  // [version][layer] index by bitrate bits (1..14), kbps
  'v1l1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  'v1l2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  'v1l3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  'v2l1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  'v2l2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  'v2l3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
}
const SAMPLE_RATES: Record<string, number[]> = {
  v1: [44100, 48000, 32000],
  v2: [22050, 24000, 16000],
  v25: [11025, 12000, 8000]
}

export interface Mp3Info {
  frames: number
  durationSec: number
  sampleRate: number
  bitrateKbps: number
  valid: boolean
  audioStart: number
}

interface FrameHeader {
  length: number
  samples: number
  sampleRate: number
  bitrate: number
}

function parseHeader(buf: Buffer, offset: number): FrameHeader | null {
  if (offset + 4 > buf.length) return null
  const b1 = buf[offset]!,
    b2 = buf[offset + 1]!,
    b3 = buf[offset + 2]!
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null
  const versionBits = (b2 >> 3) & 0x03 // 0=v2.5, 1=reserved, 2=v2, 3=v1
  const layerBits = (b2 >> 1) & 0x03 // 1=layer3, 2=layer2, 3=layer1
  const bitrateIdx = (b3 >> 4) & 0x0f
  const srIdx = (b3 >> 2) & 0x03
  const padding = (b3 >> 1) & 0x01
  if (versionBits === 1 || layerBits === 0 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null
  const version = versionBits === 3 ? 'v1' : versionBits === 2 ? 'v2' : 'v25'
  const layer = 4 - layerBits // 1,2,3
  const brKey = `${version === 'v1' ? 'v1' : 'v2'}l${layer}`
  const bitrate = BITRATES[brKey]![bitrateIdx]!
  const sampleRate = SAMPLE_RATES[version]![srIdx]!
  if (!bitrate || !sampleRate) return null
  let samples: number
  let length: number
  if (layer === 1) {
    samples = 384
    length = Math.floor(((12 * bitrate * 1000) / sampleRate + padding) * 4)
  } else {
    samples = layer === 2 ? 1152 : version === 'v1' ? 1152 : 576
    length = Math.floor((samples / 8) * ((bitrate * 1000) / sampleRate) + padding)
  }
  if (length < 20) return null
  return { length, samples, sampleRate, bitrate }
}

export function id3v2Length(buf: Buffer): number {
  if (buf.length < 10) return 0
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0
  const flags = buf[5]!
  const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f)
  const footer = flags & 0x10 ? 10 : 0
  return 10 + size + footer
}

export function parseMp3(buf: Buffer): Mp3Info {
  let offset = id3v2Length(buf)
  const audioStart = offset
  let frames = 0
  let totalSamples = 0
  let sampleRate = 0
  let bitrateSum = 0
  // Find first sync
  while (offset < buf.length - 4) {
    const h = parseHeader(buf, offset)
    if (h) {
      // Require the next frame to also parse (avoids false syncs on random bytes)
      const next = parseHeader(buf, offset + h.length)
      if (next || offset + h.length >= buf.length - 4) break
    }
    offset++
  }
  while (offset < buf.length - 4) {
    const h = parseHeader(buf, offset)
    if (!h) {
      // tolerate trailing junk / ID3v1
      if (buf.length - offset <= 128) break
      offset++
      continue
    }
    frames++
    totalSamples += h.samples
    sampleRate = h.sampleRate
    bitrateSum += h.bitrate
    offset += h.length
  }
  const durationSec = sampleRate ? totalSamples / sampleRate : 0
  return {
    frames,
    durationSec,
    sampleRate,
    bitrateKbps: frames ? Math.round(bitrateSum / frames) : 0,
    valid: frames >= 10 && durationSec > 0.2,
    audioStart
  }
}

/**
 * Length of a leading Xing/Info/VBRI header frame at `offset` (0 when the first frame is audio).
 * Such a frame stores the frame count of ITS file: kept in a joined file, players report the
 * duration of the first part only, and mid-stream it plays as a short glitch.
 */
export function vbrHeaderFrameLength(buf: Buffer, offset: number): number {
  const h = parseHeader(buf, offset)
  if (!h) return 0
  const end = Math.min(buf.length, offset + h.length)
  // The tag sits right after the side information (9–32 bytes, +2 with CRC); VBRI at a fixed offset of 32.
  const window = buf.subarray(offset + 4, Math.min(end, offset + 4 + 40)).toString('latin1')
  return /Xing|Info|VBRI/.test(window) ? h.length : 0
}

/** Length of a trailing ID3v1 tag ("TAG" + 125 bytes), 0 when absent. */
export function id3v1Length(buf: Buffer): number {
  return buf.length >= 128 && buf.toString('latin1', buf.length - 128, buf.length - 125) === 'TAG' ? 128 : 0
}

/**
 * Concatenate MP3 chunks into a single stream: the first chunk keeps its ID3v2 tag; ID3v2 tags of
 * later chunks, ID3v1 tags of all but the last chunk and every Xing/Info/VBRI header frame are
 * removed, so the result is one continuous stream whose duration players compute correctly.
 */
export function concatMp3(chunks: Buffer[]): Buffer {
  const parts: Buffer[] = []
  chunks.forEach((c, i) => {
    const tag = id3v2Length(c)
    let start = tag
    start += vbrHeaderFrameLength(c, start)
    const end = i < chunks.length - 1 ? c.length - id3v1Length(c) : c.length
    if (i === 0 && tag > 0) parts.push(c.subarray(0, tag))
    parts.push(c.subarray(start, Math.max(start, end)))
  })
  return Buffer.concat(parts)
}

export function isMp3Format(outputFormat: string): boolean {
  return outputFormat.startsWith('mp3_')
}

export function pcmDuration(bytes: number, outputFormat: string): number | null {
  const m = outputFormat.match(/^pcm_(\d+)$/)
  if (!m) return null
  const rate = Number(m[1])
  return bytes / (rate * 2) // 16-bit mono
}
