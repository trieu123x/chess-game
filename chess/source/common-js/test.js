/**
 * Bộ test codec — chạy: node --test source/common-js
 *
 * Phủ đúng 6 yêu cầu bắt buộc ở PROTOCOL.md §C và test T01/T02 của PLAN.md §8.
 */
import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as cgp from './cgp.js'

const here = path.dirname(fileURLToPath(import.meta.url))

test('1. encode/decode khứ hồi mọi loại payload', () => {
  const login = cgp.encodeFrame(cgp.T.LOGIN, 7, cgp.json({ username: 'alice', password: 'chess123' }))
  const frame = cgp.decodeFrame(login)
  assert.strictEqual(frame.type, cgp.T.LOGIN)
  assert.strictEqual(frame.seq, 7)
  assert.deepStrictEqual(cgp.parseJson(frame.payload), { username: 'alice', password: 'chess123' })

  const move = cgp.decodeMove(cgp.encodeMove({ from: 'e2', to: 'e4', ply: 0 }))
  assert.deepStrictEqual(move, { from: 'e2', to: 'e4', promo: '', flags: 0, ply: 0 })

  const promotion = cgp.decodeMove(cgp.encodeMove({ from: 'e7', to: 'e8', promo: 'n', ply: 41 }))
  assert.strictEqual(promotion.promo, 'n')
  assert.strictEqual(promotion.ply, 41)

  const applied = cgp.decodeMoveApplied(cgp.encodeMoveApplied({
    ply: 12, from: 'g1', to: 'f3', promo: '', flags: cgp.FLAG.CHECK | cgp.FLAG.CAPTURE,
    clockWhiteMs: 178_500, clockBlackMs: 180_000, serverProcessMs: 3,
  }))
  assert.strictEqual(applied.ply, 12)
  assert.strictEqual(applied.from, 'g1')
  assert.strictEqual(applied.to, 'f3')
  assert.strictEqual(applied.clockWhiteMs, 178_500)
  assert.ok(cgp.hasFlag(applied.flags, cgp.FLAG.CHECK))
  assert.ok(cgp.hasFlag(applied.flags, cgp.FLAG.CAPTURE))
  assert.ok(!cgp.hasFlag(applied.flags, cgp.FLAG.CHECKMATE))

  const pong = cgp.decodeClockPong(cgp.encodeClockPong(1000, 1040, 1041))
  assert.deepStrictEqual(pong, { t1: 1000, t2: 1040, t3: 1041 })
})

test('2. half-packet: một frame cắt thành 3 lần ghi', () => {
  const frame = cgp.encodeFrame(cgp.T.MOVE, 1, cgp.encodeMove({ from: 'd2', to: 'd4', ply: 0 }))
  const accumulator = new cgp.FrameAccumulator()
  assert.strictEqual(accumulator.push(frame.subarray(0, 2)).length, 0)
  assert.strictEqual(accumulator.push(frame.subarray(2, 6)).length, 0)
  const frames = accumulator.push(frame.subarray(6))
  assert.strictEqual(frames.length, 1)
  assert.strictEqual(cgp.decodeMove(frames[0].payload).from, 'd2')
})

test('3. gộp packet: 5 frame trong một lần ghi', () => {
  const chunks = []
  for (let index = 0; index < 5; index += 1) {
    chunks.push(cgp.encodeFrame(cgp.T.HEARTBEAT, index))
  }
  const frames = new cgp.FrameAccumulator().push(Buffer.concat(chunks))
  assert.strictEqual(frames.length, 5)
  assert.deepStrictEqual(frames.map(frame => frame.seq), [0, 1, 2, 3, 4])
})

test('4. frame quá lớn bị từ chối bằng mã 2003, không cấp phát theo LEN', () => {
  const header = Buffer.alloc(9)
  header.writeUInt32BE(cgp.MAX_FRAME + 1, 0)
  header.writeUInt8(cgp.T.MOVE, 4)
  assert.throws(() => new cgp.FrameAccumulator().push(header), error => error.code === cgp.ERR.FRAME_TOO_LARGE)
  assert.throws(() => cgp.encodeFrame(cgp.T.MOVE, 1, Buffer.alloc(cgp.MAX_FRAME)),
    error => error.code === cgp.ERR.FRAME_TOO_LARGE)
})

