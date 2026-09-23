/**
 * Web Gateway: WebSocket <-> TCP, mang nguyen frame CGP.
 *
 * CODE CUA NHOM. Khong dung thu vien WebSocket ngoai: bat tay va dong khung
 * theo RFC 6455 duoc viet o `websocket.js` ben canh. Ly do khong phai la de
 * cho kho, ma vi day dung la noi dung mon hoc — va vi no cho E8 mot con so
 * sach de so: overhead moi message cua WebSocket so voi TCP thuan.
 *
 * Vai tro: trinh duyet khong mo duoc socket TCP thuan, nhung protocol cua he
 * thong la CGP tren TCP. Gateway dich DUONG TRUYEN chu khong dich NOI DUNG:
 *
 *     Trinh duyet --binary WS frame--> Gateway --TCP stream--> Game Server
 *
 * Moi WebSocket message binary chua DUNG MOT frame CGP tron ven. Chieu nguoc
 * lai phai gom byte lai bang FrameAccumulator truoc khi gui, vi TCP khong giu
 * ranh gioi message con WebSocket thi co — bo buoc nay thi client trinh duyet
 * se nhan duoc nhung manh frame vo nghia.
 *
 * Gateway KHONG giu trang thai van dau. No chet thi chi nguoi xem bi anh huong,
 * nguoi choi qua TCP thuan va cac van dang chay khong he hay biet (X60) — day
 * la mot bang chung co lap loi de dua vao bao cao.
 *
 * Chay:
 *   node gateway.js --ws 8080 --tcp 127.0.0.1:5555
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cgp from '../common-js/cgp.js'
import { acceptUpgrade, WebSocketConnection } from './websocket.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const WS_PORT = Number(argOf('ws', process.env.WS_PORT ?? 8080))
const TCP_TARGET = argOf('tcp', process.env.TCP_TARGET ?? '127.0.0.1:5555')
const VERBOSE = argv.includes('--verbose')

const [GAME_HOST, GAME_PORT] = (() => {
  const colon = TCP_TARGET.lastIndexOf(':')
  return [TCP_TARGET.slice(0, colon), Number(TCP_TARGET.slice(colon + 1))]
})()

const stats = { sessions: 0, open: 0, framesUp: 0, framesDown: 0, bytesUp: 0, bytesDown: 0 }

// ------------------------------------------------------------- phuc vu file

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, ...stats, target: TCP_TARGET }))
    return
  }

  const wanted = request.url === '/' ? '/index.html' : request.url.split('?')[0]
  const file = path.join(here, 'public', path.normalize(wanted).replace(/^([/\\])+/, ''))
  // Chan di nguoc ra ngoai thu muc public.
  if (!file.startsWith(path.join(here, 'public'))) {
    response.writeHead(403).end('403')
    return
  }
  fs.readFile(file, (failure, body) => {
    if (failure) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Khong tim thay ' + wanted)
      return
    }
    response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    response.end(body)
  })
})

// ---------------------------------------------------------------- cau noi

server.on('upgrade', (request, socket, head) => {
  if (!acceptUpgrade(request, socket)) {
    return
  }
  const id = ++stats.sessions
  stats.open += 1

  const ws = new WebSocketConnection(socket, head)
  const upstream = net.createConnection({ host: GAME_HOST, port: GAME_PORT })
  upstream.setNoDelay(true)

  const accumulator = new cgp.FrameAccumulator()
  let closed = false

  const shutdown = why => {
    if (closed) return
    closed = true
    stats.open -= 1
    if (VERBOSE) console.log(`- phien #${id} dong (${why})`)
    ws.close()
    upstream.destroy()
  }

  // Trinh duyet -> server: moi message la mot frame CGP tron ven, chuyen thang.
  ws.on('message', payload => {
    stats.framesUp += 1
    stats.bytesUp += payload.length
    if (upstream.writable) upstream.write(payload)
  })
  ws.on('close', () => shutdown('client dong tab'))
  ws.on('error', failure => shutdown('loi ws: ' + failure.message))

  // Server -> trinh duyet: phai TAI DONG KHUNG truoc khi gui.
  upstream.on('data', chunk => {
    stats.bytesDown += chunk.length
    let frames
    try {
      frames = accumulator.push(chunk)
    } catch (failure) {
      console.error(`! phien #${id}: ${failure.message}`)
      shutdown('frame hong tu server')
      return
    }
    for (const frame of frames) {
      stats.framesDown += 1
      ws.sendBinary(cgp.encodeFrame(frame.type, frame.seq, frame.payload))
      if (VERBOSE) console.log(`  #${id} <- ${cgp.typeName(frame.type)}`)
    }
  })

  upstream.on('error', failure => {
    // Game server chua chay hoac vua chet: bao cho nguoi xem biet bang mot frame
    // ERROR dung protocol thay vi dong im lang.
    try {
      ws.sendBinary(cgp.encodeFrame(cgp.T.ERROR, 0, cgp.json({
        code: cgp.ERR.SERVER_OVERLOADED,
        message: `gateway khong noi duoc toi ${TCP_TARGET}: ${failure.message}`,
      })))
    } catch { /* ws co the da dong */ }
    shutdown('loi tcp: ' + failure.message)
  })
  upstream.on('close', () => shutdown('server dong ket noi'))

  if (VERBOSE) console.log(`+ phien #${id} tu ${socket.remoteAddress}`)
})

server.listen(WS_PORT, '0.0.0.0', () => {
  console.log(`Web Gateway | ws://0.0.0.0:${WS_PORT} -> ${TCP_TARGET}`)
  console.log(`  giao dien khan gia: http://localhost:${WS_PORT}/`)
})

server.on('error', failure => {
  console.error(`Khong mo duoc cong ${WS_PORT}: ${failure.message}`)
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nDung lai. ${stats.sessions} phien, ${stats.framesUp} frame len,`
      + ` ${stats.framesDown} frame xuong.`)
    server.close(() => process.exit(0))
  })
}
