/**
 * Bot "gian lan" — cong cu do cua thi nghiem E6 va cua cac ca kiem thu
 * T01, T03, T04, T15 trong PLAN.md §8.
 *
 * CODE CUA NHOM.
 *
 * Cau hoi cua E6: server co thuc su la nguon chan ly khong? Neu co thi MOI
 * request sai phai bi tu choi voi dung ma loi, server phai song, va cac ban co
 * khac phai khong he bi anh huong.
 *
 * Cach do: mot ban co "nan nhan" chay binh thuong o nen, trong khi cac ket noi
 * tan cong ban vao server. Do tre cua ban nan nhan duoc do TRUOC, TRONG va SAU
 * dot tan cong — neu co lap loi that thi ba con so nay phai gan nhu nhau.
 *
 * Chay:  node cheat.js --out ../../statics/results/e6/e6.csv
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { Chess } from 'chess.js'
import * as cgp from '../common-js/cgp.js'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const HOST = argOf('host', process.env.SERVER_HOST ?? '127.0.0.1')
const PORT = Number(argOf('port', process.env.SERVER_PORT ?? 5555))
const PASSWORD = argOf('pass', 'chess123')
const OUT = argOf('out', null)
// Tai khoan dung cho thi nghiem nay. schema.sql tao san bot_1..bot_400; lay o
// cuoi dai de khong dam vao bot sinh tai (bot.js danh so tu 1 len).
const FIRST = Number(argOf('first', 390))
const VERBOSE = argv.includes('--verbose')

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000
/**
 * Gian cach giua cac request tan cong.
 *
 * Gioi han `conn.maxMsgPerSec` mac dinh la 50. Neu ban toi da toc do thi cai bi do se la
 * rate limiter (4005) chu khong phai tang kiem tra luat — va E6 hoi ve tang
 * kiem tra luat. Rate limit duoc do rieng o nhom "flood".
 */
const PACE_MS = Number(argOf('pace', 30))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ------------------------------------------------------- ket noi tien ich

/**
 * Mot ket noi CGP thu cong: gui gi cung duoc, ke ca byte sai dinh dang.
 *
 * Co tinh khong dung lai `bot.js`: bot la mot client TU TE, con o day ta can
 * mot client co the pha luat o tung lop mot — tu byte cua frame cho toi luat
 * co — de xem server chan o dau.
 */
class RawClient {
  constructor(name) {
    this.name = name
    this.socket = net.createConnection({ host: HOST, port: PORT })
    this.socket.setNoDelay(true)
    this.accumulator = new cgp.FrameAccumulator()
    this.seq = 1
    this.waiters = []
    this.received = []
    this.closed = false

    this.ready = new Promise((resolve, reject) => {
      this.socket.once('connect', resolve)
      this.socket.once('error', reject)
    })
    this.socket.on('data', chunk => {
      let frames = []
      try {
        frames = this.accumulator.push(chunk)
      } catch {
        return                   // server gui gi do ta khong doc duoc: bo qua
      }
      for (const frame of frames) {
        this.received.push(frame)
        const waiter = this.waiters.shift()
        if (waiter) waiter(frame)
      }
    })
    this.socket.on('close', () => {
      this.closed = true
      for (const waiter of this.waiters.splice(0)) waiter(null)
    })
    this.socket.on('error', () => { this.closed = true })
  }

  send(type, payload = Buffer.alloc(0)) {
    if (this.closed) return
    this.socket.write(cgp.encodeFrame(type, this.seq++, payload))
  }

  /** Gui byte tho — dung cho frame co y lam hong (T01). */
  sendRaw(bytes) {
    if (this.closed) return
    this.socket.write(bytes)
  }

