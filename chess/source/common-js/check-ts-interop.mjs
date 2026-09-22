/**
 * Doi chieu ban TypeScript (trinh duyet) voi cung bo testvectors.json.
 *
 * Node 22 chay thang file .ts nho --experimental-strip-types, nen khong can
 * dung den trinh duyet chi de kiem tra codec.
 * Chay:  node --experimental-strip-types check-ts-interop.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ts = await import(pathToFileURL(path.join(here, '../web-client/src/net/cgp.ts')).href)
const vectors = JSON.parse(fs.readFileSync(path.join(here, 'testvectors.json'), 'utf8'))

const toHex = bytes => Buffer.from(bytes).toString('hex')
const payloadFor = vector => {
  switch (vector.payloadKind) {
    case 'json': return ts.json(vector.payload)
    case 'move': return ts.encodeMove({ ...vector.payload, promo: vector.payload.promo || undefined })
    case 'moveApplied': return ts.encodeMoveApplied
      ? ts.encodeMoveApplied(vector.payload)
      : null
    case 'clockPong': return null            // ban TS chi giai ma, khong ma hoa (viec cua server)
    default: return new Uint8Array(0)
  }
}

let checked = 0
let failed = 0
for (const vector of vectors.frames) {
  if (ts.T[vector.type] === undefined) {
    // Trinh duyet chi noi CGP; RVP la chuyen rieng giua server va rules service.
    console.log(`  bo qua ${vector.name} (${vector.type} thuoc RVP, khong co trong ban trinh duyet)`)
    continue
  }
  const payload = payloadFor(vector)
  if (payload === null) {
    console.log(`  bo qua ${vector.name} (ban TS khong ma hoa loai nay)`)
    continue
  }
  const actual = toHex(ts.encodeFrame(ts.T[vector.type], vector.seq, payload))
  checked += 1
  if (actual !== vector.hex) {
    failed += 1
    console.log(`[LOI] ${vector.name}\n      mong doi ${vector.hex}\n      nhan duoc ${actual}`)
    continue
  }
  // Giai ma nguoc: doc duoc frame do ngon ngu khac sinh ra.
  const buffer = Buffer.from(vector.hex, 'hex')
  const frame = ts.decodeFrame(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length))
  if (frame.type !== ts.T[vector.type] || frame.seq !== vector.seq) {
    failed += 1
    console.log(`[LOI] ${vector.name}: giai ma sai type/seq`)
    continue
  }
  console.log(`[OK]  ${vector.name}`)
}

console.log(failed ? `\nTHAT BAI: ${failed}/${checked}` : `\nKET QUA: ban TypeScript khop ${checked}/${checked} vector`)
process.exit(failed ? 1 : 0)
