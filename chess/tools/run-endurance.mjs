/**
 * Cac bai kiem thu KEO DAI va CHIU LOI — tach khoi `run-experiments.mjs`.
 *
 * CODE CUA NHOM.
 *
 * Vi sao tach ra: mot bai chay 60 phut khong nen nam chung voi bo E1..E8 (~36
 * phut) — nguoi chay can chon duoc cai nao chay luc nao. Cac bai o day tra loi
 * nhung cau hoi khac han: khong phai "nhanh bao nhieu" ma "chay lau co hong
 * khong" va "chet mot manh thi phan con lai co song khong".
 *
 * Phu cac ca trong PLAN.md §8:
 *   M3   50 ban chay on dinh 10 phut
 *   T18  tat PostgreSQL 60 s giua luc dang co van chay
 *   T19  chay 60 phut, xem RAM co ro khong
 *   T20  ngat gateway khi khan gia dang xem
 *
 * Chay:
 *   node run-endurance.mjs --only m3          # 50 ban, 10 phut
 *   node run-endurance.mjs --only t18         # tat DB giua chung
 *   node run-endurance.mjs --only t19 --minutes 60
 *   node run-endurance.mjs --only t20
 *   node run-endurance.mjs                    # tat ca (rat lau)
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'

const HERE = import.meta.dirname
const CHESS = path.resolve(HERE, '..')
const SOURCE = path.join(CHESS, 'source')
const RESULTS = path.join(CHESS, 'statics', 'results', 'endurance')
const SERVER_JAR = path.join(SOURCE, 'server', 'target', 'dcgs-server.jar')
const SERVER_CONFIG = path.join(SOURCE, 'server', 'config.properties')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const ONLY = (argOf('only', '') || '').split(',').map(name => name.trim()).filter(Boolean)
const wants = name => !ONLY.length || ONLY.includes(name)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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

const portOpen = port => new Promise(resolve => {
  const socket = net.createConnection({ host: '127.0.0.1', port })
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => resolve(false))
})

const waitForPort = async (port, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true
    await sleep(300)
  }
  return false
}

/** Giet tien trinh dang giu mot cong — xem ghi chu o run-experiments.mjs. */
async function killListener(port) {
  if (process.platform !== 'win32') return
  const result = await run('netstat', ['-ano'])
  const pids = new Set()
  for (const line of result.out.split('\n')) {
    if (!line.includes('LISTENING') || !line.includes(`:${port} `)) continue
    const pid = line.trim().split(/\s+/).pop()
    if (pid && pid !== '0') pids.add(pid)
  }
  for (const pid of pids) await run('taskkill', ['/F', '/PID', pid])
}

const started = []

async function stop(child) {
  if (!child || child.exitCode !== null) return
  const ended = new Promise(resolve => child.once('close', resolve))
  child.kill()
  await Promise.race([ended, sleep(2000)])
  if (process.platform === 'win32') {
    await run('taskkill', ['/F', '/T', '/PID', String(child.pid)])
  }
  await Promise.race([ended, sleep(2000)])
}

async function stopAll() {
  for (const child of started.splice(0)) await stop(child)
  await killListener(5555)
  await killListener(8080)
}

async function startRules(port) {
  const child = spawn(process.execPath, ['index.js', '--port', String(port)],
    { cwd: path.join(SOURCE, 'rules-service'), stdio: ['ignore', 'pipe', 'pipe'] })
  started.push(child)
  if (!await waitForPort(port)) throw new Error(`rules service ${port} khong len`)
  return child
}

/**
 * Don sach truoc khi bat dau mot bai.
 *
 * Bat buoc, khong phai cho gon. Neu con mot server cu giu cong 5555 thi server
 * moi se bind that bai roi chet, trong khi `waitForPort` lai thay cong DANG mo
 * (cua server cu) va bao thanh cong. Ket qua: cong cu do gan tai nghe vao mot
 * tien trinh da chet, khong thu duoc dong `[stats]` nao, roi ket luan nham rang
 * "khong co ban nao dang chay". Bai T20 da bao sai dung vi ly do nay.
 */
async function freshStart() {
  await stopAll()
  for (const port of [5555, 6001, 6002, 8080]) {
    await killListener(port)
  }
  for (const port of [5555, 6001, 6002, 8080]) {
    if (await portOpen(port)) {
      throw new Error(`cong ${port} van co nguoi giu - khong do tiep de khoi do nham tien trinh`)
    }
  }
}

/**
 * Khoi dong server va THEO DOI dong `[stats]`.
 *
 * Khac `run-experiments.mjs` o cho giu lai TOAN BO chuoi mau chu khong chi dinh:
 * cau hoi cua T19 la "RAM co tang tuyen tinh khong", ma tra loi duoc cau do thi
 * phai co ca duong di, khong phai mot con so.
 */
