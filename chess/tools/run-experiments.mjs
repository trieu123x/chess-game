/**
 * Chay cac thi nghiem E1..E8 va sinh CSV + bieu do.
 *
 * CODE CUA NHOM. Muc dich khong phai la "tu dong hoa cho nhanh" ma la de KET
 * QUA TAI LAP DUOC: moi kich ban duoc mo ta o day bang cau hinh, nen nguoi
 * khac chay lai mot lenh la ra cung bo so lieu, khong phu thuoc vao viec ai do
 * nho da doi tay nhung gi (yeu cau §14 cua README va nguyen tac 3 cua
 * EXPERIMENTS.md).
 *
 * Chay:
 *   node run-experiments.mjs                 # tat ca
 *   node run-experiments.mjs --only e1,e3    # chi mot vai cai
 *   node run-experiments.mjs --quick         # ban rut gon de thu duong chay
 *   node run-experiments.mjs --repeat 3      # lap moi kich ban 3 lan (mac dinh 1)
 *
 * Yeu cau: PostgreSQL da co schema, JDK 17+, Node 20+, va `mvn package` da chay.
 *
 * Luu y ve so lieu: `--repeat 1` chi de thu duong chay. Bo so lieu dua vao bao
 * cao phai chay voi `--repeat 3` tro len, dung nhu nguyen tac 1 cua EXPERIMENTS.md.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'

const HERE = import.meta.dirname
const CHESS = path.resolve(HERE, '..')
const SOURCE = path.join(CHESS, 'source')
const RESULTS = path.join(CHESS, 'statics', 'results')
const SERVER_JAR = path.join(SOURCE, 'server', 'target', 'dcgs-server.jar')
const SERVER_CONFIG = path.join(SOURCE, 'server', 'config.properties')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const QUICK = argv.includes('--quick')
const REPEAT = Number(argOf('repeat', 1))
const ONLY = (argOf('only', '') || '').split(',').map(name => name.trim()).filter(Boolean)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const wants = name => !ONLY.length || ONLY.includes(name)

// ------------------------------------------------------------- tien ich

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, out, err }))
  })
}

const waitForPort = async (port, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const open = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => resolve(false))
    })
    if (open) return true
    await sleep(300)
  }
  return false
}

const waitForPortClosed = async (port, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const open = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => resolve(false))
    })
    if (!open) return true
    await sleep(300)
  }
  return false
}

/**
 * Tat mot tien trinh con va doi no THUC SU chet.
 *
 * Tren Windows, `child.kill()` chi bao cho tien trinh dau tien; JVM chay qua
 * lop bao boc co the song tiep. Neu khong kiem, kich ban sau se do nham vao
 * server cua kich ban truoc — loi nay da xay ra that: E3 o che do `json` van
 * bi server `binary` cua vong truoc tra loi, va ket qua trong nhu che do json
 * bi hong. Vi vay: kill, doi, roi `taskkill /T` neu van con.
 */
async function stop(child) {
  if (!child || child.exitCode !== null) return
  const ended = new Promise(resolve => child.once('close', resolve))
  child.kill()
  await Promise.race([ended, sleep(2500)])
  if (process.platform === 'win32') {
    // Khong dat dieu kien `exitCode === null`: co truong hop tien trinh cha da
    // thoat ma JVM con thi ta van phai don. taskkill that bai la vo hai.
    await run('taskkill', ['/F', '/T', '/PID', String(child.pid)])
  } else {
    child.kill('SIGKILL')
  }
  await Promise.race([ended, sleep(2500)])
}

// --------------------------------------------------------- khoi dong stack

const started = []

async function startRules(port) {
  const child = spawn(process.execPath, ['index.js', '--port', String(port)],
    { cwd: path.join(SOURCE, 'rules-service'), stdio: ['ignore', 'pipe', 'pipe'] })
  started.push(child)
  if (!await waitForPort(port)) throw new Error(`rules service ${port} khong len`)
  return child
}

