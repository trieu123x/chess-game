/**
 * Test dau-cuoi voi cac VAN CO CU THE, biet truoc ket qua.
 *
 * CODE CUA NHOM. Khac voi `bot.js` (danh ngau nhien de sinh tai, khong kiem
 * dinh gi), file nay danh nhung van co ket cuc xac dinh roi doi chieu voi thu
 * server tra ve — neu logic van dau sai o dau, test se chi ra dung cho do.
 *
 * Test tu khoi dong ca he thong: mot rules service va mot game server tren
 * cong rieng, nen chay duoc tren may sach va trong CI ma khong dung toi
 * tien trinh dang chay.
 *
 * Chay:  npm test          (trong thu muc source/bot)
 * Can:   PostgreSQL da co schema (source/database/setup.ps1)
 */
import test from 'node:test'
import assert from 'node:assert'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as cgp from '../common-js/cgp.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PORT = 5599
const RULES_PORT = 6101
const SERVER_JAR = path.join(here, '../server/target/dcgs-server.jar')
const SERVER_CONFIG = path.join(here, '../server/config.properties')
const PASSWORD = 'chess123'

let rulesProcess
let serverProcess

// ---------------------------------------------------------------- ha tang

const sleep = ms => new Promise(done => setTimeout(done, ms))

async function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const trial = net.createConnection({ port, host: '127.0.0.1' })
        trial.once('connect', () => resolve(trial))
        trial.once('error', reject)
      })
      socket.destroy()
      return true
    } catch {
      await sleep(150)
    }
  }
  return false
}

/**
 * Mot client CGP toi gian.
 *
 * `expect(type)` doi dung loai message can, va tu tra loi HEARTBEAT cua server
 * (protocol v1.1) thay vi coi do la message la.
 */
class Client {
  constructor(username) {
    this.username = username
    this.accumulator = new cgp.FrameAccumulator()
    this.inbox = []
    this.waiters = []
    this.seq = 1
  }

  async connect() {
    this.socket = await new Promise((resolve, reject) => {
      const trial = net.createConnection({ port: SERVER_PORT, host: '127.0.0.1' })
      trial.once('connect', () => resolve(trial))
      trial.once('error', reject)
    })
    this.socket.setNoDelay(true)
    this.socket.on('data', chunk => {
      for (const frame of this.accumulator.push(chunk)) {
        if (frame.type === cgp.T.HEARTBEAT) {
          this.send(cgp.T.HEARTBEAT_ACK)
          continue
        }
        this.inbox.push(frame)
        const waiter = this.waiters.shift()
        if (waiter) waiter()
      }
    })
    return this
  }

  send(type, payload = Buffer.alloc(0)) {
    this.socket.write(cgp.encodeFrame(type, this.seq++, payload))
  }

  /** Doi mot message thuoc mot trong cac loai da liet ke. */
  async expect(types, timeoutMs = 10_000) {
    const wanted = Array.isArray(types) ? types : [types]
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = this.inbox.findIndex(frame => wanted.includes(frame.type))
      if (index >= 0) return this.inbox.splice(index, 1)[0]
      if (Date.now() > deadline) {
        const seen = this.inbox.map(frame => cgp.typeName(frame.type)).join(', ') || 'khong co gi'
        throw new Error(`${this.username}: qua han cho ${wanted.map(cgp.typeName).join('/')}; da nhan: ${seen}`)
      }
      await Promise.race([
        new Promise(resolve => this.waiters.push(resolve)),
        sleep(100),
      ])
    }
  }

  async login() {
    this.send(cgp.T.LOGIN, cgp.json({ username: this.username, password: PASSWORD }))
    const frame = await this.expect([cgp.T.LOGIN_OK, cgp.T.ERROR])
    assert.strictEqual(frame.type, cgp.T.LOGIN_OK,
      `${this.username} dang nhap that bai: ${frame.type === cgp.T.ERROR ? frame.payloadText?.() ?? '' : ''}`)
    return cgp.parseJson(frame.payload)
  }

  move(from, to, ply, promo = '') {
    this.send(cgp.T.MOVE, cgp.encodeMove({ from, to, promo, ply }))
  }

  close() {
    this.socket?.destroy()
  }
}

/** Ghep hai client thanh mot van; tra ve {white, black, gameId}. */
async function pairUp(nameWhite, nameBlack, timeControl) {
  const first = await new Client(nameWhite).connect()
  const second = await new Client(nameBlack).connect()
  await first.login()
  await second.login()

  first.send(cgp.T.QUEUE_JOIN, cgp.json({ timeControl }))
  await sleep(120)                                  // dam bao thu tu vao hang doi
  second.send(cgp.T.QUEUE_JOIN, cgp.json({ timeControl }))

  const firstMatch = cgp.parseJson((await first.expect(cgp.T.MATCH_FOUND)).payload)
  const secondMatch = cgp.parseJson((await second.expect(cgp.T.MATCH_FOUND)).payload)
  await first.expect(cgp.T.GAME_SNAPSHOT)
  await second.expect(cgp.T.GAME_SNAPSHOT)

  assert.strictEqual(firstMatch.gameId, secondMatch.gameId, 'hai nguoi phai o cung mot van')
  assert.notStrictEqual(firstMatch.color, secondMatch.color, 'hai nguoi phai khac mau quan')

  const white = firstMatch.color === 'w' ? first : second
  const black = firstMatch.color === 'w' ? second : first
  return { white, black, gameId: firstMatch.gameId }
}

