/**
 * Thi nghiem E8 — khan gia qua TCP thuan so voi qua WebSocket gateway.
 *
 * CODE CUA NHOM.
 *
 * Hai cau hoi cua E8:
 *  1. WebSocket doi lai bao nhieu byte moi message so voi TCP thuan?
 *  2. Di vong qua gateway lam khan gia nhan cham hon bao nhieu?
 *
 * Cach do: mot van dang dien ra, N khan gia noi qua TCP va N khan gia noi qua
 * gateway cung xem. Moc so sanh la NGUOI CHOI: voi moi nuoc di, ta lay thoi
 * diem nguoi choi nhan MOVE_APPLIED lam goc, roi do xem tung khan gia nhan
 * duoc sau bao lau. Cach nay khong can dong ho chung vi tat ca deu do trong
 * cung mot tien trinh.
 *
 * Byte thi dem tren socket VA dem rieng phan CGP, roi lay hieu:
 *
 *     overhead moi message = (byte doc tren socket - byte cua frame CGP) / so message
 *
 * Phai lam vay chu khong lay "byte trung binh moi message" cua hai ben rui tru
 * nhau: hai ben co the nhan so luong va loai message khac nhau (khan gia vao
 * muon hon thi bo lo vai MOVE_APPLIED), ma GAME_SNAPSHOT lon hon MOVE_APPLIED
 * hang chuc lan — hieu so khi do phan anh khac biet ve MIX message chu khong
 * phai ve cach dong khung. Nhom da mac dung loi nay o lan do dau.
 *
 * Chay:  node spectate.js --spectators 50 --out ../../statics/results/e8/e8.csv
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { Chess } from 'chess.js'
import * as cgp from '../common-js/cgp.js'
import { WsClient } from '../web-spectator/ws-client.js'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const HOST = argOf('host', process.env.SERVER_HOST ?? '127.0.0.1')
const PORT = Number(argOf('port', process.env.SERVER_PORT ?? 5555))
const WS_PORT = Number(argOf('ws', process.env.WS_PORT ?? 8080))
const SPECTATORS = Number(argOf('spectators', 50))
const MOVES = Number(argOf('moves', 40))
const PASSWORD = 'chess123'
/**
 * Tai khoan bat dau. `schema.sql` tao san `bot_1..bot_400`, ma thi nghiem nay
 * can 2 nguoi choi + 2 x SPECTATORS tai khoan. Voi 50 khan gia moi ben thi can
 * 102 tai khoan lien tiep, nen moc bat dau phai de du cho ca day nam trong 400.
 */
const FIRST = Number(argOf('first', 150))
const OUT = argOf('out', null)

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ------------------------------------------------------------ nguoi choi

/** Hai bot danh mot van that de co MOVE_APPLIED cho khan gia xem. */
function startPlayer(index, onApplied) {
  const board = new Chess()
  const socket = net.createConnection({ host: HOST, port: PORT })
  socket.setNoDelay(true)
  const accumulator = new cgp.FrameAccumulator()
  let seq = 1
  let color = null
  let myPly = 0
  let gameId = 0
  let stopped = false

  const send = (type, payload = Buffer.alloc(0)) => {
    if (!stopped) socket.write(cgp.encodeFrame(type, seq++, payload))
  }
  const step = () => {
    if (stopped || (board.turn() === 'w') !== (color === 'w')) return
    const moves = board.moves({ verbose: true })
    if (!moves.length || myPly >= MOVES) return
    const move = moves[Math.floor(Math.random() * moves.length)]
    send(cgp.T.MOVE, cgp.encodeMove({
      from: move.from, to: move.to, promo: move.promotion ?? '', ply: myPly,
    }))
  }

  socket.on('connect', () =>
    send(cgp.T.LOGIN, cgp.json({ username: `bot_${index}`, password: PASSWORD })))
  socket.on('data', chunk => {
    for (const frame of accumulator.push(chunk)) {
      switch (frame.type) {
        case cgp.T.LOGIN_OK:
          send(cgp.T.RESIGN)                       // don van con do tu lan truoc
          setTimeout(() => send(cgp.T.QUEUE_JOIN, cgp.json({ timeControl: '600+0' })), 300)
          break
        case cgp.T.MATCH_FOUND: {
          const match = cgp.parseJson(frame.payload)
          color = match.color
          gameId = match.gameId
          onApplied.gameId = gameId
          break
        }
        case cgp.T.GAME_SNAPSHOT: {
          const snapshot = cgp.parseJson(frame.payload)
          board.load(snapshot.fen)
          myPly = snapshot.ply
          setTimeout(step, 120)
          break
        }
        case cgp.T.MOVE_APPLIED: {
          const applied = cgp.decodeMoveApplied(frame.payload)
          if (applied.ply > myPly) {
            try {
              board.move({ from: applied.from, to: applied.to, promotion: applied.promo || undefined })
            } catch { /* se dong bo o snapshot ke tiep */ }
            myPly = applied.ply
          }
          onApplied.mark(applied.ply)
          setTimeout(step, 120)
          break
        }
        case cgp.T.MOVE_REJECTED:
          send(cgp.T.HISTORY_REQ, cgp.json({ gameId }))
          break
        case cgp.T.HEARTBEAT:
          send(cgp.T.HEARTBEAT_ACK)
          break
        default:
          break
      }
    }
  })
  socket.on('error', () => { stopped = true })

  return { close: () => { stopped = true; socket.destroy() } }
}