/**
 * Khoi dong Game Server voi cac gia tri cau hinh bi ghi de.
 *
 * Ghi de bang BIEN MOI TRUONG chu khong sua file: `Config.java` doc
 * `server.io` tu `SERVER_IO`... Nho vay mot lan chay nhieu kich ban khong bao
 * gio de lai mot file config bi sua do dang.
 */
async function startServer(overrides = {}, port = 5555) {
  // Nhip [stats] mac dinh 10 s la qua thua voi cac kich ban chi chay vai chuc
  // giay - se khong kip in dong nao va cot thread/heap se rong. Do thi rut xuong 2 s.
  const env = { ...process.env, SERVER_PORT: String(port), SERVER_STATSINTERVALMS: '2000' }
  for (const [key, value] of Object.entries(overrides)) {
    env[key.toUpperCase().replace(/\./g, '_')] = String(value)
  }
  const child = spawn('java', ['-jar', SERVER_JAR, '--config', SERVER_CONFIG],
    { cwd: path.join(SOURCE, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  started.push(child)

  // Server tu in dong "[stats] threads=... heapMB=..." theo chu ky. Doc o day
  // thay vi goi `jcmd`: khong phai may nao cung co JDK day du tren PATH, va
  // con so tu chinh tien trinh do thi dung hon la do tu ngoai vao.
  child.peak = { threads: 0, heapMb: 0, dbQueue: 0 }

  // Phai GOM DONG: stdout ve theo tung mau tuy y, khong trung ranh gioi dong.
  // Mot dong `[stats]` bi cat lam doi thi khong nua nao khop regex, va cot
  // thread/heap se bo trong ma khong bao loi gi. Day chinh la ly do cac kich ban
  // ngan cua E2 truoc day khong co so lieu tai nguyen.
  let pending = ''
  child.stdout.on('data', chunk => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const found = line.match(/\[stats\] threads=(\d+) heapMB=(\d+) games=(\d+) dbQueue=(\d+)/)
      if (!found) continue
      child.peak.threads = Math.max(child.peak.threads, Number(found[1]))
      child.peak.heapMb = Math.max(child.peak.heapMb, Number(found[2]))
      child.peak.dbQueue = Math.max(child.peak.dbQueue, Number(found[4]))
    }
  })
  child.stderr.on('data', () => { /* nuot, neu khong buffer se day */ })
  if (!await waitForPort(port)) throw new Error('game server khong len')
  return child
}

/**
 * Tat ca stack va KHANG DINH cong 5555 da dong.
 *
 * Khong kiem tra o day thi mot server song sot se am tham phuc vu kich ban ke
 * tiep voi cau hinh cu, va ta se ghi vao bao cao mot con so do sai cau hinh.
 * Tha dung han con hon.
 */
/**
 * Tim va giet tien trinh dang giu mot cong.
 *
 * Can den cach nay vi tren Windows, `java` tren PATH thuong la mot stub cua
 * Oracle (`Common Files/Oracle/Java/javapath/java.exe`) chi lam nhiem vu goi
 * JVM that roi thoat. Giet stub - ke ca bang `taskkill /T` - khong giet JVM,
 * nen server cu van giu cong 5555 va am tham phuc vu kich ban ke tiep bang
 * cau hinh cu. Giet theo CONG thi chac chan dung tien trinh can giet.
 */
async function killListener(port) {
  if (process.platform !== 'win32') return
  const result = await run('netstat', ['-ano'])
  const pids = new Set()
  for (const line of result.out.split('\n')) {
    if (!line.includes('LISTENING') || !line.includes(`:${port} `)) continue
    const pid = line.trim().split(/\s+/).pop()
    if (pid && pid !== '0') pids.add(pid)
  }
  for (const pid of pids) {
    await run('taskkill', ['/F', '/PID', pid])
  }
}

async function stopAll() {
  for (const child of started.splice(0)) await stop(child)
  if (!await waitForPortClosed(5555, 5_000)) {
    await killListener(5555)
  }
  if (!await waitForPortClosed(5555, 10_000)) {
    throw new Error('cong 5555 van mo sau khi tat: co server con sot lai, dung do tiep')
  }
}

// -------------------------------------------------------------- chay bot

async function bots(args) {
  const result = await run(process.execPath, ['bot.js', ...args],
    { cwd: path.join(SOURCE, 'bot') })
  return result.out
}

const parse = (text, label) => {
  const line = text.split('\n').find(row => row.startsWith(label))
  return line ? line.split(':').slice(1).join(':').trim() : ''
}

/** Doc CSV moi-nuoc-mot-dong roi tinh phan vi, bo cac mau warm-up. */
function summarise(csvPath) {
  if (!fs.existsSync(csvPath)) return null
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(Boolean)
  const header = lines[0].split(',')
  const rttIndex = header.indexOf('rtt_ms')
  const bytesIndex = header.indexOf('applied_bytes')
  const warmupIndex = header.indexOf('warmup')

  const rtt = []
  const bytes = []
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    if (warmupIndex >= 0 && cells[warmupIndex] === '1') continue
    const value = Number(cells[rttIndex])
    if (Number.isFinite(value)) rtt.push(value)
    const size = Number(cells[bytesIndex])
    if (Number.isFinite(size)) bytes.push(size)
  }
  if (!rtt.length) return null

  rtt.sort((a, b) => a - b)
  const at = fraction => rtt[Math.min(rtt.length - 1, Math.floor(rtt.length * fraction))]
  return {
    moves: rtt.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    bytesPerMove: bytes.length ? +(bytes.reduce((s, v) => s + v, 0) / bytes.length).toFixed(2) : '',
  }
}