/** Danh mot chuoi nuoc di UCI cho san, doi server xac nhan tung nuoc. */
async function playLine(white, black, line) {
  const applied = []
  for (let ply = 0; ply < line.length; ply++) {
    const mover = ply % 2 === 0 ? white : black
    const uci = line[ply]
    mover.move(uci.slice(0, 2), uci.slice(2, 4), ply, uci.length > 4 ? uci[4] : '')

    // Ca hai ben deu phai nhan duoc MOVE_APPLIED cua cung nuoc do.
    const forMover = cgp.decodeMoveApplied((await mover.expect(cgp.T.MOVE_APPLIED)).payload)
    const forPeer = cgp.decodeMoveApplied((await (ply % 2 === 0 ? black : white).expect(cgp.T.MOVE_APPLIED)).payload)

    assert.strictEqual(forMover.ply, ply + 1, `nuoc ${ply + 1}: so thu tu sai`)
    assert.deepStrictEqual(
      { from: forMover.from, to: forMover.to },
      { from: forPeer.from, to: forPeer.to },
      `nuoc ${ply + 1}: hai ben nhan duoc noi dung khac nhau`)
    applied.push(forMover)
  }
  return applied
}

// ---------------------------------------------------------------- khoi dong

test.before(async () => {
  rulesProcess = spawn(process.execPath,
    [path.join(here, '../rules-service/index.js'), '--port', String(RULES_PORT)],
    { stdio: 'ignore' })
  assert.ok(await waitForPort(RULES_PORT), 'rules service khong khoi dong duoc')

  serverProcess = spawn('java', ['-jar', SERVER_JAR, '--config', SERVER_CONFIG], {
    stdio: 'ignore',
    env: {
      ...process.env,
      SERVER_PORT: String(SERVER_PORT),
      RULES_ENDPOINTS: `127.0.0.1:${RULES_PORT}`,
      HEARTBEAT_INTERVALMS: '2000',
    },
  })
  assert.ok(await waitForPort(SERVER_PORT),
    `game server khong khoi dong duoc - da build chua? (mvn package trong source/)`)
})

test.after(() => {
  serverProcess?.kill()
  rulesProcess?.kill()
})

// ---------------------------------------------------------------- cac van co

test('Van chieu het nhanh nhat (Fool mate): 1.f3 e5 2.g4 Qh4#', async () => {
  const { white, black } = await pairUp('bot_101', 'bot_102', '300+2')

  const applied = await playLine(white, black, ['f2f3', 'e7e5', 'g2g4', 'd8h4'])

  const last = applied.at(-1)
  assert.ok(cgp.hasFlag(last.flags, cgp.FLAG.CHECKMATE), 'nuoc cuoi phai duoc danh dau chieu het')
  assert.ok(cgp.hasFlag(last.flags, cgp.FLAG.CHECK), 'chieu het thi cung phai co co CHECK')

  const over = cgp.parseJson((await black.expect(cgp.T.GAME_OVER)).payload)
  assert.strictEqual(over.result, '0-1')
  assert.strictEqual(over.reason, 'checkmate')
  assert.ok(over.pgn.includes('Qh4#'), 'PGN phai ghi nuoc chieu het')
  assert.ok(over.pgn.includes('[Result "0-1"]'))
  assert.ok(over.eloDelta > 0, 'nguoi thang phai duoc cong diem')

  white.close()
  black.close()
})

