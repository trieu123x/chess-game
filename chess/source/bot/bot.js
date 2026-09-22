/**
 * Bot sinh tai cho Game Server.
 *
 * CODE CUA NHOM. Moi bot la mot ket noi TCP that, noi CGP bang dung bo codec
 * ma server dung (`common-js/cgp.js`) — nen day vua la cong cu do, vua la mot
 * bang chung nua cho tinh doc lap ngon ngu cua protocol (N6).
 *
 * Bot KHONG tu quyet dinh gi ve luat: no chi chon mot nuoc hop le theo ban co
 * cuc bo roi gui di, con server moi la ben phan xu. Neu server tu choi, bot
 * dong bo lai theo `expectedPly` thay vi cai lai.
 *
 * Chay:
 *   node bot.js --bots 10                    # chi dang nhap (kiem tra ket noi)
 *   node bot.js --games 5 --play             # 5 ban, danh het van
 *   node bot.js --games 50 --play --out ../../statics/results/e1.csv
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
const PLAY = argv.includes('--play')
const GAMES = Number(argOf('games', process.env.GAMES ?? 1))
const BOTS = PLAY ? GAMES * 2 : Number(argOf('bots', 10))
const PASSWORD = argOf('pass', 'chess123')
const PREFIX = argOf('prefix', 'bot_')
const TIME_CONTROL = argOf('tc', '60+0')
const MAX_PLIES = Number(argOf('maxPlies', 120))
const THINK_MS = Number(argOf('think', 50))
const OUT = argOf('out', null)
const VERBOSE = argv.includes('--verbose')

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000   // ms, dong ho don dieu

function runBot(index) {
  const username = `${PREFIX}${index}`
  return new Promise(resolve => {
    const sample = {
      username, loginMs: null, matched: false, color: null, plies: 0,
      result: null, reason: null, moveLatencies: [], bytesIn: 0, bytesOut: 0,
      rejects: 0, error: null,
    }
    const board = new Chess()
    const accumulator = new cgp.FrameAccumulator()
    let seq = 1
    let loginSentAt = 0
    let moveSentAt = 0
    let myPly = 0
    let finished = false

    const socket = net.createConnection({ host: HOST, port: PORT })
    socket.setNoDelay(true)

    const finish = error => {
      if (finished) return
      finished = true
      if (error && !sample.error) sample.error = String(error.message ?? error)
      socket.destroy()
      resolve(sample)
    }

    const send = (type, payload) => {
      const frame = cgp.encodeFrame(type, seq++, payload)
      sample.bytesOut += frame.length
      socket.write(frame)
    }

    /** Chon mot nuoc hop le va gui di. Ban co cuc bo chi de chon nuoc, khong de phan xu. */
    const playMove = () => {
      if (finished || board.isGameOver()) return
      if (sample.plies >= MAX_PLIES) {
        // Ván ngẫu nhiên có thể kéo dài vô tận. Đầu hàng để ván kết thúc dứt
        // khoát thay vì ngồi chờ đồng hồ cạn — số liệu đo mới dùng được.
        send(cgp.T.RESIGN, Buffer.alloc(0))
        return
      }
      const moves = board.moves({ verbose: true })
      if (!moves.length) return
      const move = moves[Math.floor(Math.random() * moves.length)]
      moveSentAt = now()
      send(cgp.T.MOVE, cgp.encodeMove({
        from: move.from, to: move.to, promo: move.promotion ?? '', ply: myPly,
      }))
    }

    const maybeMove = () => {
      const myTurn = (board.turn() === 'w') === (sample.color === 'w')
      if (myTurn) setTimeout(playMove, THINK_MS)
    }

    socket.on('connect', () => {
      loginSentAt = now()
      send(cgp.T.LOGIN, cgp.json({ username, password: PASSWORD }))
    })

    socket.on('data', chunk => {
      sample.bytesIn += chunk.length
      let frames
      try {
        frames = accumulator.push(chunk)
      } catch (failure) {
        return finish(failure)
      }

      for (const frame of frames) {
        switch (frame.type) {
          case cgp.T.LOGIN_OK:
            sample.loginMs = Math.round((now() - loginSentAt) * 100) / 100
            if (!PLAY) return finish()
            send(cgp.T.QUEUE_JOIN, cgp.json({ timeControl: TIME_CONTROL }))
            break

          case cgp.T.MATCH_FOUND: {
            const match = cgp.parseJson(frame.payload)
            sample.matched = true
            sample.color = match.color
            if (VERBOSE) console.log(`  ${username}: ghep voi ${match.opponent}, cam ${match.color}`)
            break
          }

          case cgp.T.GAME_SNAPSHOT: {
            const snapshot = cgp.parseJson(frame.payload)
            board.load(snapshot.fen)
            myPly = snapshot.ply
            maybeMove()
            break
          }

          case cgp.T.MOVE_APPLIED: {
            const applied = cgp.decodeMoveApplied(frame.payload)
            if (applied.ply > myPly) {
              try {
                board.move({ from: applied.from, to: applied.to, promotion: applied.promo || undefined })
              } catch {
                // Ban co cuc bo lech voi server: xin lai anh chup thay vi doan.
                send(cgp.T.HISTORY_REQ, cgp.json({ gameId: 0 }))
                break
              }
              myPly = applied.ply
              sample.plies = applied.ply
            }
            if (moveSentAt) {
              sample.moveLatencies.push(Math.round((now() - moveSentAt) * 100) / 100)
              moveSentAt = 0
            }
            maybeMove()
            break
          }

          case cgp.T.MOVE_REJECTED: {
            const rejected = cgp.parseJson(frame.payload)
            sample.rejects += 1
            if (VERBOSE) console.log(`  ${username}: MOVE_REJECTED ${rejected.code} ${rejected.reason}`)
            myPly = rejected.expectedPly
            send(cgp.T.HISTORY_REQ, cgp.json({ gameId: 0 }))   // dong bo lai tu server
            break
          }

          case cgp.T.GAME_OVER: {
            const over = cgp.parseJson(frame.payload)
            sample.result = over.result
            sample.reason = over.reason
            sample.plies = board.history().length
            if (VERBOSE) console.log(`  ${username}: ket thuc ${over.result} (${over.reason})`)
            return finish()
          }

          case cgp.T.HEARTBEAT:
            // Server tu do RTT bang chu trinh nay, nen phai tra loi (X33).
            socket.write(cgp.encodeFrame(cgp.T.HEARTBEAT_ACK, frame.seq))
            break

          case cgp.T.HEARTBEAT_ACK:
          case cgp.T.CLOCK_PONG:
          case cgp.T.DRAW_OFFERED:
          case cgp.T.PEER_STATUS:
            break

          case cgp.T.ERROR: {
            const failure = cgp.parseJson(frame.payload)
            sample.error = `${failure.code} ${failure.message}`
            return finish()
          }

          default:
            if (VERBOSE) console.log(`  ${username}: ${cgp.typeName(frame.type)}`)
        }
      }
    })

    socket.on('error', finish)
    socket.on('close', () => finish())
  })
}