/**
 * Doc cot `drift_ms` cua CSV thô — phep do that su cua E4.
 *
 * drift = thoi gian server TRU - thoi gian client thuc su suy nghi. Bang 0
 * nghia la dong ho hoan toan cong bang; cang lon nghia la nguoi choi cang bi
 * tru oan vi do tre mang.
 */
function driftOf(csvPath) {
  if (!fs.existsSync(csvPath)) return null
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(Boolean)
  const header = lines[0].split(',')
  const driftIndex = header.indexOf('drift_ms')
  const warmupIndex = header.indexOf('warmup')
  if (driftIndex < 0) return null

  const drifts = []
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    if (warmupIndex >= 0 && cells[warmupIndex] === '1') continue
    const value = Number(cells[driftIndex])
    if (Number.isFinite(value)) drifts.push(value)
  }
  if (!drifts.length) return null

  drifts.sort((a, b) => a - b)
  return {
    moves: drifts.length,
    median: +drifts[Math.floor(drifts.length / 2)].toFixed(2),
    total: drifts.reduce((sum, value) => sum + value, 0),
  }
}

const writeCsv = (file, header, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, header + '\n' + rows.join('\n') + '\n')
  console.log(`  -> ${path.relative(CHESS, file)}`)
}

async function plot(args) {
  const result = await run(process.execPath, ['plot.js', ...args], { cwd: HERE })
  if (result.code !== 0) console.log(`  (bo qua bieu do: ${result.err.trim().split('\n')[0]})`)
}

/** Lay trung vi cua nhieu lan lap - nguyen tac 1 cua EXPERIMENTS.md. */
const medianOf = values => {
  const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]
    : +((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2)
}

// ==================================================================== E1