// -------------------------------------------------------------- khan gia

/**
 * Mot khan gia.
 *
 * `transport` chi doi duong truyen, KHONG doi noi dung: ca hai deu gui va nhan
 * dung frame CGP nhu nhau. Do la diem chinh cua thiet ke gateway va cung la
 * dieu lam cho phep so sanh o E8 cong bang.
 */
async function startSpectator(transport, index, gameIdRef, samples) {
  const accumulator = new cgp.FrameAccumulator()
  let seq = 1
  let ready = false

  const onFrame = frame => {
    switch (frame.type) {
      case cgp.T.LOGIN_OK:
        ready = true
        break
      case cgp.T.MOVE_APPLIED: {
        const applied = cgp.decodeMoveApplied(frame.payload)
        const sentAt = gameIdRef.timeOf(applied.ply)
        if (sentAt) samples.push(now() - sentAt)
        break
      }
      case cgp.T.HEARTBEAT:
        write(cgp.encodeFrame(cgp.T.HEARTBEAT_ACK, seq++))
        break
      default:
        break
    }
  }

  let write
  let close
  let bytes = () => 0
  let messages = () => 0
  // Tong kich thuoc cac frame CGP da nhan (9 byte header + payload).
  //
  // Can con so nay de tinh overhead CHINH XAC: overhead = byte doc duoc tren
  // socket - byte CGP. So sanh "byte trung binh moi message" giua hai duong
  // truyen thi KHONG dung, vi hai ben co the nhan so luong va loai message khac
  // nhau (khan gia vao muon hon thi bo lo vai MOVE_APPLIED), ma GAME_SNAPSHOT
  // lon hon MOVE_APPLIED hang chuc lan.
  let cgpBytes = 0

  if (transport === 'tcp') {
    const socket = net.createConnection({ host: HOST, port: PORT })
    socket.setNoDelay(true)
    let read = 0
    let frames = 0
    socket.on('data', chunk => {
      read += chunk.length
      for (const frame of accumulator.push(chunk)) {
        frames += 1
        cgpBytes += 9 + frame.payload.length
        onFrame(frame)
      }
    })
    socket.on('error', () => { /* khan gia roi ra khong lam hong phep do */ })
    await new Promise(resolve => socket.once('connect', resolve))
    write = data => socket.write(data)
    close = () => socket.destroy()
    bytes = () => read
    messages = () => frames
  } else {
    const client = await WsClient.connect(WS_PORT)
    client.on("message", payload => {
      cgpBytes += payload.length
      onFrame(cgp.decodeFrame(payload))
    })
    client.on('error', () => { /* nt */ })
    write = data => client.send(data)
    close = () => client.close()
    bytes = () => client.bytesRead
    messages = () => client.messages
  }

  write(cgp.encodeFrame(cgp.T.LOGIN, seq++,
    cgp.json({ username: `bot_${index}`, password: PASSWORD })))

  return {
    join: gameId => write(cgp.encodeFrame(cgp.T.SPECTATE_JOIN, seq++, cgp.json({ gameId }))),
    ready: () => ready,
    close,
    cgpBytes: () => cgpBytes,
    bytes,
    messages,
  }
}

// ------------------------------------------------------------------ chay

console.log(`Thi nghiem E8 — ${SPECTATORS} khan gia TCP + ${SPECTATORS} khan gia WebSocket`)
console.log(`  game server ${HOST}:${PORT}, gateway ws://${HOST}:${WS_PORT}`)

const LAST_ACCOUNT = FIRST + 1 + 2 * SPECTATORS
if (LAST_ACCOUNT > 400) {
  console.error(`Can tai khoan toi bot_${LAST_ACCOUNT} nhung schema chi tao toi bot_400.`)
  console.error('Giam --spectators hoac giam --first.')
  process.exit(2)
}

const tcpSamples = []
const wsSamples = []

// Moc thoi gian nguoi choi nhan duoc tung nuoc — goc de do do tre toi khan gia.
const playerClock = {
  gameId: 0,
  times: new Map(),
  mark(ply) { this.times.set(ply, now()) },
  timeOf(ply) { return this.times.get(ply) },
}

const players = [startPlayer(FIRST, playerClock), startPlayer(FIRST + 1, playerClock)]

