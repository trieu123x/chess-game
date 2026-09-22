/**
 * Test Rules Service: tu khoi dong mot instance that tren cong rieng, noi RVP
 * qua TCP nhu server Java se lam, roi kiem tra tung truong hop luat co.
 *
 * Chay:  npm test
 */
import test from 'node:test'
import assert from 'node:assert'
import net from 'node:net'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cgp from '../common-js/cgp.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = 6099
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

let service
let socket
let accumulator
let seq = 1
const waiting = new Map()          // seq -> resolve, giong correlation id ben server

test.before(async () => {
  service = spawn(process.execPath, [path.join(here, 'index.js'), '--port', String(PORT)],
    { stdio: 'ignore' })

  // Cho cong mo: thu ket noi lai vai lan thay vi ngu mot khoang co dinh.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      socket = await new Promise((resolve, reject) => {
        const trial = net.createConnection({ port: PORT, host: '127.0.0.1' })
        trial.once('connect', () => resolve(trial))
        trial.once('error', reject)
      })
      break
    } catch {
      await new Promise(done => setTimeout(done, 100))
    }
  }
  assert.ok(socket, `khong ket noi duoc toi rules service o cong ${PORT}`)

  accumulator = new cgp.FrameAccumulator()
  socket.on('data', chunk => {
    for (const frame of accumulator.push(chunk)) {
      const resolve = waiting.get(frame.seq)
      if (resolve) {
        waiting.delete(frame.seq)
        resolve(frame)
      }
    }
  })
})

test.after(() => {
  socket?.destroy()
  service?.kill()
})

/** Gui mot request RVP va cho dung phan hoi mang `seq` tuong ung. */
function ask(type, payload) {
  const mySeq = seq++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`qua han cho phan hoi seq=${mySeq}`)), 5_000)
    waiting.set(mySeq, frame => { clearTimeout(timer); resolve(frame) })
    socket.write(cgp.encodeFrame(type, mySeq, cgp.json(payload)))
  })
}

test('M1: e2e4 tu the co dau tra ve RULES_OK', async () => {
  const frame = await ask(cgp.T.RULES_VALIDATE, { fen: START_FEN, from: 'e2', to: 'e4', promo: '' })
  assert.strictEqual(frame.type, cgp.T.RULES_OK)

  const result = cgp.parseJson(frame.payload)
  assert.strictEqual(result.legal, true)
  assert.strictEqual(result.san, 'e4')
  assert.strictEqual(result.uci, 'e2e4')
  assert.strictEqual(result.status, 'ongoing')
  assert.ok(result.fenAfter.startsWith('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b'))
})

test('nuoc di khong hop le bi tu choi bang RULES_ILLEGAL', async () => {
  const frame = await ask(cgp.T.RULES_VALIDATE, { fen: START_FEN, from: 'e2', to: 'e5', promo: '' })
  assert.strictEqual(frame.type, cgp.T.RULES_ILLEGAL)
  assert.strictEqual(cgp.parseJson(frame.payload).code, cgp.ERR.ILLEGAL_MOVE)
})

test('di quan doi thu khi khong phai luot cung bi tu choi', async () => {
  const frame = await ask(cgp.T.RULES_VALIDATE, { fen: START_FEN, from: 'e7', to: 'e5', promo: '' })
  assert.strictEqual(frame.type, cgp.T.RULES_ILLEGAL)
})

test('X27: phong cap thieu quan tra ve 3006 chu khong tu chon Hau', async () => {
  const frame = await ask(cgp.T.RULES_VALIDATE,
    { fen: '8/4P3/8/8/8/8/8/K6k w - - 0 1', from: 'e7', to: 'e8', promo: '' })
  assert.strictEqual(frame.type, cgp.T.RULES_ILLEGAL)
  assert.strictEqual(cgp.parseJson(frame.payload).code, cgp.ERR.PROMOTION_REQUIRED)
})

test('phong cap co chon quan thi hop le va bat dung co PROMOTION', async () => {
  const frame = await ask(cgp.T.RULES_VALIDATE,
    { fen: '8/4P3/8/8/8/8/8/K6k w - - 0 1', from: 'e7', to: 'e8', promo: 'n' })
  assert.strictEqual(frame.type, cgp.T.RULES_OK)

  const result = cgp.parseJson(frame.payload)
  assert.strictEqual(result.uci, 'e7e8n')
  assert.ok(cgp.hasFlag(result.flags, cgp.FLAG.PROMOTION))
})

test('chieu het duoc bao bang status va co CHECKMATE', async () => {
  // Chieu het hai nuoc: 1.f3 e5 2.g4 Qh4#
  const frame = await ask(cgp.T.RULES_VALIDATE,
    { fen: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2',
      from: 'd8', to: 'h4', promo: '' })
  assert.strictEqual(frame.type, cgp.T.RULES_OK)

  const result = cgp.parseJson(frame.payload)
  assert.strictEqual(result.status, 'checkmate')
  assert.strictEqual(result.san, 'Qh4#')
  assert.ok(cgp.hasFlag(result.flags, cgp.FLAG.CHECKMATE))
  assert.ok(cgp.hasFlag(result.flags, cgp.FLAG.CHECK), 'chieu het cung phai co co CHECK')
})

test('X29: vua doi vua duoc bao la khong du quan chieu het', async () => {
  const frame = await ask(cgp.T.RULES_VALIDATE,
    { fen: '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1', from: 'e2', to: 'e4', promo: '' })
  const result = cgp.parseJson(frame.payload)
  assert.strictEqual(result.status, 'ongoing')

  const bare = await ask(cgp.T.RULES_VALIDATE,
    { fen: '8/8/8/4k3/8/8/4K3/8 w - - 0 1', from: 'e2', to: 'e3', promo: '' })
  assert.strictEqual(cgp.parseJson(bare.payload).status, 'draw_insufficient')
})

test('nhap thanh duoc nhan dien bang co CASTLE', async () => {
  const frame = await ask(cgp.T.RULES_VALIDATE,
    { fen: 'rnbqkbnr/pppppppp/8/8/8/5NP1/PPPPPPBP/RNBQK2R w KQkq - 0 1', from: 'e1', to: 'g1', promo: '' })
  const result = cgp.parseJson(frame.payload)
  assert.strictEqual(result.san, 'O-O')
  assert.ok(cgp.hasFlag(result.flags, cgp.FLAG.CASTLE))
})

test('RULES_LEGAL_MOVES tra ve 20 nuoc o the co dau', async () => {
  const frame = await ask(cgp.T.RULES_LEGAL_MOVES, { fen: START_FEN })
  assert.strictEqual(frame.type, cgp.T.RULES_LEGAL_MOVES_RESULT)
  assert.strictEqual(cgp.parseJson(frame.payload).moves.length, 20)
})

test('FEN hong tra ve RULES_ERROR, service van song', async () => {
  const frame = await ask(cgp.T.RULES_VALIDATE, { fen: 'khong-phai-fen', from: 'e2', to: 'e4', promo: '' })
  assert.strictEqual(frame.type, cgp.T.RULES_ERROR)

  const stillAlive = await ask(cgp.T.RULES_PING, {})
  assert.strictEqual(stillAlive.type, cgp.T.RULES_OK)
})