async function e1() {
  console.log('\n=== E1 - do tre va thong luong theo tai ===')
  const loads = QUICK ? [5, 20] : [10, 50, 100]
  const out = path.join(RESULTS, 'e1')
  const rows = []

  for (const games of loads) {
    const samples = []
    for (let attempt = 1; attempt <= REPEAT; attempt++) {
      await startRules(6001)
      await startRules(6002)
      const server = await startServer({ 'server.io': 'nio', 'server.format': 'binary' })

      const csv = path.join(out, `raw-${games}-lan${attempt}.csv`)
      const text = await bots(['--play', '--games', String(games), '--tc', '120+0',
        '--maxPlies', '60', '--ramp', '2000', '--out', csv, '--label', `e1-${games}`])
      const finished = parse(text, 'Van ket thuc')
      const failed = parse(text, 'That bai')
      const throughput = parse(text, 'Throughput')
      const summary = summarise(csv)
      await stopAll()

      if (summary) {
        samples.push({ ...summary, finished, failed, throughput: parseFloat(throughput) || 0,
          threads: server.peak.threads, heapMb: server.peak.heapMb, dbQueue: server.peak.dbQueue })
        console.log(`  ${games} ban lan ${attempt}: p50 ${summary.p50} / p95 ${summary.p95}`
          + ` / p99 ${summary.p99} ms, ${summary.moves} nuoc, van xong ${finished}`)
      }
    }
    if (!samples.length) continue
    rows.push([games, games * 2, medianOf(samples.map(s => s.p50)),
      medianOf(samples.map(s => s.p95)), medianOf(samples.map(s => s.p99)),
      medianOf(samples.map(s => s.throughput)),
      medianOf(samples.map(s => s.threads)), medianOf(samples.map(s => s.heapMb)),
      samples.reduce((sum, s) => sum + s.moves, 0), samples.length].join(','))
  }

  writeCsv(path.join(out, 'summary.csv'),
    'games,connections,p50_ms,p95_ms,p99_ms,moves_per_sec,jvm_threads,heap_mb,total_moves,runs', rows)
  await plot(['--in', path.join(out, 'summary.csv'), '--x', 'games', '--y', 'p50_ms,p95_ms,p99_ms',
    '--title', 'E1 - do tre nuoc di theo so ban dong thoi', '--ylabel', 'ms',
    '--out', path.join(out, 'e1-latency.png')])
  await plot(['--in', path.join(out, 'summary.csv'), '--x', 'games', '--y', 'moves_per_sec',
    '--title', 'E1 - thong luong theo so ban', '--ylabel', 'nuoc di / giay',
    '--out', path.join(out, 'e1-throughput.png')])
}

// ==================================================================== E2

async function e2() {
  console.log('\n=== E2 - NIO vs thread-per-connection ===')
  const loads = QUICK ? [5, 20] : [10, 50, 100]
  const out = path.join(RESULTS, 'e2')
  const rows = []

  for (const io of ['nio', 'blocking']) {
    for (const games of loads) {
      const samples = []
      for (let attempt = 1; attempt <= REPEAT; attempt++) {
        await startRules(6001)
        await startRules(6002)
        const server = await startServer({ 'server.io': io })

        const csv = path.join(out, `raw-${io}-${games}-lan${attempt}.csv`)
        await bots(['--play', '--games', String(games), '--tc', '120+0', '--maxPlies', '60',
          '--ramp', '2000', '--out', csv, '--label', `e2-${io}-${games}`])
        // So thread cua JVM la con so quan trong nhat cua thi nghiem nay: che do
        // blocking ton ~2 thread moi ket noi, nio thi khong.
        const threads = server.peak.threads
        const summary = summarise(csv)
        const heapMb = server.peak.heapMb
        await stopAll()

        if (summary) {
          samples.push({ ...summary, threads, heapMb })
          console.log(`  ${io} ${games} ban lan ${attempt}: p95 ${summary.p95} ms,`
            + ` ${threads} thread, ${heapMb} MB heap`)
        }
      }
      if (!samples.length) continue
      rows.push([io, games, games * 2, medianOf(samples.map(s => s.p50)),
        medianOf(samples.map(s => s.p95)), medianOf(samples.map(s => s.threads)),
        medianOf(samples.map(s => s.heapMb)),
        samples.length].join(','))
    }
  }

  writeCsv(path.join(out, 'summary.csv'),
    'io,games,connections,p50_ms,p95_ms,jvm_threads,heap_mb,runs', rows)
  await plot(['--in', path.join(out, 'summary.csv'), '--x', 'games', '--y', 'p95_ms',
    '--group', 'io', '--title', 'E2 - p95 theo so ban: nio vs blocking', '--ylabel', 'ms',
    '--out', path.join(out, 'e2-p95.png')])
  await plot(['--in', path.join(out, 'summary.csv'), '--x', 'games', '--y', 'jvm_threads',
    '--group', 'io', '--title', 'E2 - so thread cua JVM theo so ban', '--ylabel', 'thread',
    '--out', path.join(out, 'e2-threads.png')])
}


