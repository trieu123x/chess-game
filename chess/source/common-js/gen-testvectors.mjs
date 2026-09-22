import fs from 'node:fs'
import * as cgp from './cgp.js'

const vectors = [
  { name: 'login', type: 'LOGIN', seq: 1, payloadKind: 'json',
    payload: { username: 'alice', password: 'chess123' } },
  { name: 'heartbeat', type: 'HEARTBEAT', seq: 42, payloadKind: 'empty', payload: null },
  { name: 'move-e2e4', type: 'MOVE', seq: 2, payloadKind: 'move',
    payload: { from: 'e2', to: 'e4', promo: '', ply: 0 } },
  { name: 'move-promotion-knight', type: 'MOVE', seq: 3, payloadKind: 'move',
    payload: { from: 'e7', to: 'e8', promo: 'n', ply: 41 } },
  { name: 'move-applied-check', type: 'MOVE_APPLIED', seq: 4, payloadKind: 'moveApplied',
    payload: { ply: 13, from: 'g1', to: 'f3', promo: '', flags: 17,
               clockWhiteMs: 178500, clockBlackMs: 181000, serverProcessMs: 4 } },
  { name: 'move-applied-mate', type: 'MOVE_APPLIED', seq: 5, payloadKind: 'moveApplied',
    payload: { ply: 61, from: 'd1', to: 'h5', promo: '', flags: 48,
               clockWhiteMs: 5400, clockBlackMs: 0, serverProcessMs: 7 } },
  { name: 'clock-pong', type: 'CLOCK_PONG', seq: 6, payloadKind: 'clockPong',
    payload: { t1: 1000, t2: 1040, t3: 1041 } },
  { name: 'game-over', type: 'GAME_OVER', seq: 7, payloadKind: 'json',
    payload: { result: '1-0', reason: 'checkmate', eloDelta: 8 } },
  { name: 'rules-validate', type: 'RULES_VALIDATE', seq: 8, payloadKind: 'json',
    payload: { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
               from: 'e2', to: 'e4', promo: '' } },
  { name: 'error-illegal-move', type: 'ERROR', seq: 9, payloadKind: 'json',
    payload: { code: 3002, message: 'Nuoc di khong hop le' } },
]

const encodePayload = vector => {
  switch (vector.payloadKind) {
    case 'json': return cgp.json(vector.payload)
    case 'move': return cgp.encodeMove(vector.payload)
    case 'moveApplied': return cgp.encodeMoveApplied(vector.payload)
    case 'clockPong': return cgp.encodeClockPong(vector.payload.t1, vector.payload.t2, vector.payload.t3)
    default: return Buffer.alloc(0)
  }
}

const out = {
  protocol: 'CGP',
  version: '1.0',
  note: 'Hop dong chung cho ba ban hien thuc codec (Java / Node / TypeScript). '
      + 'Moi ban phai sinh ra dung chuoi hex nay va giai ma nguoc lai duoc. '
      + 'Day la bang chung cho dong gop N6 - protocol doc lap ngon ngu.',
  byteOrder: 'big-endian',
  frameLayout: 'LEN(u32) | TYPE(u8) | SEQ(u32) | PAYLOAD,  LEN = 5 + payload.length',
  frames: vectors.map(vector => ({
    ...vector,
    hex: cgp.encodeFrame(cgp.T[vector.type], vector.seq, encodePayload(vector)).toString('hex'),
  })),
}

fs.writeFileSync('testvectors.json', JSON.stringify(out, null, 2) + '\n')
console.log(`${out.frames.length} vector, tong ${out.frames.reduce((sum, f) => sum + f.hex.length / 2, 0)} byte`)
for (const frame of out.frames) console.log(`  ${frame.name.padEnd(22)} ${frame.hex}`)
