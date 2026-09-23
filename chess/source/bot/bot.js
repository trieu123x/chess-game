/**
 * Bot sinh tai cho Game Server — cong cu do chinh cua E1, E2, E3, E4, E5.
 *
 * CODE CUA NHOM. Moi bot la mot ket noi TCP that, noi CGP bang dung bo codec
 * ma server dung (`common-js/cgp.js`) — nen day vua la cong cu do, vua la mot
 * bang chung nua cho tinh doc lap ngon ngu cua protocol (N6).
 *
 * Bot KHONG tu quyet dinh gi ve luat: no chi chon mot nuoc hop le theo ban co
 * cuc bo roi gui di, con server moi la ben phan xu. Neu server tu choi, bot
 * dong bo lai theo `expectedPly` thay vi cai lai.
 *
 * ## Do thoi gian
 *
 * Moc thoi gian lay tu `process.hrtime.bigint()` — dong ho DON DIEU. Dung
 * `Date.now()` thi mot lan NTP keo gio giua phep do se cho ra latency am hoac
 * am hang giay, va khong the biet la da xay ra (X34/X35).
 *
 * `--out` ghi CSV MOI NUOC MOT DONG chu khong phai mot dong tong ket moi bot:
 * p95 va p99 khong tinh lai duoc tu trung binh, nen so lieu tho phai con nguyen.
 *
 * ## Chay
 *   node bot.js --bots 10                              # chi dang nhap
 *   node bot.js --play --games 5                       # 5 ban, danh het van
 *   node bot.js --play --games 50 --out ../../statics/results/e1/50.csv
 *   node bot.js --play --games 20 --format json        # baseline cua E3
 *   node bot.js --play --games 20 --drop-at 10 --resume-after 20   # kich ban E5
 *   node bot.js --play --games 10 --warmup 60          # bo 60 s dau khoi so lieu
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
const FIRST = Number(argOf('first', 1))
const TIME_CONTROL = argOf('tc', '60+0')
const MAX_PLIES = Number(argOf('maxPlies', 120))   // X63: chan van ngau nhien keo dai vo tan
const THINK_MS = Number(argOf('think', 50))
const FORMAT = argOf('format', 'binary')           // binary | json  -> E3
const OUT = argOf('out', null)
const WARMUP_SEC = Number(argOf('warmup', 0))
const RAMP_MS = Number(argOf('ramp', 0))           // trai deu luc bat dau, chong bao ket noi
const DROP_AT = Number(argOf('drop-at', 0))        // E5: cat ket noi o nuoc thu N
const RESUME_AFTER = Number(argOf('resume-after', 0))  // E5: cho bao nhieu giay roi noi lai
/**
 * Ben nao bi cat (E5): 'w' | 'b' | 'both'.
 *
 * Mac dinh CHI cat mot ben, va do khong phai chi de cho gon. Neu cat ca hai thi
 * van chuyen PAUSED ngay va khong ai di duoc nuoc nao trong luc do — phat lai
 * se luon bang 0 nuoc va cau hoi cua E5 ("co mat nuoc di nao khong?") khong bao
 * gio duoc hoi den. Cat mot ben thi doi thu van di tiep trong cua so heartbeat,
 * va dung nhung nuoc do phai duoc phat lai khi noi lai.
 */
const DROP_SIDE = argOf('drop-side', 'w')
/**
 * Danh xong ván thi vao ván moi, thay vi thoat.
 *
 * Can cho cac bai chay dai (M3, T19): neu bot thoat khi ván ket thuc thi tai
 * se tu can dan — do duoc o lan chay dau, 50 bàn tut xuong con 3 sau 10 phut,
 * va khi do khong con tra loi duoc cau hoi "50 bàn chay on dinh 10 phut".
 * Dung kem `--duration` de biet khi nao thi dung han.
 */
const LOOP = argv.includes('--loop')
const DURATION_SEC = Number(argOf('duration', 0))
const LABEL = argOf('label', '')
const VERBOSE = argv.includes('--verbose')

if (!['binary', 'json'].includes(FORMAT)) {
  console.error(`--format phai la binary | json, nhan: ${FORMAT}`)
  process.exit(2)
}