// ==================================================================== E3

async function e3() {
  console.log('\n=== E3 - binary + delta vs JSON + FEN ===')
  const out = path.join(RESULTS, 'e3')
  const games = QUICK ? 5 : 20
  const rows = []

  for (const format of ['binary', 'json']) {
    const samples = []
    for (let attempt = 1; attempt <= REPEAT; attempt++) {
      await startRules(6001)
      await startRules(6002)
      await startServer({ 'server.format': format })

      const csv = path.join(out, `raw-${format}-lan${attempt}.csv`)
      const text = await bots(['--play', '--games', String(games), '--tc', '120+0',
        '--maxPlies', '60', '--format', format, '--out', csv, '--label', `e3-${format}`])
      const traffic = parse(text, 'Byte gui / nhan')
      const summary = summarise(csv)
      await stopAll()

      if (summary) {
        const [sent, received] = traffic.split('/').map(value => Number(value.trim()))
        samples.push({ ...summary, sent, received, perGame: (sent + received) / (games * 1.0) })
        console.log(`  ${format} lan ${attempt}: ${summary.bytesPerMove} byte/nuoc (S->C),`
          + ` tong ${sent + received} byte`)
      }
    }
    if (!samples.length) continue
    rows.push([format, games, medianOf(samples.map(s => s.bytesPerMove)),
      medianOf(samples.map(s => s.perGame)), medianOf(samples.map(s => s.p95)),
      samples.length].join(','))
  }

  // Cot tiet kiem duoc tinh ngay o day de bao cao khong phai tinh tay.
  const withSaving = rows.map(row => {
    const cells = row.split(',')
    const baseline = rows.find(other => other.startsWith('json'))
    if (!baseline) return row + ','
    const baseBytes = Number(baseline.split(',')[2])
    const saving = baseBytes ? (100 * (1 - Number(cells[2]) / baseBytes)).toFixed(1) : ''
    return row + ',' + saving
  })

  writeCsv(path.join(out, 'summary.csv'),
    'format,games,bytes_per_move,bytes_per_game,p95_ms,runs,saving_percent', withSaving)
  await plot(['--in', path.join(out, 'summary.csv'), '--x', 'format', '--y', 'bytes_per_move',
    '--kind', 'bar', '--title', 'E3 - byte moi nuoc di (server -> client)',
    '--ylabel', 'byte', '--out', path.join(out, 'e3-bytes.png')])
}

// ==================================================================== E4