test('Van Scholar mate: ben Trang thang sau 7 nuoc', async () => {
  const { white, black } = await pairUp('bot_103', 'bot_104', '301+2')

  await playLine(white, black, ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'])

  const over = cgp.parseJson((await white.expect(cgp.T.GAME_OVER)).payload)
  assert.strictEqual(over.result, '1-0')
  assert.strictEqual(over.reason, 'checkmate')
  assert.ok(over.pgn.includes('Qxf7#'))

  white.close()
  black.close()
})

test('Nuoc di khong hop le bi tu choi, van KHONG doi trang thai', async () => {
  const { white, black } = await pairUp('bot_105', 'bot_106', '302+2')

  // Tot khong the di ba o.
  white.move('e2', 'e5', 0)
  const rejected = cgp.parseJson((await white.expect(cgp.T.MOVE_REJECTED)).payload)
  assert.strictEqual(rejected.code, 3002)
  assert.strictEqual(rejected.expectedPly, 0, 'van phai dung nguyen o nuoc 0')

  // Doi thu KHONG duoc nhan gi ca — trang thai chung khong he thay doi.
  await assert.rejects(() => black.expect(cgp.T.MOVE_APPLIED, 800),
    /qua han/, 'doi thu khong duoc thay nuoc di bi tu choi')

  // Va van van danh tiep binh thuong.
  const applied = await playLine(white, black, ['e2e4'])
  assert.strictEqual(applied[0].ply, 1)

  white.close()
  black.close()
})

test('Di khi khong phai luot minh bi tu choi bang ma 3001', async () => {
  const { white, black } = await pairUp('bot_107', 'bot_108', '303+2')

  black.move('e7', 'e5', 0)
  const frame = await black.expect([cgp.T.MOVE_REJECTED, cgp.T.ERROR])
  const payload = cgp.parseJson(frame.payload)
  assert.strictEqual(payload.code ?? payload.code, 3001)

  white.close()
  black.close()
})

test('Nuoc di gui trung (ply cu) bi bo qua bang ma 3005', async () => {
  const { white, black } = await pairUp('bot_109', 'bot_110', '304+2')

  await playLine(white, black, ['d2d4', 'd7d5'])

  // Gui lai nuoc dau voi so thu tu da cu.
  white.move('d2', 'd4', 0)
  const stale = cgp.parseJson((await white.expect(cgp.T.MOVE_REJECTED)).payload)
  assert.strictEqual(stale.code, 3005)
  assert.strictEqual(stale.expectedPly, 2, 'server phai bao so thu tu dung de client dong bo lai')

  white.close()
  black.close()
})

test('Dau hang: doi thu thang ngay, PGN ghi ly do resign', async () => {
  const { white, black } = await pairUp('bot_111', 'bot_112', '305+2')

  await playLine(white, black, ['e2e4', 'c7c5'])
  white.send(cgp.T.RESIGN)

  const over = cgp.parseJson((await black.expect(cgp.T.GAME_OVER)).payload)
  assert.strictEqual(over.result, '0-1')
  assert.strictEqual(over.reason, 'resign')
  assert.ok(over.pgn.includes('[Termination "resign"]'))
  assert.ok(over.pgn.includes('1. e4 c5'), 'PGN phai giu lai cac nuoc da danh')

  white.close()
  black.close()
})

test('Xin hoa va dong y: ket qua 1/2-1/2', async () => {
  const { white, black } = await pairUp('bot_113', 'bot_114', '306+2')

  await playLine(white, black, ['g1f3', 'g8f6'])
  white.send(cgp.T.DRAW_OFFER)
  await black.expect(cgp.T.DRAW_OFFERED)
  black.send(cgp.T.DRAW_REPLY, Buffer.from([1]))

  const over = cgp.parseJson((await white.expect(cgp.T.GAME_OVER)).payload)
  assert.strictEqual(over.result, '1/2-1/2')
  assert.strictEqual(over.reason, 'agreement')

  white.close()
  black.close()
})

test('Tu choi hoa thi van danh tiep', async () => {
  const { white, black } = await pairUp('bot_115', 'bot_116', '307+2')

  await playLine(white, black, ['e2e4'])
  black.send(cgp.T.DRAW_OFFER)
  await white.expect(cgp.T.DRAW_OFFERED)
  white.send(cgp.T.DRAW_REPLY, Buffer.from([0]))

  const applied = await playLine(white, black, [])   // khong co nuoc nao
  assert.strictEqual(applied.length, 0)

  // Van van song: ben Den di duoc nuoc tiep theo.
  black.move('e7', 'e5', 1)
  const next = cgp.decodeMoveApplied((await black.expect(cgp.T.MOVE_APPLIED)).payload)
  assert.strictEqual(next.ply, 2)

  white.close()
  black.close()
})

test('Dong ho: server tru gio cua ben vua di, ben kia giu nguyen', async () => {
  const { white, black } = await pairUp('bot_117', 'bot_118', '300+0')

  const applied = await playLine(white, black, ['e2e4', 'e7e5'])

  const afterWhite = applied[0]
  const afterBlack = applied[1]
  assert.ok(afterWhite.clockWhiteMs < 300_000, 'ben Trang phai bi tru gio sau khi di');
  assert.strictEqual(afterWhite.clockBlackMs, 300_000, 'ben Den chua di thi chua bi tru');
  assert.ok(afterBlack.clockBlackMs < 300_000, 'den luot ben Den bi tru');
  assert.strictEqual(afterBlack.clockWhiteMs, afterWhite.clockWhiteMs,
    'gio cua ben Trang khong duoc thay doi khi ben Den di');

  white.close()
  black.close()
})

test('Nuoc an quan va nuoc chieu duoc danh dau bang co tuong ung', async () => {
  const { white, black } = await pairUp('bot_119', 'bot_120', '308+2')

  // 1.e4 d5 2.exd5 (an quan) ... 3.Bb5+ (chieu)
  const applied = await playLine(white, black,
    ['e2e4', 'd7d5', 'e4d5', 'b8d7', 'f1b5'])

  assert.ok(cgp.hasFlag(applied[2].flags, cgp.FLAG.CAPTURE), 'exd5 phai co co CAPTURE')
  assert.ok(cgp.hasFlag(applied[4].flags, cgp.FLAG.CHECK), 'Bb5+ phai co co CHECK')
  assert.ok(!cgp.hasFlag(applied[0].flags, cgp.FLAG.CAPTURE), 'e4 khong an quan nao')

  white.close()
  black.close()
})