/**
 * "180+2" -> {180000, 2000}.
 *
 * Can biet cong thuc dong ho de tinh duoc server DA TRU bao nhieu gio cho moi
 * nuoc: charged = dong_ho_truoc - dong_ho_sau + increment. Do chinh la nua kia
 * cua phep do o E4.
 */
const [BASE_MS, INC_MS] = (() => {
  const [base, increment] = TIME_CONTROL.split('+').map(Number)
  return [base * 1000, (increment || 0) * 1000]
})()

/** Dong ho don dieu, ms co phan le. */
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000
const round2 = value => Math.round(value * 100) / 100
const startedAt = now()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ------------------------------------------------------------ dinh dang

/**
 * Ma hoa duong "hot path" — phai khop voi `server.format` cua server.
 *
 * Doi cho nay chinh la noi dung E3: cung mot van, cung mot chuoi nuoc di, chi
 * khac cach dong goi. Ban json gui kem FEN day du de lam baseline "khong delta".
 */
const wire = FORMAT === 'json'
  ? {
    encodeMove: move => cgp.json(move),
    decodeMoveApplied: payload => {
      const applied = cgp.parseJson(payload)
      return { ...applied, clockW: applied.clockW, clockB: applied.clockB }
    },
  }
  : {
    encodeMove: move => cgp.encodeMove(move),
    decodeMoveApplied: payload => {
      const applied = cgp.decodeMoveApplied(payload)
      return { ...applied, clockW: applied.clockWhiteMs, clockB: applied.clockBlackMs }
    },
  }

// ---------------------------------------------------------------- mot bot