  /**
   * Cho mot frame, het gio thi tra ve null.
   *
   * Khi het gio phai GO waiter ra khoi hang doi. Neu de lai, no se "an" mat
   * frame ke tiep va moi lan cho sau do deu het gio — mot loi lam ca bang ket
   * qua cua E6 trong nhu server khong tra loi gi, trong khi that ra server tra
   * loi day du.
   */
  next(timeoutMs = 2500) {
    return new Promise(resolve => {
      const waiter = frame => {
        clearTimeout(timer)
        resolve(frame)
      }
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve(null)
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  /** Cho frame dau tien thuoc mot trong cac TYPE quan tam. */
  async waitFor(types, timeoutMs = 5000) {
    const deadline = now() + timeoutMs
    for (;;) {
      const frame = await this.next(Math.max(100, deadline - now()))
      if (!frame) return null
      if (types.includes(frame.type)) return frame
    }
  }

  async login(username) {
    await this.ready
    this.send(cgp.T.LOGIN, cgp.json({ username, password: PASSWORD }))
    return this.waitFor([cgp.T.LOGIN_OK, cgp.T.ERROR])
  }

  close() {
    this.closed = true
    this.socket.destroy()
  }
}

/** Doc ma loi tu ERROR hoac MOVE_REJECTED; tra ve null neu khong phai loi. */
function errorCodeOf(frame) {
  if (!frame) return null
  if (frame.type === cgp.T.ERROR || frame.type === cgp.T.MOVE_REJECTED) {
    try {
      return cgp.parseJson(frame.payload).code
    } catch {
      return null
    }
  }
  return null
}

// --------------------------------------------------------- ban co nan nhan

/**
 * Hai bot danh mot van binh thuong, do tre tung nuoc.
 *
 * Day la "nhan chung" cua E6: neu tan cong lam anh huong toi cac ban khac thi
 * do tre o day se tang vot trong dot tan cong.
 */
function startVictimGame(prefix, onLatency) {
  const bots = []
  const playing = []
  for (const index of [FIRST, FIRST + 1]) {
    const board = new Chess()
    const client = new RawClient(`${prefix}${index}`)
    let color = null
    let myPly = 0
    let sentAt = 0

    const step = () => {
      if (client.closed) return
      if ((board.turn() === 'w') === (color === 'w')) {
        const moves = board.moves({ verbose: true })
        if (!moves.length) return
        const move = moves[Math.floor(Math.random() * moves.length)]
        sentAt = now()
        client.send(cgp.T.MOVE, cgp.encodeMove({
          from: move.from, to: move.to, promo: move.promotion ?? '', ply: myPly,
        }))
      }
    }

    /**
     * Vao hang doi, va thu lai neu mai khong duoc ghep.
     *
     * Can thu lai vi dang nhap co the noi thang vao mot van con do tu lan chay
     * truoc (X12): khi do RESIGN ben duoi moi ket thuc duoc van cu, ma RESIGN
     * chay bat dong bo qua hang doi cua ban co, nen QUEUE_JOIN dau tien co the
     * toi som hon va bi tu choi 3008.
     */
    let matched = false
    let announceReady
    playing.push(new Promise(resolve => { announceReady = resolve }))
    const ensureQueued = () => {
      if (client.closed || matched) return
      client.send(cgp.T.QUEUE_JOIN, cgp.json({ timeControl: '600+0' }))
      setTimeout(ensureQueued, 1500)
    }

    const pump = async () => {
      await client.login(`bot_${index}`)
      // Ket thuc van cu de do tren mot van SACH. Khong o trong van nao thi
      // server tra 3003 va ta bo qua.
      client.send(cgp.T.RESIGN)
      ensureQueued()
      for (;;) {
        const frame = await client.next(60_000)
        if (!frame || client.closed) return
        switch (frame.type) {
          case cgp.T.MATCH_FOUND:
            color = cgp.parseJson(frame.payload).color
            matched = true
            announceReady()
            break
          case cgp.T.GAME_SNAPSHOT: {
            const snapshot = cgp.parseJson(frame.payload)
            board.load(snapshot.fen)
            myPly = snapshot.ply
            setTimeout(step, 60)
            break
          }
          case cgp.T.MOVE_APPLIED: {
            const applied = cgp.decodeMoveApplied(frame.payload)
            if (applied.ply > myPly) {
              try {
                board.move({ from: applied.from, to: applied.to, promotion: applied.promo || undefined })
              } catch { /* se dong bo lai o snapshot ke tiep */ }
              myPly = applied.ply
            }
            if (sentAt) {
              onLatency(now() - sentAt)
              sentAt = 0
            }
            setTimeout(step, 60)
            break
          }
          case cgp.T.MOVE_REJECTED:
            // Ban co cuc bo lech voi server: xin lai anh chup. Khong xu ly ca
            // nay thi ban nan nhan se dung han o day va cot so lieu "trong"
            // thanh rong — tuc la ta se ket luan sai rang tan cong lam chet ban
            // co khac, trong khi that ra chi la bot do bi ket.
            sentAt = 0
            client.send(cgp.T.HISTORY_REQ, cgp.json({ gameId: 0 }))
            break

          case cgp.T.ERROR:
            // Van dang PAUSED (4001) hoac gui qua nhanh (4005): cho roi thu lai.
            sentAt = 0
            setTimeout(step, 1000)
            break

          case cgp.T.HEARTBEAT:
            client.send(cgp.T.HEARTBEAT_ACK)
            break
          case cgp.T.GAME_OVER:
            // Ban nan nhan phai con song ca sau dot tan cong de con so "sau"
            // co y nghia, nen danh xong mot van thi vao hang doi van moi.
            board.reset()
            myPly = 0
            sentAt = 0
            matched = false
            ensureQueued()
            break
          default:
            break
        }
      }
    }
    pump().catch(() => { /* ban nan nhan dung lai, khong lam hong phep do */ })
    bots.push(client)
  }
  // Cho ca hai ben vao duoc van truoc khi ben goi bat dau dem: neu khong, cua
  // so "truoc" co the rong va bang so sanh mat y nghia. Co tran tren de mot
  // van khong ghep duoc cung khong treo ca thi nghiem.
  return { bots, ready: Promise.race([Promise.all(playing), sleep(20_000)]) }
}

// ---------------------------------------------------------------- tan cong

const results = []

/**
 * Ghi ket qua mot nhom tan cong.
 *
 * Phan biet ba tinh huong, vi gop chung lai se noi doi:
 *   - **tu choi**: server tra ve dung ma loi. Day la ket qua mong doi.
 *   - **khong tra loi**: het gio cho phan hoi. KHONG phai la "duoc chap nhan" —
 *     trang thai van khong he doi — nhung cung khong phai bang chung tot, nen
 *     dem rieng thay vi tinh vao cot nao.
 *   - **duoc chap nhan**: server tra ve ket qua THANH CONG cho mot request sai.
 *     Day moi la that bai that su, va con so nay phai bang 0.
 */
const record = (attack, sent, rejected, codes, expected, note = '') => {
  const list = Object.entries(codes).map(([code, count]) => `${code}x${count}`).join(' ')
  const silent = codes['khong-tra-loi'] ?? 0
  const accepted = sent - rejected - silent
  results.push({ attack, sent, rejected, silent, accepted, codes: list, expected, note })
  console.log(`  ${attack.padEnd(34)} gui ${String(sent).padStart(4)} | tu choi `
    + `${String(rejected).padStart(4)}`
    + (silent ? ` | khong tra loi ${silent}` : '')
    + (accepted > 0 ? ` | CHAP NHAN ${accepted}` : '')
    + ` | ${list || '-'}${note ? '  <- ' + note : ''}`)
}

const tally = (codes, code) => {
  codes[code ?? 'khong-tra-loi'] = (codes[code ?? 'khong-tra-loi'] ?? 0) + 1
}

/** Hai tai khoan that danh voi nhau, roi ben Trang bat dau pha. */
async function attacksFromRealPlayer(count) {
  const white = new RawClient('ke-gian-lan')
  const black = new RawClient('doi-thu')
  await white.login(`bot_${FIRST + 2}`)
  await black.login(`bot_${FIRST + 3}`)

  // Nhu o ban nan nhan: ket thuc van con do tu lan chay truoc roi moi vao hang
  // doi, va thu lai vai lan vi RESIGN duoc xu ly bat dong bo (X12).
  white.send(cgp.T.RESIGN)
  black.send(cgp.T.RESIGN)
  await sleep(400)

  let matched = null
  for (let attempt = 0; attempt < 4 && !matched; attempt++) {
    white.send(cgp.T.QUEUE_JOIN, cgp.json({ timeControl: '600+0' }))
    await sleep(150)
    black.send(cgp.T.QUEUE_JOIN, cgp.json({ timeControl: '600+0' }))
    matched = await white.waitFor([cgp.T.MATCH_FOUND], 2500)
  }
  if (!matched) {
    console.log('  !! khong ghep duoc cap, bo qua nhom tan cong nay')
    white.close()
    black.close()
    return
  }
  const whiteIsWhite = cgp.parseJson(matched.payload).color === 'w'
  const mover = whiteIsWhite ? white : black
  const waiter = whiteIsWhite ? black : white
  await sleep(300)

  // 1. Nuoc di sai luat: tot di 3 o.
  {
    const codes = {}
    let rejected = 0
    for (let i = 0; i < count; i++) {
      mover.send(cgp.T.MOVE, cgp.encodeMove({ from: 'e2', to: 'e6', ply: 0 }))
      const code = errorCodeOf(await mover.waitFor([cgp.T.MOVE_REJECTED, cgp.T.ERROR], 2500))
      await sleep(PACE_MS)
      tally(codes, code)
      if (code) rejected++
    }
    record('nuoc di sai luat', count, rejected, codes, 3002)
  }

  // 2. Di khi khong phai luot cua minh.
  {
    const codes = {}
    let rejected = 0
    for (let i = 0; i < count; i++) {
      waiter.send(cgp.T.MOVE, cgp.encodeMove({ from: 'e7', to: 'e5', ply: 0 }))
      const code = errorCodeOf(await waiter.waitFor([cgp.T.MOVE_REJECTED, cgp.T.ERROR], 2500))
      await sleep(PACE_MS)
      tally(codes, code)
      if (code) rejected++
    }
    record('di khi khong phai luot', count, rejected, codes, 3001)
  }

  // 3. ply cu / trung: server phai idempotent theo ply (X38).
  {
    const codes = {}
    let rejected = 0
    for (let i = 0; i < count; i++) {
      mover.send(cgp.T.MOVE, cgp.encodeMove({ from: 'e2', to: 'e4', ply: 9999 }))
      const code = errorCodeOf(await mover.waitFor([cgp.T.MOVE_REJECTED, cgp.T.ERROR], 2500))
      await sleep(PACE_MS)
      tally(codes, code)
      if (code) rejected++
    }
    record('ply cu / trung', count, rejected, codes, 3005)
  }

  // 4. Phong cap thieu `promo`: server khong duoc tu chon Hau ho (X27).
  {
    const codes = {}
    let rejected = 0
    for (let i = 0; i < 20; i++) {
      mover.send(cgp.T.MOVE, cgp.encodeMove({ from: 'a7', to: 'a8', ply: 0 }))
      const code = errorCodeOf(await mover.waitFor([cgp.T.MOVE_REJECTED, cgp.T.ERROR], 2500))
      await sleep(PACE_MS)
      tally(codes, code)
      if (code) rejected++
    }
    record('phong cap thieu promo', 20, rejected, codes, '3002/3006',
      'the co dau van chua co tot o a7 nen 3002 cung dung')
  }

  mover.send(cgp.T.RESIGN)
  await sleep(200)
  white.close()
  black.close()
}

/** Gui MOVE cho mot van ma minh khong tham gia. */
async function attackOtherPlayersGame(count) {
  const outsider = new RawClient('nguoi-ngoai')
  await outsider.login(`bot_${FIRST + 4}`)

  const codes = {}
  let rejected = 0
  for (let i = 0; i < count; i++) {
    outsider.send(cgp.T.MOVE, cgp.encodeMove({ from: 'e2', to: 'e4', ply: 0 }))
    const code = errorCodeOf(await outsider.waitFor([cgp.T.MOVE_REJECTED, cgp.T.ERROR], 2500))
    await sleep(PACE_MS)
    tally(codes, code)
    if (code) rejected++
  }
  record('MOVE cho van cua nguoi khac', count, rejected, codes, 3003,
    'MOVE khong mang gameId: server dinh tuyen theo phien, nen khong the nham ban')
  outsider.close()
}

/** Gui message can phien ma chua dang nhap (X07). */
async function attackWithoutLogin(count) {
  const codes = {}
  let rejected = 0
  for (let i = 0; i < count; i++) {
    const client = new RawClient('chua-dang-nhap')
    await client.ready
    client.send(cgp.T.MOVE, cgp.encodeMove({ from: 'e2', to: 'e4', ply: 0 }))
    const code = errorCodeOf(await client.waitFor([cgp.T.ERROR], 2500))
    tally(codes, code)
    if (code) rejected++
    client.close()
  }
  record('MOVE khi chua LOGIN', count, rejected, codes, 2005)
}

/** Frame hong o muc BYTE, truoc khi toi duoc bat ky logic nao (T01). */
async function attackMalformedFrames() {
  const cases = [
    ['LEN = 0', Buffer.from([0, 0, 0, 0])],
    ['LEN = 1 (nho hon header)', Buffer.from([0, 0, 0, 1, 0])],
    ['LEN = 2^31 (u32 rat lon)', Buffer.from([0x80, 0, 0, 0, 0x06, 0, 0, 0, 0])],
    ['LEN = 70000 (vuot 64 KiB)', Buffer.from([0x00, 0x01, 0x11, 0x70, 0x06, 0, 0, 0, 0])],
    ['TYPE = 0x7F khong ton tai', cgp.encodeFrame(0x7f, 1, Buffer.alloc(0))],
    ['MOVE dai 3 byte thay vi 8', cgp.encodeFrame(cgp.T.MOVE, 1, Buffer.from([1, 2, 3]))],
    ['payload JSON hong', cgp.encodeFrame(cgp.T.LOGIN, 1, Buffer.from('{khong-phai-json'))],
  ]

  const codes = {}
  let rejected = 0
  for (const [label, bytes] of cases) {
    const client = new RawClient('frame-hong')
    await client.ready
    // Cac case can phien thi dang nhap truoc, de tach bach "loi frame" voi "chua dang nhap".
    if (label.startsWith('MOVE dai')) {
      await client.login(`bot_${FIRST + 5}`)
    }
    client.sendRaw(bytes)
    const code = errorCodeOf(await client.waitFor([cgp.T.ERROR], 2500))
    tally(codes, code)
    if (code) rejected++
    if (VERBOSE) console.log(`    ${label} -> ${code ?? 'dong ket noi khong bao'}`)
    client.close()
  }
  record('frame hong o muc byte', cases.length, rejected, codes, '2001/2002/2003')
}

/** Gui that nhanh de cham rate limit (X03, T04). */
async function attackFlood(messages) {
  const client = new RawClient('ke-flood')
  await client.login(`bot_${FIRST + 6}`)

  for (let i = 0; i < messages; i++) {
    client.send(cgp.T.HEARTBEAT)
  }
  await sleep(1200)

  // Cach dem o day khac cac nhom tren, va co ly do: bang A6 noi ro server chi
  // tra 4005 vai lan roi DONG ket noi. Neu dem "so message co ERROR tra ve" thi
  // se ra 3/200 va trong nhu server da bo qua 197 message — trong khi thuc te
  // no da chan het. Con so dung la: bao nhieu message duoc PHUC VU.
  const codes = {}
  let served = 0
  for (const frame of client.received) {
    const code = errorCodeOf(frame)
    if (code) {
      tally(codes, code)
    } else if (frame.type === cgp.T.HEARTBEAT_ACK) {
      served++
    }
  }
  // `sent` o dong nay la so message VUOT gioi han, khong phai ca 200: nhung
  // message dau tien nam trong han muc la hop le, tu choi chung moi la sai.
  const overLimit = messages - served
  record(`flood ${messages} msg tuc thi`, overLimit, overLimit, codes, 4005,
    `${served} msg dau duoc phuc vu dung han muc`
    + (client.closed ? ', ket noi bi dong sau 3 lan vi pham — dung bang A6' : ''))
  client.close()
}

// ------------------------------------------------------------------ chay

console.log(`Thi nghiem E6 — server-authoritative validation | ${HOST}:${PORT}\n`)

const victimLatencies = { before: [], during: [], after: [] }
let phase = 'before'
const { bots: victims, ready: victimsReady } = startVictimGame('nan-nhan-', ms => victimLatencies[phase].push(ms))

// Cho ban nan nhan on dinh truoc khi bat dau dem. Dang nhap co the phai ket
// thuc mot van con do tu lan chay truoc roi moi vao hang doi duoc, nen neu dem
// ngay thi cua so "truoc" co the rong va bang so sanh mat y nghia.
console.log('Cho ban nan nhan vao van...')
await victimsReady
await sleep(500)
console.log('Do tre ban nan nhan TRUOC dot tan cong (5 s)...')
await sleep(5000)

phase = 'during'
console.log('\nDang tan cong:')
await attacksFromRealPlayer(Number(argOf('rounds', 50)))
await attackOtherPlayersGame(Number(argOf('rounds', 50)))
await attackWithoutLogin(20)
await attackMalformedFrames()
await attackFlood(Number(argOf('flood', 300)))

phase = 'after'
console.log('\nDo tre ban nan nhan SAU dot tan cong (5 s)...')
await sleep(5000)
// Ket thuc van nan nhan tu te: bo lai mot van PAUSED se lam ban ket qua cua
// lan chay sau (dang nhap lai se noi thang vao van cu).
for (const victim of victims) victim.send(cgp.T.RESIGN)
await sleep(300)
for (const victim of victims) victim.close()

// --------------------------------------------------------------- ket luan

const percentile = (values, fraction) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] * 100) / 100
}