const percentile = (values, fraction) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

const startedAt = now()
console.log(PLAY
  ? `Sinh tai: ${GAMES} ban (${BOTS} bot) -> ${HOST}:${PORT}, the thuc ${TIME_CONTROL}`
  : `Sinh tai: ${BOTS} bot dang nhap -> ${HOST}:${PORT}`)

const samples = await Promise.all(Array.from({ length: BOTS }, (_, index) => runBot(index + 1)))
const elapsed = now() - startedAt

const loggedIn = samples.filter(s => s.loginMs !== null)
const failed = samples.filter(s => s.error)
const finishedGames = samples.filter(s => s.result)
const latencies = samples.flatMap(s => s.moveLatencies)

console.log(`\nDang nhap            : ${loggedIn.length}/${BOTS}`)
if (PLAY) {
  console.log(`Ghep cap             : ${samples.filter(s => s.matched).length}/${BOTS}`)
  console.log(`Van ket thuc         : ${finishedGames.length / 2} / ${GAMES}`)
  const results = {}
  for (const sample of finishedGames) {
    const key = `${sample.result} (${sample.reason})`
    results[key] = (results[key] ?? 0) + 1
  }
  for (const [key, count] of Object.entries(results)) console.log(`  ${key}: ${count / 2} van`)
  console.log(`Tong nuoc di         : ${latencies.length}`)
  console.log(`Nuoc bi tu choi      : ${samples.reduce((sum, s) => sum + s.rejects, 0)}`)
}
if (latencies.length) {
  console.log(`Move RTT p50/p95/p99 : ${percentile(latencies, 0.5)} / ${percentile(latencies, 0.95)} / ${percentile(latencies, 0.99)} ms`)
}
if (loggedIn.length) {
  const logins = loggedIn.map(s => s.loginMs)
  console.log(`LOGIN p50 / p95      : ${percentile(logins, 0.5)} / ${percentile(logins, 0.95)} ms`)
}
console.log(`That bai             : ${failed.length}`)
console.log(`Tong thoi gian       : ${Math.round(elapsed)} ms`)
console.log(`Byte gui / nhan      : ${samples.reduce((s, x) => s + x.bytesOut, 0)} / ${samples.reduce((s, x) => s + x.bytesIn, 0)}`)

for (const sample of failed.slice(0, 5)) console.log(`  loi ${sample.username}: ${sample.error}`)

if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  const header = 'username,color,login_ms,plies,result,reason,move_p50_ms,rejects,bytes_in,bytes_out,error\n'
  const rows = samples.map(s => [
    s.username, s.color ?? '', s.loginMs ?? '', s.plies, s.result ?? '', s.reason ?? '',
    percentile(s.moveLatencies, 0.5) ?? '', s.rejects, s.bytesIn, s.bytesOut, s.error ?? '',
  ].join(',')).join('\n')
  fs.writeFileSync(OUT, header + rows + '\n')
  console.log(`\nDa ghi ${samples.length} dong vao ${OUT}`)
}

process.exit(failed.length ? 1 : 0)