function runBot(index) {
  const username = `${PREFIX}${index}`

  return new Promise(resolve => {
    const sample = {
      username, loginMs: null, matched: false, color: null, gameId: 0, plies: 0,
      result: null, reason: null, moves: [], bytesIn: 0, bytesOut: 0,
      rejects: 0, resumes: 0, waits: 0, movesLost: 0, gamesPlayed: 0, error: null,
    }
    const board = new Chess()
    /** Cac ply client THUC SU da nhin thay — nguon kiem chung "0 nuoc bi mat" cua E5. */
    const seen = new Set()
    let socket = null
    let accumulator = new cgp.FrameAccumulator()
    let seq = 1
    let loginSentAt = 0
    let moveSentAt = 0
    let turnReadyAt = 0
    let thinkMs = 0
    let myClockMs = BASE_MS
    let myPly = 0
    let finished = false
    let sessionToken = null
    let reconnecting = false

    const finish = error => {
      if (finished) return
      finished = true
      if (error && !sample.error) sample.error = String(error.message ?? error)
      socket?.destroy()
      resolve(sample)
    }

    const send = (type, payload) => {
      if (!socket || socket.destroyed) return
      const frame = cgp.encodeFrame(type, seq++, payload)
      sample.bytesOut += frame.length
      socket.write(frame)
    }

    /** Chon mot nuoc hop le va gui di. Ban co cuc bo chi de chon nuoc, khong de phan xu. */
    const playMove = () => {
      if (finished || reconnecting || board.isGameOver()) return
      if (sample.plies >= MAX_PLIES) {
        // Van ngau nhien co the keo dai vo tan. Dau hang de van ket thuc dut
        // khoat thay vi ngoi cho dong ho can — so lieu do moi dung duoc (X63).
        send(cgp.T.RESIGN, Buffer.alloc(0))
        return
      }
      const moves = board.moves({ verbose: true })
      if (!moves.length) return
      const move = moves[Math.floor(Math.random() * moves.length)]
      moveSentAt = now()
      thinkMs = turnReadyAt ? moveSentAt - turnReadyAt : 0
      send(cgp.T.MOVE, wire.encodeMove({
        from: move.from, to: move.to, promo: move.promotion ?? '', ply: myPly,
      }))
    }

    const maybeMove = () => {
      const myTurn = (board.turn() === 'w') === (sample.color === 'w')
      if (!myTurn) {
        return
      }
      // Moc bat dau "suy nghi": tu day den luc gui nuoc di la thoi gian ta THUC
      // SU dung. So sanh no voi thoi gian server TRU chinh la phep do cua E4.
      turnReadyAt = now()
      setTimeout(playMove, THINK_MS)
    }

    /**
     * Kich ban E5: cat phang ket noi giua ván roi noi lai bang RESUME.
     *
     * Cat bang `destroy()` chu khong phai `end()`: mot ket noi dong tu te se
     * gui FIN va server biet ngay. Rut day mang thi khong — do moi la truong
     * hop can do (X01), va cung la cai ma heartbeat phai bat duoc.
     */
    const dropAndResume = async () => {
      if (reconnecting || !sessionToken) return
      reconnecting = true
      const droppedAt = now()
      socket.destroy()

      await sleep(RESUME_AFTER * 1000)
      if (finished) return

      accumulator = new cgp.FrameAccumulator()
      attach(net.createConnection({ host: HOST, port: PORT }), () => {
        sample.resumeStartedAt = droppedAt
        send(cgp.T.RESUME, cgp.json({ sessionToken, lastPly: myPly }))
      })
    }

    const onFrame = frame => {
      switch (frame.type) {
        case cgp.T.LOGIN_OK: {
          const session = cgp.parseJson(frame.payload)
          sessionToken = session.sessionToken
          if (reconnecting) {
            // Thoi gian hoi phuc: tu luc cat den luc phien song lai (do o E5).
            sample.recoveryMs = Math.round((now() - sample.resumeStartedAt) * 100) / 100
              - RESUME_AFTER * 1000
            sample.resumes += 1
            reconnecting = false
            break
          }
          sample.loginMs = Math.round((now() - loginSentAt) * 100) / 100
          if (!PLAY) return finish()
          send(cgp.T.QUEUE_JOIN, cgp.json({ timeControl: TIME_CONTROL }))
          break
        }

        case cgp.T.MATCH_FOUND: {
          const match = cgp.parseJson(frame.payload)
          sample.matched = true
          sample.color = match.color
          sample.gameId = match.gameId
          if (VERBOSE) console.log(`  ${username}: ghep voi ${match.opponent}, cam ${match.color}`)
          break
        }

        case cgp.T.GAME_SNAPSHOT: {
          const snapshot = cgp.parseJson(frame.payload)
          board.load(snapshot.fen)
          myPly = snapshot.ply
          // Snapshot mang toan bo lich su, nen coi nhu da thay tat ca cac ply toi day.
          for (let index = 1; index <= snapshot.ply; index++) seen.add(index)
          sample.plies = snapshot.ply
          maybeMove()
          break
        }

        case cgp.T.MOVE_APPLIED: {
          const applied = wire.decodeMoveApplied(frame.payload)
          if (applied.ply > myPly) {
            try {
              board.move({ from: applied.from, to: applied.to, promotion: applied.promo || undefined })
            } catch {
              // Ban co cuc bo lech voi server: xin lai anh chup thay vi doan.
              send(cgp.T.HISTORY_REQ, cgp.json({ gameId: sample.gameId }))
              break
            }
            myPly = applied.ply
            seen.add(applied.ply)
            sample.plies = applied.ply
          }
          if (moveSentAt) {
            // Server da tru bao nhieu gio cho nuoc vua roi? Doc thang tu dong ho
            // ma chinh server gui ve, khong tu suy ra.
            const myClockNow = sample.color === 'w' ? applied.clockW : applied.clockB
            const chargedMs = myClockMs - myClockNow + INC_MS
            myClockMs = myClockNow

            sample.moves.push({
              ply: applied.ply,
              rttMs: round2(now() - moveSentAt),
              bytes: frame.payload.length + 9,
              // E4: thoi gian ta THUC SU suy nghi, so voi thoi gian server TRU.
              // Hieu so la thiet hai do do tre mang gay ra; bu RTT phai keo no
              // ve gan 0. Do tre khu hoi (rttMs) KHONG phai la con so nay - no
              // gan nhu khong doi du co bu hay khong.
              thinkMs: round2(thinkMs),
              chargedMs: round2(chargedMs),
              driftMs: round2(chargedMs - thinkMs),
              warmup: now() - startedAt < WARMUP_SEC * 1000,
            })
            moveSentAt = 0
          }
          // Cat khi dang la luot DOI THU: co the doi thu moi di duoc nuoc nao do
          // trong luc ta khong co mat, va do chinh la nhung nuoc phai duoc phat
          // lai khi noi lai. Cat dung luot cua minh thi khong ai di ca va E5
          // khong do duoc gi.
          const myTurn = (applied.ply % 2 === 0) === (sample.color === 'w')
          const dropsHere = (DROP_SIDE === 'both' || sample.color === DROP_SIDE)
            && (DROP_SIDE === 'both' || !myTurn)
          if (DROP_AT > 0 && dropsHere && applied.ply >= DROP_AT && sample.resumes === 0) {
            dropAndResume()
            break
          }
          maybeMove()
          break
        }

        case cgp.T.MOVE_REJECTED: {
          const rejected = cgp.parseJson(frame.payload)
          sample.rejects += 1
          if (VERBOSE) console.log(`  ${username}: MOVE_REJECTED ${rejected.code} ${rejected.reason}`)
          myPly = rejected.expectedPly
          moveSentAt = 0
          send(cgp.T.HISTORY_REQ, cgp.json({ gameId: sample.gameId }))   // dong bo lai tu server
          break
        }

        case cgp.T.GAME_OVER: {
          const over = cgp.parseJson(frame.payload)
          sample.result = over.result
          sample.reason = over.reason
          // Kiem chung cua E5: ban co cuc bo phai trung khop voi so nuoc server
          // da ap dung. Lech mot nuoc nghia la co nuoc di bi mat khi noi lai.
          // `board` bi nap lai tu FEN khi RESUME nen lich su cua no khong dung de
          // dem; `seen` moi la so ply client that su nhan duoc.
          sample.movesLost = sample.plies - seen.size
          sample.gamesPlayed += 1

          // Che do chay dai: vao ván moi de tai khong tu can dan.
          if (LOOP && (DURATION_SEC === 0 || now() - startedAt < DURATION_SEC * 1000)) {
            board.reset()
            seen.clear()
            myPly = 0
            sample.plies = 0
            myClockMs = BASE_MS
            moveSentAt = 0
            turnReadyAt = 0
            send(cgp.T.QUEUE_JOIN, cgp.json({ timeControl: TIME_CONTROL }))
            break
          }
          return finish()
        }

        case cgp.T.HEARTBEAT:
          // Server tu do RTT bang chu trinh nay, nen phai tra loi (X33).
          send(cgp.T.HEARTBEAT_ACK, Buffer.alloc(0))
          break

        case cgp.T.HEARTBEAT_ACK:
        case cgp.T.CLOCK_PONG:
        case cgp.T.DRAW_OFFERED:
        case cgp.T.SPECTATOR_COUNT:
          break

        case cgp.T.PEER_STATUS: {
          const peer = cgp.parseJson(frame.payload)
          if (VERBOSE) console.log(`  ${username}: PEER_STATUS ${peer.state}`)
          break
        }

        /**
         * Khong phai ERROR nao cung la dau cham het.
         *
         * 4001 nghia la van dang PAUSED vi doi thu mat ket noi (hoac rules
         * service dang chet): dung cach ung xu la CHO roi thu lai, y nhu nguoi
         * that se lam. Mot bot chet o day se lam hong chinh phep do cua E5 va
         * E7 — no bao "mat van" trong khi thuc te van van con nguyen.
         */
        case cgp.T.ERROR: {
          const failure = cgp.parseJson(frame.payload)
          const recoverable = failure.code === cgp.ERR.RULES_UNAVAILABLE
            || failure.code === cgp.ERR.RATE_LIMITED
          if (recoverable) {
            sample.waits += 1
            if (VERBOSE) console.log(`  ${username}: cho (${failure.code} ${failure.message})`)
            setTimeout(() => { if (!finished) maybeMove() }, 1000)
            break
          }
          sample.error = `${failure.code} ${failure.message}`
          return finish()
        }

        default:
          if (VERBOSE) console.log(`  ${username}: ${cgp.typeName(frame.type)}`)
      }
    }

    /** Gan mot socket (moi hoac noi lai) vao bo xu ly frame. */
    const attach = (fresh, onConnect) => {
      socket = fresh
      socket.setNoDelay(true)
      socket.on('connect', onConnect)
      socket.on('data', chunk => {
        sample.bytesIn += chunk.length
        let frames
        try {
          frames = accumulator.push(chunk)
        } catch (failure) {
          return finish(failure)
        }
        for (const frame of frames) {
          onFrame(frame)
          if (finished) return
        }
      })
      socket.on('error', failure => {
        // Dut ket noi co chu dich trong kich ban E5 khong phai la loi.
        if (reconnecting) return
        finish(failure)
      })
      socket.on('close', () => {
        if (reconnecting) return
        finish()
      })
    }

    attach(net.createConnection({ host: HOST, port: PORT }), () => {
      loginSentAt = now()
      send(cgp.T.LOGIN, cgp.json({ username, password: PASSWORD }))
    })
  })
}

