/**
 * Bot sinh tai cho Game Server.
 *
 * CODE CUA NHOM. Moi bot la mot ket noi TCP that, noi CGP bang dung bo codec
 * ma server dung (`common-js/cgp.js`) — nen day vua la cong cu do, vua la
 * mot bang chung nua cho tinh doc lap ngon ngu cua protocol (N6).
 *
 * Node phu hop cho viec nay: 400 ket noi tren mot tien trinh, khong ton
 * 400 thread.
 *
 * Tuan 1: dang nhap dong thoi, do do tre LOGIN va RTT, ghi CSV.
 * Tuan 3 se bo sung tu danh het van (E1..E5).
 *
 * Chay:
 *   node bot.js --bots 50
 *   node bot.js --bots 200 --host 127.0.0.1 --port 5555 --out ../../statics/results/e1-login.csv
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import * as cgp from '../common-js/cgp.js'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const HOST = argOf('host', process.env.SERVER_HOST ?? '127.0.0.1')
const PORT = Number(argOf('port', process.env.SERVER_PORT ?? 5555))
const BOTS = Number(argOf('bots', process.env.GAMES ?? 10))
const PASSWORD = argOf('pass', 'chess123')
const PREFIX = argOf('prefix', 'bot_')
const BEATS = Number(argOf('beats', 3))
const OUT = argOf('out', null)
const VERBOSE = argv.includes('--verbose')

const HEARTBEAT_MS = 5_000
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000   // ms, dong ho don dieu

/** Mot bot: ket noi, dang nhap, dap heartbeat, ghi lai do tre. */
function runBot(index) {
  const username = `${PREFIX}${index}`
  return new Promise(resolve => {
    const sample = { username, loginMs: null, rttMs: null, bytesIn: 0, bytesOut: 0, error: null }
    const accumulator = new cgp.FrameAccumulator()
    let seq = 1
    let beats = 0
    let loginSentAt = 0
    let pingSentAt = 0
    let timer = null

    const socket = net.createConnection({ host: HOST, port: PORT })
    socket.setNoDelay(true)

    const finish = error => {
      if (error && !sample.error) sample.error = String(error.message ?? error)
      clearInterval(timer)
      socket.destroy()
      resolve(sample)
    }

    const send = (type, payload) => {
      const frame = cgp.encodeFrame(type, seq++, payload)
      sample.bytesOut += frame.length
      socket.write(frame)
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
          case cgp.T.LOGIN_OK: {
            sample.loginMs = Math.round((now() - loginSentAt) * 100) / 100
            const profile = cgp.parseJson(frame.payload)
            if (VERBOSE) console.log(`  ${username}: LOGIN_OK elo=${profile.elo} (${sample.loginMs} ms)`)

            pingSentAt = now()
            send(cgp.T.CLOCK_PING, cgp.encodeClockPing(Date.now()))
            timer = setInterval(() => {
              if (beats++ >= BEATS) return finish()
              send(cgp.T.HEARTBEAT)
            }, HEARTBEAT_MS / 5)
            break
          }
          case cgp.T.CLOCK_PONG:
            sample.rttMs = Math.round((now() - pingSentAt) * 100) / 100
            break
          case cgp.T.HEARTBEAT_ACK:
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

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

const startedAt = now()
console.log(`Sinh tai: ${BOTS} bot -> ${HOST}:${PORT}`)

const samples = await Promise.all(Array.from({ length: BOTS }, (_, index) => runBot(index + 1)))
const elapsed = now() - startedAt

const ok = samples.filter(sample => sample.loginMs !== null && !sample.error)
const failed = samples.filter(sample => sample.error)
const logins = ok.map(sample => sample.loginMs)
const rtts = ok.filter(sample => sample.rttMs !== null).map(sample => sample.rttMs)

console.log(`\nDang nhap thanh cong : ${ok.length}/${BOTS}`)
console.log(`That bai             : ${failed.length}`)
if (logins.length) {
  console.log(`LOGIN p50 / p95 / max: ${percentile(logins, 0.5)} / ${percentile(logins, 0.95)} / ${Math.max(...logins)} ms`)
}
if (rtts.length) {
  console.log(`RTT   p50 / p95      : ${percentile(rtts, 0.5)} / ${percentile(rtts, 0.95)} ms`)
}
console.log(`Tong thoi gian       : ${Math.round(elapsed)} ms`)
console.log(`Byte gui / nhan      : ${samples.reduce((sum, s) => sum + s.bytesOut, 0)} / ${samples.reduce((sum, s) => sum + s.bytesIn, 0)}`)

for (const sample of failed.slice(0, 5)) {
  console.log(`  loi ${sample.username}: ${sample.error}`)
}

if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  const header = 'username,login_ms,rtt_ms,bytes_in,bytes_out,error\n'
  const rows = samples.map(s =>
    `${s.username},${s.loginMs ?? ''},${s.rttMs ?? ''},${s.bytesIn},${s.bytesOut},${s.error ?? ''}`).join('\n')
  fs.writeFileSync(OUT, header + rows + '\n')
  console.log(`\nDa ghi ${samples.length} dong vao ${OUT}`)
}

process.exit(failed.length ? 1 : 0)