async function e4() {
  console.log('\n=== E4 - cong bang dong ho khi co do tre ===')
  const out = path.join(RESULTS, 'e4')
  const delays = QUICK ? [0, 150] : [0, 50, 150, 300]
  const rows = []

  for (const compensation of ['false', 'true']) {
    for (const delay of delays) {
      const samples = []
      for (let attempt = 1; attempt <= REPEAT; attempt++) {
        await startRules(6001)
        await startRules(6002)
        await startServer({ 'clock.compensation': compensation })

        // Ben Den di qua proxy; ben Trang noi thang. Chenh lech giua hai dong ho
        // chinh la thiet hai ma do tre gay ra.
        const proxy = spawn(process.execPath, ['delay-proxy.js', '--listen', '5566',
          '--target', '127.0.0.1:5555', '--delay', String(delay),
          '--jitter', String(Math.round(delay * 0.1)), '--stats', '0'],
          { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] })
        started.push(proxy)
        await waitForPort(5566)

        const straight = path.join(out, `raw-white-${compensation}-${delay}-lan${attempt}.csv`)
        const delayed = path.join(out, `raw-black-${compensation}-${delay}-lan${attempt}.csv`)
        const [whiteText, blackText] = await Promise.all([
          bots(['--play', '--games', '1', '--tc', '180+0', '--maxPlies', '40',
            '--first', '201', '--out', straight, '--label', 'e4-truc-tiep']),
          // Bot thu hai chi dong vai ben bi tre: no dung cung tai khoan range khac
          // va noi qua proxy.
          (async () => {
            await sleep(200)
            return bots(['--play', '--games', '1', '--tc', '180+0', '--maxPlies', '40',
              '--first', '203', '--port', '5566', '--out', delayed, '--label', 'e4-qua-proxy'])
          })(),
        ])
        // Con so cua E4 KHONG phai do tre khu hoi. Do tre khu hoi bi chi phoi
        // boi do tre mang va gan nhu khong doi du co bu hay khong - do dung no
        // se ket luan sai rang bu RTT vo tac dung. Cai can do la DRIFT: thoi
        // gian server tru cho nguoi choi, tru di thoi gian ho thuc su suy nghi.
        const direct = driftOf(straight)
        const viaProxy = driftOf(delayed)
        await stopAll()

        if (direct && viaProxy) {
          samples.push({
            directDrift: direct.median,
            proxyDrift: viaProxy.median,
            proxyTotal: viaProxy.total,
            moves: viaProxy.moves,
          })
          console.log(`  bu=${compensation} delay=${delay}ms lan ${attempt}:`
            + ` drift truc tiep ${direct.median} ms/nuoc,`
            + ` qua proxy ${viaProxy.median} ms/nuoc`
            + ` (cong don ${Math.round(viaProxy.total)} ms sau ${viaProxy.moves} nuoc)`)
        }
        await sleep(500)
      }
      if (!samples.length) continue
      rows.push([compensation, delay,
        medianOf(samples.map(s => s.directDrift)),
        medianOf(samples.map(s => s.proxyDrift)),
        Math.round(medianOf(samples.map(s => s.proxyTotal))),
        medianOf(samples.map(s => s.moves)),
        samples.length].join(','))
    }
  }

  writeCsv(path.join(out, 'summary.csv'),
    'compensation,delay_ms,direct_drift_ms,proxied_drift_ms,'
    + 'proxied_total_drift_ms,moves,runs', rows)
  await plot(['--in', path.join(out, 'summary.csv'), '--x', 'delay_ms',
    '--y', 'proxied_drift_ms', '--group', 'compensation',
    '--title', 'E4 - gio bi tru oan moi nuoc, theo do tre mang',
    '--ylabel', 'ms moi nuoc', '--out', path.join(out, 'e4-drift.png')])
}

// ==================================================================== E5

async function e5() {
  console.log('\n=== E5 - mat ket noi va noi lai ===')
  const out = path.join(RESULTS, 'e5')
  const waits = QUICK ? [5] : [5, 20, 50]
  const games = QUICK ? 3 : 10
  const rows = []

  for (const wait of waits) {
    await startRules(6001)
    await startRules(6002)
    await startServer({})

    const csv = path.join(out, `raw-${wait}s.csv`)
    const text = await bots(['--play', '--games', String(games), '--tc', '600+0',
      '--maxPlies', '60', '--drop-at', '8', '--drop-side', 'w',
      '--resume-after', String(wait), '--out', csv, '--label', `e5-${wait}s`])
    await stopAll()

    const resumed = parse(text, 'Noi lai thanh cong')
    const lost = parse(text, 'Nuoc di bi mat')
    const recovery = parse(text, 'Recovery time p50')
    const finished = parse(text, 'Van ket thuc')
    console.log(`  ngat ${wait}s: noi lai ${resumed}, nuoc mat ${lost}, hoi phuc ${recovery}`)
    rows.push([wait, games, resumed, recovery.replace(' ms', ''),
      (lost.split(' ')[0] || ''), finished.replace(/\s/g, '')].join(','))
  }

  // Qua han an han: van phai ket thuc dung luat chu khong treo mai (T07).
  if (!QUICK) {
    await startRules(6001)
    await startRules(6002)
    await startServer({ 'reconnect.graceMs': 5000 })
    const csv = path.join(out, 'raw-qua-grace.csv')
    const text = await bots(['--play', '--games', '3', '--tc', '600+0', '--maxPlies', '60',
      '--drop-at', '8', '--drop-side', 'w', '--resume-after', '12',
      '--out', csv, '--label', 'e5-qua-grace'])
    await stopAll()
    const finished = parse(text, 'Van ket thuc')
    console.log(`  ngat 12s voi grace 5s: van ket thuc ${finished} (ky vong: xu thua)`)
    rows.push(['12 (grace 5s)', 3, '-', '-', '-', finished.replace(/\s/g, '')].join(','))
  }

  writeCsv(path.join(out, 'summary.csv'),
    'outage_s,games,resumed,recovery_p50_ms,moves_lost,games_finished', rows)
  await plot(['--in', path.join(out, 'summary.csv'), '--x', 'outage_s',
    '--y', 'recovery_p50_ms', '--kind', 'bar',
    '--title', 'E5 - thoi gian hoi phuc theo do dai lan ngat', '--ylabel', 'ms',
    '--out', path.join(out, 'e5-recovery.png')])
}