// ---------------------------------------------------------------- chay

const percentile = (values, fraction) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

console.log(PLAY
  ? `Sinh tai: ${GAMES} ban (${BOTS} bot) -> ${HOST}:${PORT}, the thuc ${TIME_CONTROL}, format ${FORMAT}`
  : `Sinh tai: ${BOTS} bot dang nhap -> ${HOST}:${PORT}`)
if (WARMUP_SEC) console.log(`  ${WARMUP_SEC} s dau duoc danh dau warmup va khong tinh vao so lieu`)
if (DROP_AT) console.log(`  kich ban E5: cat ben ${DROP_SIDE} o nuoc ${DROP_AT}, noi lai sau ${RESUME_AFTER} s`)

const launched = []
for (let index = 0; index < BOTS; index++) {
  launched.push(runBot(FIRST + index))
  // Trai deu luc bat dau: 800 ket noi cung mot khoanh khac la kich ban khac
  // (bao reconnect, X08), khong phai kich ban muon do o E1.
  if (RAMP_MS > 0) await sleep(RAMP_MS / BOTS)
}
const samples = await Promise.all(launched)
const elapsed = now() - startedAt

const loggedIn = samples.filter(s => s.loginMs !== null)
const failed = samples.filter(s => s.error)
const finishedGames = samples.filter(s => s.result)
const counted = samples.flatMap(s => s.moves.filter(m => !m.warmup))
const latencies = counted.map(m => m.rttMs)