const totalSent = results.reduce((sum, row) => sum + row.sent, 0)
const totalRejected = results.reduce((sum, row) => sum + row.rejected, 0)
const totalSilent = results.reduce((sum, row) => sum + row.silent, 0)
const totalAccepted = results.reduce((sum, row) => sum + Math.max(0, row.accepted), 0)

console.log('\n--- Ket qua ---')
console.log(`Tong request sai      : ${totalSent}`)
console.log(`Bi tu choi            : ${totalRejected} (${(totalRejected / totalSent * 100).toFixed(1)} %)`)
console.log(`Khong tra loi (het gio) : ${totalSilent} — trang thai van KHONG doi, chi la khong kip doc phan hoi`)
console.log(`Duoc CHAP NHAN          : ${totalAccepted} (ky vong 0)`)
if (!victimLatencies.before.length || !victimLatencies.during.length) {
  console.log('\n!! CANH BAO: ban co nan nhan khong chay du ca ba giai doan.')
  console.log('   Thuong la do lan chay truoc vua ket thuc: cac tai khoan bot_390..396 con')
  console.log('   dinh trong van PAUSED cho het 60 s an han (reconnect.graceMs).')
  console.log('   Cot so sanh do tre ben duoi KHONG dung de bao cao - hay doi 60 s hoac')
  console.log('   khoi dong lai server roi chay lai.')
}