// ==================================================================== E6

async function e6() {
  console.log('\n=== E6 - server-authoritative validation ===')
  const out = path.join(RESULTS, 'e6')
  await startRules(6001)
  await startRules(6002)
  await startServer({})

  const result = await run(process.execPath,
    ['cheat.js', '--rounds', QUICK ? '10' : '50', '--flood', '300',
      '--out', path.join(out, 'e6.csv')],
    { cwd: path.join(SOURCE, 'bot') })
  await stopAll()

  process.stdout.write(result.out.split('--- Ket qua ---')[1] ?? result.out)
  console.log(`  -> ${path.relative(CHESS, path.join(out, 'e6.csv'))}`)
}

// ==================================================================== E7

async function e7() {
  console.log('\n=== E7 - rules service: instance, cache, embedded ===')
  const out = path.join(RESULTS, 'e7')
  const games = QUICK ? 5 : 20
  const rows = []

  const scenarios = [
    { name: 'embedded', rules: 0, overrides: { 'rules.mode': 'embedded' } },
    { name: 'remote-1-khong-cache', rules: 1, overrides: { 'rules.endpoints': '127.0.0.1:6001', 'rules.cache': 'false' } },
    { name: 'remote-1-co-cache', rules: 1, overrides: { 'rules.endpoints': '127.0.0.1:6001', 'rules.cache': 'true' } },
    { name: 'remote-2-co-cache', rules: 2, overrides: { 'rules.endpoints': '127.0.0.1:6001,127.0.0.1:6002', 'rules.cache': 'true' } },
  ]

  for (const scenario of scenarios) {
    const samples = []
    for (let attempt = 1; attempt <= REPEAT; attempt++) {
      for (let i = 0; i < scenario.rules; i++) await startRules(6001 + i)
      await startServer(scenario.overrides)

      const csv = path.join(out, `raw-${scenario.name}-lan${attempt}.csv`)
      await bots(['--play', '--games', String(games), '--tc', '120+0', '--maxPlies', '60',
        '--out', csv, '--label', `e7-${scenario.name}`])
      const summary = summarise(csv)
      await stopAll()

      if (summary) {
        samples.push(summary)
        console.log(`  ${scenario.name} lan ${attempt}: p50 ${summary.p50} / p95 ${summary.p95} ms`)
      }
    }
    if (!samples.length) continue
    rows.push([scenario.name, scenario.rules, medianOf(samples.map(s => s.p50)),
      medianOf(samples.map(s => s.p95)), medianOf(samples.map(s => s.p99)),
      samples.length].join(','))
  }

  // Giet rules service giua chung: van phai PAUSED roi chay tiep, khong mat van.
  console.log('  kich ban chiu loi: giet rules service giua luc dang danh')
  const first = await startRules(6001)
  await startServer({ 'rules.endpoints': '127.0.0.1:6001,127.0.0.1:6002' })
  const csv = path.join(out, 'raw-kill-rules.csv')
  const killer = (async () => {
    await sleep(4000)
    await stop(first)
    console.log('    da giet rules service #1')
    await sleep(3000)
    await startRules(6001)
    console.log('    da bat lai rules service #1')
  })()
  const text = await bots(['--play', '--games', String(QUICK ? 3 : 10), '--tc', '600+0',
    '--maxPlies', '40', '--out', csv, '--label', 'e7-kill'])
  await killer
  await stopAll()
  const finished = parse(text, 'Van ket thuc')
  const failed = parse(text, 'That bai')
  console.log(`    van ket thuc ${finished}, bot loi ${failed} (ky vong: khong mat van)`)
  rows.push(['giet-1-instance', 1, '-', '-', '-', finished].join(','))

  writeCsv(path.join(out, 'summary.csv'),
    'scenario,rules_instances,p50_ms,p95_ms,p99_ms,runs', rows)
  await plot(['--in', path.join(out, 'summary.csv'), '--x', 'scenario', '--y', 'p50_ms,p95_ms',
    '--kind', 'bar', '--title', 'E7 - do tre nuoc di theo cach phan xu luat',
    '--ylabel', 'ms', '--out', path.join(out, 'e7-latency.png')])
}