console.log(`\nDang nhap            : ${loggedIn.length}/${BOTS}`)
if (PLAY) {
  console.log(`Ghep cap             : ${samples.filter(s => s.matched).length}/${BOTS}`)
  const played = samples.reduce((sum, s) => sum + s.gamesPlayed, 0) / 2
  console.log(`Van ket thuc         : ${played} / ${GAMES}${LOOP ? ' (che do --loop)' : ''}`)
  const results = {}
  for (const sample of finishedGames) {
    const key = `${sample.result} (${sample.reason})`
    results[key] = (results[key] ?? 0) + 1
  }
  for (const [key, count] of Object.entries(results)) console.log(`  ${key}: ${count / 2} van`)
  console.log(`Tong nuoc di         : ${counted.length}`)
  console.log(`Nuoc bi tu choi      : ${samples.reduce((sum, s) => sum + s.rejects, 0)}`)
}
if (latencies.length) {
  console.log(`Move RTT p50/p95/p99 : ${percentile(latencies, 0.5)} / ${percentile(latencies, 0.95)} / ${percentile(latencies, 0.99)} ms`)
  console.log(`Throughput           : ${(counted.length / (elapsed / 1000)).toFixed(1)} nuoc/giay`)
  const applied = counted.map(m => m.bytes)
  const total = applied.reduce((sum, value) => sum + value, 0)
  console.log(`MOVE_APPLIED tren day: ${(total / applied.length).toFixed(1)} byte/nuoc (format ${FORMAT})`)
}
if (loggedIn.length) {
  const logins = loggedIn.map(s => s.loginMs)
  console.log(`LOGIN p50 / p95      : ${percentile(logins, 0.5)} / ${percentile(logins, 0.95)} ms`)
}