console.log('\nDo tre cua ban co KHAC dang chay cung luc (p50 / p95, ms):')
for (const key of ['before', 'during', 'after']) {
  const label = { before: 'truoc  ', during: 'trong  ', after: 'sau    ' }[key]
  console.log(`  ${label}: ${percentile(victimLatencies[key], 0.5)} / `
    + `${percentile(victimLatencies[key], 0.95)}  (${victimLatencies[key].length} nuoc)`)
}

if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  const header = 'attack,sent,rejected,no_reply,accepted,codes,expected_code,note\n'
  const rows = results.map(row =>
    [row.attack, row.sent, row.rejected, row.silent, Math.max(0, row.accepted), row.codes, row.expected,
      `"${row.note.replace(/"/g, "'")}"`].join(',')).join('\n')

  const victimHeader = '\nphase,moves,p50_ms,p95_ms\n'
  const victimRows = ['before', 'during', 'after'].map(key =>
    [key, victimLatencies[key].length, percentile(victimLatencies[key], 0.5),
      percentile(victimLatencies[key], 0.95)].join(',')).join('\n')

  // Cung loi da mac o bot.js: them cot vao dong du lieu ma quen sua tieu de.
  // File van ghi ra binh thuong, chi co cong cu doc phia sau la doc nham cot.
  // Kiem ngay luc ghi de hong o day thay vi hong am tham o buoc phan tich.
  const expected = header.trim().split(',').length
  for (const [index, row] of rows.split('\n').entries()) {
    const columns = row.split(',').length
    if (columns !== expected) {
      console.error(`\n!! ${OUT}: dong ${index + 2} co ${columns} cot,`
        + ` tieu de co ${expected}. Sua lai truoc khi dung so lieu nay.`)
      process.exit(3)
    }
  }

  fs.writeFileSync(OUT, header + rows + '\n' + victimHeader + victimRows + '\n')
  console.log(`\nDa ghi ket qua vao ${OUT}`)
}

process.exit(totalAccepted === 0 ? 0 : 1)