test('5. dữ liệu hỏng trả đúng mã lỗi, không crash', () => {
  const zeroLen = Buffer.alloc(9)
  zeroLen.writeUInt32BE(0, 0)
  assert.throws(() => new cgp.FrameAccumulator().push(zeroLen), error => error.code === cgp.ERR.MALFORMED_FRAME)

  assert.throws(() => cgp.decodeFrame(Buffer.alloc(4)), error => error.code === cgp.ERR.MALFORMED_FRAME)
  assert.throws(() => cgp.parseJson(Buffer.from('{khong-phai-json')), error => error.code === cgp.ERR.MALFORMED_FRAME)
  assert.throws(() => cgp.squareToIndex('z9'), error => error.code === cgp.ERR.MALFORMED_FRAME)
  assert.throws(() => cgp.decodeMove(Buffer.alloc(7)), error => error.code === cgp.ERR.MALFORMED_FRAME)
  assert.throws(() => cgp.decodeMoveApplied(Buffer.alloc(15)), error => error.code === cgp.ERR.MALFORMED_FRAME)
})

test('6. chỉ số ô khớp quy ước a1=0 .. h8=63', () => {
  assert.strictEqual(cgp.squareToIndex('a1'), 0)
  assert.strictEqual(cgp.squareToIndex('h1'), 7)
  assert.strictEqual(cgp.squareToIndex('a8'), 56)
  assert.strictEqual(cgp.squareToIndex('h8'), 63)
  assert.strictEqual(cgp.squareToIndex('e4'), 28)
  for (let index = 0; index < 64; index += 1) {
    assert.strictEqual(cgp.squareToIndex(cgp.indexToSquare(index)), index)
  }
})

test('7. interop: khớp từng byte với testvectors.json', () => {
  const file = path.join(here, 'testvectors.json')
  const vectors = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const vector of vectors.frames) {
    const payload = vector.payloadKind === 'json' ? cgp.json(vector.payload)
      : vector.payloadKind === 'move' ? cgp.encodeMove(vector.payload)
      : vector.payloadKind === 'moveApplied' ? cgp.encodeMoveApplied(vector.payload)
      : vector.payloadKind === 'clockPong' ? cgp.encodeClockPong(vector.payload.t1, vector.payload.t2, vector.payload.t3)
      : Buffer.alloc(0)
    const actual = cgp.encodeFrame(cgp.T[vector.type], vector.seq, payload).toString('hex')
    assert.strictEqual(actual, vector.hex, `vector ${vector.name}`)
    // Và giải mã ngược lại cho ra đúng frame.
    const frame = cgp.decodeFrame(Buffer.from(vector.hex, 'hex'))
    assert.strictEqual(frame.type, cgp.T[vector.type])
    assert.strictEqual(frame.seq, vector.seq)
  }
})

test('8. flagsFromMove dựng đúng cờ từ nước đi chess.js', () => {
  const capture = cgp.flagsFromMove({ captured: 'p', san: 'exd5', flags: 'c' }, 'ongoing')
  assert.ok(cgp.hasFlag(capture, cgp.FLAG.CAPTURE))

  const castle = cgp.flagsFromMove({ san: 'O-O', flags: 'k' }, 'ongoing')
  assert.ok(cgp.hasFlag(castle, cgp.FLAG.CASTLE))

  const mate = cgp.flagsFromMove({ san: 'Qh7#', flags: 'n' }, 'checkmate')
  assert.ok(cgp.hasFlag(mate, cgp.FLAG.CHECKMATE))
  assert.ok(cgp.hasFlag(mate, cgp.FLAG.CHECK), 'chiếu hết cũng là chiếu')

  const enPassant = cgp.flagsFromMove({ captured: 'p', san: 'exd6', flags: 'e' }, 'ongoing')
  assert.ok(cgp.hasFlag(enPassant, cgp.FLAG.EN_PASSANT))
})

test('9. bù RTT tính đúng theo công thức NTP', () => {
  // Server nhanh hơn client 1000 ms, đường truyền 40 ms mỗi chiều.
  const { offsetMs, rttMs } = cgp.clockOffset({ t1: 0, t2: 1040, t3: 1041 }, 81)
  assert.strictEqual(rttMs, 80)
  assert.strictEqual(offsetMs, 1000)
  assert.strictEqual(cgp.median([5, 1, 3]), 3)
  assert.strictEqual(cgp.median([4, 2]), 3)
})