// --- E4: dong ho co cong bang khong? ---
//
// `driftMs` = thoi gian server TRU - thoi gian ta thuc su suy nghi. Voi mot
// nguoi choi noi truc tiep, con so nay gan 0. Voi nguoi choi o xa, moi nuoc di
// mat them mot vong khu hoi ma ho khong he "suy nghi" trong do — bu RTT sinh ra
// chinh la de khoan do khong bi tinh vao gio cua ho.
const drifts = counted.map(move => move.driftMs).filter(Number.isFinite)
if (drifts.length) {
  const total = drifts.reduce((sum, value) => sum + value, 0)
  console.log(`Clock drift p50/p95  : ${percentile(drifts, 0.5)} / ${percentile(drifts, 0.95)} ms moi nuoc`)
  console.log(`Clock drift cong don : ${Math.round(total)} ms sau ${drifts.length} nuoc`)
}
const resumed = samples.filter(s => s.resumes > 0)
if (resumed.length) {
  const recoveries = resumed.map(s => s.recoveryMs).filter(value => value != null).map(round2)
  const lost = samples.reduce((sum, s) => sum + Math.abs(s.movesLost), 0)
  console.log(`Noi lai thanh cong   : ${resumed.length}/${samples.filter(s => s.matched).length}`)
  console.log(`Nuoc di bi mat       : ${lost} (ky vong 0)`)
  if (recoveries.length) {
    console.log(`Recovery time p50    : ${percentile(recoveries, 0.5)} ms`)
  }
}
console.log(`That bai             : ${failed.length}`)
console.log(`Tong thoi gian       : ${Math.round(elapsed)} ms`)
console.log(`Byte gui / nhan      : ${samples.reduce((s, x) => s + x.bytesOut, 0)} / ${samples.reduce((s, x) => s + x.bytesIn, 0)}`)

for (const sample of failed.slice(0, 5)) console.log(`  loi ${sample.username}: ${sample.error}`)

// ---------------------------------------------------------------- ghi CSV

/**
 * Bat loi lech so cot giua tieu de va du lieu.
 *
 * Loi nay da xay ra that: them ba cot vao dong du lieu nhung quen sua tieu de.
 * File van ghi ra binh thuong, van mo duoc bang Excel, chi co dieu cong cu doc
 * `drift_ms` khong thay cot do nen bao "khong co du lieu" — va ca thi nghiem E4
 * im lang tra ve bang rong. Kiem ngay luc ghi thi hong o day, khong hong o cuoi.
 */
function checkColumns(header, rows, file) {
  const expected = header.trim().split(',').length
  for (const [index, row] of rows.entries()) {
    if (!row) continue
    const actual = row.split(',').length
    if (actual !== expected) {
      console.error(`\n!! ${file}: dong ${index + 2} co ${actual} cot,`
        + ` tieu de co ${expected}. Sua lai truoc khi dung so lieu nay.`)
      process.exit(3)
    }
  }
}

if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })

  // Mot dong moi nuoc di: p95/p99 khong tinh lai duoc tu ban tong ket.
  const header = 'label,format,games,username,game_id,color,ply,rtt_ms,applied_bytes,'
    + 'think_ms,charged_ms,drift_ms,warmup\n'
  const rows = []
  for (const sample of samples) {
    for (const move of sample.moves) {
      rows.push([LABEL, FORMAT, GAMES, sample.username, sample.gameId, sample.color ?? '',
        move.ply, move.rttMs, move.bytes,
        move.thinkMs ?? '', move.chargedMs ?? '', move.driftMs ?? '',
        move.warmup ? 1 : 0].join(','))
    }
  }
  checkColumns(header, rows, OUT)
  fs.writeFileSync(OUT, header + rows.join('\n') + '\n')
  console.log(`\nDa ghi ${rows.length} nuoc di vao ${OUT}`)

  // Ban tong ket theo bot, de doi chieu va de xem nhanh.
  const summaryPath = OUT.replace(/\.csv$/, '') + '-bots.csv'
  const summaryHeader =
    'label,format,games,username,game_id,color,login_ms,plies,result,reason,move_p50_ms,'
    + 'rejects,resumes,recovery_ms,moves_lost,waits,bytes_in,bytes_out,error\n'
  const summary = samples.map(s => [
    LABEL, FORMAT, GAMES, s.username, s.gameId, s.color ?? '', s.loginMs ?? '', s.plies,
    s.result ?? '', s.reason ?? '', percentile(s.moves.map(m => m.rttMs), 0.5) ?? '',
    s.rejects, s.resumes, s.recoveryMs ?? '', s.movesLost, s.waits, s.bytesIn, s.bytesOut, s.error ?? '',
  ].join(',')).join('\n')
  checkColumns(summaryHeader, summary.split('\n'), summaryPath)
  fs.writeFileSync(summaryPath, summaryHeader + summary + '\n')
  console.log(`Da ghi ${samples.length} dong tong ket vao ${summaryPath}`)
}

process.exit(failed.length ? 1 : 0)