// ==================================================================== E8

async function e8() {
  console.log('\n=== E8 - TCP thuan vs WebSocket (khan gia) ===')
  const out = path.join(RESULTS, 'e8')
  await startRules(6001)
  await startRules(6002)
  await startServer({})

  const gateway = spawn(process.execPath, ['gateway.js', '--ws', '8080', '--tcp', '127.0.0.1:5555'],
    { cwd: path.join(SOURCE, 'web-spectator'), stdio: ['ignore', 'pipe', 'pipe'] })
  started.push(gateway)
  await waitForPort(8080)

  const result = await run(process.execPath,
    ['spectate.js', '--spectators', QUICK ? '10' : '50', '--out', path.join(out, 'e8.csv')],
    { cwd: path.join(SOURCE, 'bot') })
  await stopAll()

  process.stdout.write(result.out)
  if (result.code !== 0) console.log(result.err)
  if (fs.existsSync(path.join(out, 'e8.csv'))) {
    await plot(['--in', path.join(out, 'e8.csv'), '--x', 'transport',
      '--y', 'overhead_bytes_per_msg', '--kind', 'bar',
      '--title', 'E8 - overhead moi message: TCP thuan vs WebSocket',
      '--ylabel', 'byte', '--out', path.join(out, 'e8-overhead.png')])
  }
}

// ==================================================================== main

const experiments = { e1, e2, e3, e4, e5, e6, e7, e8 }

console.log('DCGS - chay thuc nghiem')
console.log(`  che do: ${QUICK ? 'QUICK (chi de thu duong chay)' : 'day du'}, lap ${REPEAT} lan`)
console.log(`  ket qua: ${path.relative(process.cwd(), RESULTS)}`)
if (REPEAT < 3 && !QUICK) {
  console.log('  !! Luu y: EXPERIMENTS.md yeu cau it nhat 3 lan lap cho so lieu bao cao.')
}

if (!fs.existsSync(SERVER_JAR)) {
  console.error(`\nKhong thay ${SERVER_JAR}. Chay "mvn -f source/pom.xml package" truoc.`)
  process.exit(1)
}

process.on('SIGINT', async () => {
  console.log('\nDang dung...')
  await stopAll()
  process.exit(130)
})

const startedAt = Date.now()
try {
  for (const [name, experiment] of Object.entries(experiments)) {
    if (!wants(name)) continue
    try {
      await experiment()
    } catch (failure) {
      console.error(`  !! ${name} that bai: ${failure.message}`)
      await stopAll()
    }
  }
} finally {
  await stopAll()
}
console.log(`\nXong sau ${Math.round((Date.now() - startedAt) / 1000)} giay.`)