// Cho ghep cap xong roi moi cho khan gia vao, neu khong ho khong co gi de xem.
for (let waited = 0; waited < 40 && !playerClock.gameId; waited++) await sleep(250)
if (!playerClock.gameId) {
  console.error('Khong ghep duoc van de xem — server co dang chay khong?')
  for (const player of players) player.close()
  process.exit(1)
}
console.log(`  van #${playerClock.gameId} dang chay`)

const spectators = []
for (let i = 0; i < SPECTATORS; i++) {
  spectators.push(await startSpectator('tcp', FIRST + 2 + i, playerClock, tcpSamples))
}
for (let i = 0; i < SPECTATORS; i++) {
  spectators.push(await startSpectator('ws', FIRST + 2 + SPECTATORS + i, playerClock, wsSamples))
}
await sleep(1200)
for (const spectator of spectators) spectator.join(playerClock.gameId)
console.log(`  ${spectators.length} khan gia da vao, dang do...`)

await sleep(Number(argOf('duration', 20)) * 1000)

const tcpWatchers = spectators.slice(0, SPECTATORS)
const wsWatchers = spectators.slice(SPECTATORS)
const totals = group => ({
  bytes: group.reduce((sum, one) => sum + one.bytes(), 0),
  cgpBytes: group.reduce((sum, one) => sum + one.cgpBytes(), 0),
  messages: group.reduce((sum, one) => sum + one.messages(), 0),
})
const tcpTotals = totals(tcpWatchers)
const wsTotals = totals(wsWatchers)

for (const spectator of spectators) spectator.close()
for (const player of players) player.close()

const percentile = (values, fraction) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] * 100) / 100
}

/**
 * Overhead THAT SU cua mot duong truyen: byte doc duoc tren socket, tru di byte
 * cua chinh frame CGP, chia cho so message.
 *
 * Khong lay "byte trung binh moi message" cua hai ben rui tru nhau: hai ben co
 * the nhan so luong va loai message khac nhau, ma GAME_SNAPSHOT lon hon
 * MOVE_APPLIED hang chuc lan - hieu so khi do phan anh khac biet ve MIX chu
 * khong phai ve dong khung.
 */
const overheadPerMessage = group => group.messages
  ? +((group.bytes - group.cgpBytes) / group.messages).toFixed(2) : 0
const perMessage = group => group.messages
  ? +(group.bytes / group.messages).toFixed(2) : 0

console.log('\n--- Ket qua ---')
const report = (label, group, samples) => {
  console.log(`${label.padEnd(12)} : ${group.messages} message, ${group.bytes} byte tren socket`
    + ` (${group.cgpBytes} byte la CGP)`)
  console.log(`${''.padEnd(12)}   overhead dong khung: ${overheadPerMessage(group)} byte/message`
    + `  |  trung binh ca goi: ${perMessage(group)} byte/message`)
  console.log(`${''.padEnd(12)}   do tre toi khan gia p50/p95: `
    + `${percentile(samples, 0.5)} / ${percentile(samples, 0.95)} ms (${samples.length} mau)`)
}
report('TCP thuan', tcpTotals, tcpSamples)
report('WebSocket', wsTotals, wsSamples)

const overhead = +(overheadPerMessage(wsTotals) - overheadPerMessage(tcpTotals)).toFixed(2)
console.log(`\nWebSocket ton them ${overhead} byte/message so voi TCP thuan`)
console.log('  (RFC 6455: 2 byte header cho payload < 126 byte, 4 byte tu 126 den 64 KiB;')
console.log('   server khong mask nen khong ton them 4 byte khoa nhu chieu nguoc lai.')
console.log('   TCP thuan co overhead 0 o tang nay vi CGP tu dong khung - phan header')
console.log('   cua TCP/IP nam duoi tang nay nen khong quan sat duoc tu day.)')

if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  const header = 'transport,spectators,messages,socket_bytes,cgp_bytes,bytes_per_msg,'
    + 'overhead_bytes_per_msg,p50_ms,p95_ms,samples\n'
  const rows = [
    ['tcp', SPECTATORS, tcpTotals.messages, tcpTotals.bytes, tcpTotals.cgpBytes,
      perMessage(tcpTotals), overheadPerMessage(tcpTotals),
      percentile(tcpSamples, 0.5), percentile(tcpSamples, 0.95), tcpSamples.length].join(','),
    ['websocket', SPECTATORS, wsTotals.messages, wsTotals.bytes, wsTotals.cgpBytes,
      perMessage(wsTotals), overheadPerMessage(wsTotals),
      percentile(wsSamples, 0.5), percentile(wsSamples, 0.95), wsSamples.length].join(','),
  ]
  fs.writeFileSync(OUT, header + rows.join('\n') + '\n')
  console.log(`\nDa ghi ${OUT}`)
}

process.exit(0)
