/**
 * TCP proxy bom do tre va jitter — cong cu do cua thi nghiem E4 (va ke ban cho E1).
 *
 * CODE CUA NHOM. Khong dung thu vien ngoai nao: chi `net` cua Node.
 *
 * VI SAO CAN: ca he thong chay tren mot may thi RTT loopback chi khoang 0.1 ms.
 * Do tren do se ra mot bang so rat dep va hoan toan vo nghia — bu RTT khong the
 * chung minh duoc gi khi khong co RTT nao de bu. Proxy nay dat giua client va
 * server de tao ra do tre THAT tren duong truyen, dung nhu mot nguoi choi ngoi
 * cach server 150 ms.
 *
 * Chay:
 *   node delay-proxy.js --listen 5556 --target 127.0.0.1:5555 --delay 150 --jitter 15
 *
 * Tham so:
 *   --listen   cong proxy lang nghe (client noi vao day)
 *   --target   host:port cua server that
 *   --delay    do tre MOT CHIEU, ms (RTT quan sat duoc se xap xi 2 x delay)
 *   --jitter   bien do dao quanh delay, ms — moi goi lay ngau nhien trong
 *              [delay - jitter, delay + jitter]
 *   --updown   "both" (mac dinh) | "up" | "down" — bom tre mot chieu hay ca hai
 *   --stats    in thong ke moi N giay (mac dinh 10, 0 de tat)
 *
 * **Giu nguyen thu tu goi:** moi chieu co mot hang doi rieng va moi goi duoc
 * hen gio theo moc "khong som hon goi truoc no". Neu bom tre bang setTimeout
 * roi mac ke, jitter se lam goi den DAO THU TU — ma TCP thi khong bao gio lam
 * the, va mot protocol tu dong khung nhu CGP se vo ngay. Bug nay rat de mac va
 * rat kho truy, nen no duoc xu ly o day mot cach tuong minh.
 */
import net from 'node:net'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const LISTEN = Number(argOf('listen', 5556))
const TARGET = argOf('target', '127.0.0.1:5555')
const DELAY = Number(argOf('delay', 100))
const JITTER = Number(argOf('jitter', 0))
const UPDOWN = argOf('updown', 'both')
const STATS_SEC = Number(argOf('stats', 10))

const [TARGET_HOST, TARGET_PORT] = (() => {
  const colon = TARGET.lastIndexOf(':')
  return [TARGET.slice(0, colon), Number(TARGET.slice(colon + 1))]
})()

if (!['both', 'up', 'down'].includes(UPDOWN)) {
  console.error(`--updown phai la both | up | down, nhan: ${UPDOWN}`)
  process.exit(2)
}

const stats = { connections: 0, open: 0, up: 0, down: 0, bytesUp: 0, bytesDown: 0 }

/** Do tre cua mot goi: delay +/- jitter, khong bao gio am. */
const sampleDelay = () =>
  Math.max(0, DELAY + (JITTER > 0 ? (Math.random() * 2 - 1) * JITTER : 0))

/**
 * Mot chieu truyen. Giu `releaseAt` de goi sau khong bao gio duoc tha truoc goi
 * truoc, ke ca khi jitter cua no nho hon.
 */
function createPipe(destination, enabled, onBytes) {
  let releaseAt = 0
  let closed = false

  return {
    push(chunk) {
      onBytes(chunk.length)
      if (!enabled) {
        destination.write(chunk)
        return
      }
      const now = Date.now()
      releaseAt = Math.max(now + sampleDelay(), releaseAt)
      const wait = releaseAt - now
      setTimeout(() => {
        if (!closed && destination.writable) destination.write(chunk)
      }, wait)
    },
    close() {
      closed = true
    },
  }
}

const server = net.createServer(client => {
  const id = ++stats.connections
  stats.open += 1
  client.setNoDelay(true)

  const upstream = net.createConnection({ host: TARGET_HOST, port: TARGET_PORT })
  upstream.setNoDelay(true)

  const toServer = createPipe(upstream, UPDOWN !== 'down', bytes => {
    stats.up += 1
    stats.bytesUp += bytes
  })
  const toClient = createPipe(client, UPDOWN !== 'up', bytes => {
    stats.down += 1
    stats.bytesDown += bytes
  })

  client.on('data', chunk => toServer.push(chunk))
  upstream.on('data', chunk => toClient.push(chunk))

  // Dong mot dau thi dong not dau kia — nhung phai cho phan da hen gio bay
  // xong, neu khong thi chinh proxy lai lam mat message cuoi cung.
  const shutdown = () => {
    toServer.close()
    toClient.close()
    stats.open -= 1
    setTimeout(() => {
      client.destroy()
      upstream.destroy()
    }, DELAY * 2 + JITTER + 50)
  }

  let done = false
  const once = () => {
    if (done) return
    done = true
    shutdown()
  }

  client.on('close', once)
  upstream.on('close', once)
  client.on('error', once)
  upstream.on('error', failure => {
    if (failure.code === 'ECONNREFUSED') {
      console.error(`#${id}: khong noi duoc toi ${TARGET} — server that da chay chua?`)
    }
    once()
  })
})

server.on('error', failure => {
  console.error(`Khong mo duoc cong ${LISTEN}: ${failure.message}`)
  process.exit(1)
})

server.listen(LISTEN, '0.0.0.0', () => {
  const chieu = { both: 'ca hai chieu', up: 'chieu len', down: 'chieu xuong' }[UPDOWN]
  console.log(`Delay proxy | 0.0.0.0:${LISTEN} -> ${TARGET}`)
  console.log(`  do tre ${DELAY} ms +/- ${JITTER} ms, ${chieu} (RTT quan sat ~ ${
    UPDOWN === 'both' ? DELAY * 2 : DELAY} ms)`)
})

if (STATS_SEC > 0) {
  setInterval(() => {
    console.log(`  dang mo ${stats.open} | len ${stats.up} goi / ${stats.bytesUp} B`
      + ` | xuong ${stats.down} goi / ${stats.bytesDown} B`)
  }, STATS_SEC * 1000).unref()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nDung lai. Da chuyen ${stats.bytesUp + stats.bytesDown} byte`
      + ` qua ${stats.connections} ket noi.`)
    process.exit(0)
  })
}