async function startServer(overrides = {}) {
  const env = { ...process.env, SERVER_PORT: '5555', SERVER_STATSINTERVALMS: '5000' }
  for (const [key, value] of Object.entries(overrides)) {
    env[key.toUpperCase().replace(/\./g, '_')] = String(value)
  }
  const child = spawn('java', ['-jar', SERVER_JAR, '--config', SERVER_CONFIG],
    { cwd: path.join(SOURCE, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  started.push(child)

  child.samples = []
  child.errors = []

  // Phai GOM DONG truoc khi doc.
  //
  // stdout cua tien trinh con ve theo tung mau tuy y (do duoc: 26, 104, 324,
  // 57... byte), khong he trung voi ranh gioi dong. Mot dong `[stats]` dai ~110
  // ky tu gan nhu chac chan bi cat lam doi, va khi do KHONG nua nao khop regex —
  // cong cu do se im lang bao "khong co mau nao" trong khi server van in deu.
  // Dung cai bay ma protocol cua chinh do an nay sinh ra de giai quyet.
  let pending = ''
  child.stdout.on('data', chunk => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''        // phan cuoi co the la dong con do dang
    for (const line of lines) {
      const found = line.match(/\[stats\] threads=(\d+) heapMB=(\d+) games=(\d+) dbQueue=(\d+)/)
      if (found) {
        child.samples.push({
          at: Date.now(),
          threads: Number(found[1]),
          heapMb: Number(found[2]),
          games: Number(found[3]),
          dbQueue: Number(found[4]),
        })
      }
    }
  })
  child.stderr.on('data', chunk => {
    const line = String(chunk).trim()
    if (line) child.errors.push(line.slice(0, 200))
  })
  if (!await waitForPort(5555)) throw new Error('game server khong len')
  return child
}

const bots = (args, options = {}) => spawn(process.execPath, ['bot.js', ...args],
  { cwd: path.join(SOURCE, 'bot'), stdio: ['ignore', 'pipe', 'pipe'], ...options })

const collect = child => new Promise(resolve => {
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.on('close', () => resolve(out))
})

const parse = (text, label) => {
  const line = text.split('\n').find(row => row.startsWith(label))
  return line ? line.split(':').slice(1).join(':').trim() : ''
}

const save = (name, content) => {
  fs.mkdirSync(RESULTS, { recursive: true })
  const file = path.join(RESULTS, name)
  fs.writeFileSync(file, content)
  console.log(`  -> ${path.relative(CHESS, file)}`)
}

/**
 * RAM co ro khong?
 *
 * Ro bo nho hien ra thanh mot duong di len khong quay lai. Cach kiem: chia
 * chuoi mau lam hai nua, so trung vi. GC lam duong heap rang cua nen so hai
 * gia tri bat ky se ra ket luan lung tung; trung vi cua nua dau va nua sau thi
 * on dinh hon nhieu.
 */
function leakVerdict(samples) {
  if (samples.length < 6) return { verdict: 'khong du mau', firstHalf: null, secondHalf: null }
  const heaps = samples.map(one => one.heapMb)
  const middle = Math.floor(heaps.length / 2)
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  const firstHalf = median(heaps.slice(0, middle))
  const secondHalf = median(heaps.slice(middle))
  const growth = firstHalf ? (secondHalf - firstHalf) / firstHalf : 0
  return {
    firstHalf,
    secondHalf,
    peak: Math.max(...heaps),
    growthPercent: +(growth * 100).toFixed(1),
    // Nguong 50 %: heap dao dong theo GC nen mot chenh lech nho la binh thuong.
    // Ro that thi nua sau cao hon han va khong bao gio tut lai.
    verdict: growth > 0.5 ? 'NGHI RO BO NHO' : 'khong thay dau hieu ro',
  }
}

const csvOf = samples => 'elapsed_s,threads,heap_mb,games,db_queue\n'
  + samples.map((one, index) => [
    Math.round((one.at - samples[0].at) / 1000),
    one.threads, one.heapMb, one.games, one.dbQueue,
  ].join(',')).join('\n') + '\n'

// ==================================================================== M3

/** 50 ban chay lien tuc 10 phut — moc M3 cua PLAN.md. */
async function m3() {
  const minutes = Number(argOf('minutes', 10))
  console.log(`\n=== M3 — 50 ban chay lien tuc ${minutes} phut ===`)

  await freshStart()
  await startRules(6001)
  await startRules(6002)
  const server = await startServer()

  // `--loop`: danh xong van thi vao van moi ngay. Khong co no thi tai tu can
  // dan khi cac van ngau nhien lan luot ket thuc — do duoc: 50 ban tut con 3.
  const child = bots(['--play', '--games', '50', '--tc', '1800+0',
    '--maxPlies', '120', '--think', '400', '--ramp', '5000',
    '--loop', '--duration', String(minutes * 60 + 30)])
  started.push(child)

  const deadline = Date.now() + minutes * 60_000
  let lastReport = 0
  while (Date.now() < deadline && child.exitCode === null) {
    await sleep(5000)
    const elapsed = Math.round((Date.now() - (deadline - minutes * 60_000)) / 1000)
    if (elapsed - lastReport >= 60) {
      lastReport = elapsed
      const latest = server.samples[server.samples.length - 1]
      console.log(`  phut ${Math.round(elapsed / 60)}: ${latest
        ? `${latest.games} ban, ${latest.threads} thread, ${latest.heapMb} MB heap, dbQueue ${latest.dbQueue}`
        : 'chua co mau'}`)
    }
  }

  const stillPlaying = server.samples[server.samples.length - 1]?.games ?? 0
  const leak = leakVerdict(server.samples)
  const crashed = child.exitCode !== null && child.exitCode !== 0
  await stopAll()

  console.log(`  Ban con dang chay sau ${minutes} phut : ${stillPlaying}`)
  console.log(`  Heap nua dau / nua sau          : ${leak.firstHalf} / ${leak.secondHalf} MB`
    + ` (dinh ${leak.peak} MB) -> ${leak.verdict}`)
  console.log(`  Bot thoat som                    : ${crashed ? 'CO' : 'khong'}`)
  console.log(`  Loi tren stderr cua server       : ${server.errors.length}`)
  save(`m3-${minutes}phut.csv`, csvOf(server.samples))
  return { stillPlaying, leak, errors: server.errors.length }
}

// =================================================================== T18

/**
 * T18 — tat PostgreSQL 60 s giua luc dang co van chay.
 *
 * Ky vong: van VAN chay tren RAM, nuoc di khong mat. Hang doi ghi day thi
 * do ra `pending-moves.log` chu khong drop (X45). Bat lai DB thi ghi tiep.
 */
async function t18() {
  console.log('\n=== T18 — tat PostgreSQL 60 s giua luc 20 van dang chay ===')

  const service = argOf('pgservice', 'postgresql-x64-18')
  const pending = path.join(SOURCE, 'server', 'pending-moves.log')
  if (fs.existsSync(pending)) fs.rmSync(pending)

  await freshStart()
  await startRules(6001)
  await startRules(6002)
  const server = await startServer()

  const child = bots(['--play', '--games', '20', '--tc', '600+0',
    '--maxPlies', '120', '--think', '300', '--loop', '--duration', '180'])
  started.push(child)
  const output = collect(child)

  await sleep(15_000)
  console.log('  dang tat PostgreSQL...')
  const stopped = await run('net', ['stop', service])
  if (stopped.code !== 0) {
    console.log(`  !! khong tat duoc dich vu "${service}" (can quyen Administrator).`);
    console.log('     Bo qua T18. Chay lai bang dong lenh co quyen admin,')
    console.log('     hoac chi dinh ten dich vu bang --pgservice <ten>.')
    await stopAll()
    return { skipped: true }
  }

  console.log('  PostgreSQL da tat, cho 60 s...')
  await sleep(60_000)
  const duringOutage = server.samples[server.samples.length - 1]
  console.log(`  trong luc mat DB: ${duringOutage?.games ?? '?'} ban van dang chay,`
    + ` dbQueue ${duringOutage?.dbQueue ?? '?'}`)

  console.log('  dang bat lai PostgreSQL...')
  await run('net', ['start', service])
  await sleep(20_000)

  const text = await Promise.race([output, sleep(120_000).then(() => '')])
  const finished = parse(text, 'Van ket thuc')
  const lost = parse(text, 'Nuoc di bi mat')
  const spilled = fs.existsSync(pending) ? fs.readFileSync(pending, 'utf8').trim().split('\n').length : 0
  await stopAll()

  console.log(`  Van ket thuc            : ${finished || '(bot chua xong)'}`)
  console.log(`  Nuoc di bi mat          : ${lost || 'n/a'}`)
  console.log(`  Dong ghi ra pending-moves.log: ${spilled}`)
  console.log(`  Loi tren stderr         : ${server.errors.length}`);
  save('t18-stats.csv', csvOf(server.samples))
  return { finished, lost, spilled }
}

// =================================================================== T19

/** T19 — chay dai, xem RAM co ro khong. */
async function t19() {
  const minutes = Number(argOf('minutes', 60))
  console.log(`\n=== T19 — chay ${minutes} phut voi 50 ban, kiem ro bo nho ===`)
  const result = await m3WithLabel(minutes, "t19")
  return result
}

async function m3WithLabel(minutes, label) {
  await freshStart()
  await startRules(6001)
  await startRules(6002)
  const server = await startServer()

  const child = bots(['--play', '--games', '50', '--tc', '7200+0',
    '--maxPlies', '120', '--think', '400', '--ramp', '5000',
    '--loop', '--duration', String(minutes * 60 + 30)])
  started.push(child)

  const startedAt = Date.now()
  let lastReport = 0
  while (Date.now() - startedAt < minutes * 60_000) {
    await sleep(10_000)
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    if (elapsed - lastReport >= 300) {
      lastReport = elapsed
      const latest = server.samples[server.samples.length - 1]
      console.log(`  phut ${Math.round(elapsed / 60)}: ${latest
        ? `${latest.games} ban, ${latest.heapMb} MB heap, ${latest.threads} thread`
        : 'chua co mau'}`)
    }
  }

  const leak = leakVerdict(server.samples)
  const errors = server.errors.length
  await stopAll()

  console.log(`  Heap nua dau / nua sau : ${leak.firstHalf} / ${leak.secondHalf} MB`
    + ` (tang ${leak.growthPercent} %, dinh ${leak.peak} MB)`)
  console.log(`  Ket luan               : ${leak.verdict}`)
  console.log(`  Loi tren stderr        : ${errors}`)
  save(`${label}-${minutes}phut.csv`, csvOf(server.samples))
  return { leak, errors }
}

// =================================================================== T20

/**
 * T20 — ngat gateway khi khan gia dang xem.
 *
 * Ky vong: chi nguoi XEM bi anh huong; nguoi choi qua TCP thuan va van dau
 * khong he hay biet (X60). Day la bang chung co lap loi theo bien.
 */
async function t20() {
  console.log('\n=== T20 — ngat gateway khi khan gia dang xem ===')

  await freshStart()
  await startRules(6001)
  await startRules(6002)
  const server = await startServer()

  const gateway = spawn(process.execPath, ['gateway.js', '--ws', '8080', '--tcp', '127.0.0.1:5555'],
    { cwd: path.join(SOURCE, 'web-spectator'), stdio: ['ignore', 'pipe', 'pipe'] })
  started.push(gateway)
  if (!await waitForPort(8080)) throw new Error('gateway khong len')

  const child = spawn(process.execPath,
    ['spectate.js', '--spectators', '20', '--duration', '45'],
    { cwd: path.join(SOURCE, 'bot'), stdio: ['ignore', 'pipe', 'pipe'] })
  started.push(child)
  const output = collect(child)

  // Cho khan gia vao xem roi moi giet gateway.
  await sleep(20_000)
  const beforeKill = server.samples[server.samples.length - 1]
  console.log(`  truoc khi giet gateway: ${beforeKill?.games ?? '?'} ban dang chay`)

  console.log('  dang giet gateway...')
  await stop(gateway)
  await sleep(15_000)
  const afterKill = server.samples[server.samples.length - 1]
  console.log(`  sau khi giet gateway  : ${afterKill?.games ?? '?'} ban dang chay`)

  const text = await Promise.race([output, sleep(60_000).then(() => '')])
  await stopAll()

  const survived = (afterKill?.games ?? 0) >= 1
  console.log(`  Van co song qua viec gateway chet? ${survived ? 'CO' : 'KHONG'}`)
  console.log(`  Loi tren stderr cua server        : ${server.errors.length}`)
  save('t20-stats.csv', csvOf(server.samples))
  if (text) save('t20-spectate.txt', text)
  return { survived, errors: server.errors.length }
}

// ==================================================================== main

const suites = { m3, t18, t19, t20 }

console.log('DCGS — kiem thu keo dai va chiu loi')
if (!fs.existsSync(SERVER_JAR)) {
  console.error(`Khong thay ${SERVER_JAR}. Chay "mvn -f source/pom.xml package" truoc.`)
  process.exit(1)
}

process.on('SIGINT', async () => {
  console.log('\nDang dung...')
  await stopAll()
  process.exit(130)
})

const startedAt = Date.now()
try {
  for (const [name, suite] of Object.entries(suites)) {
    if (!wants(name)) continue
    try {
      await suite()
    } catch (failure) {
      console.error(`  !! ${name} that bai: ${failure.message}`)
      await stopAll()
    }
  }
} finally {
  await stopAll()
}
console.log(`\nXong sau ${Math.round((Date.now() - startedAt) / 60_000)} phut.`)
