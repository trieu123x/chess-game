/**
 * CSV -> bieu do SVG + PNG.
 *
 * CODE CUA NHOM. Khong dung thu vien ve nao: SVG duoc sinh bang chuoi, PNG
 * duoc render bang Chromium co san trong `source/web-client/node_modules`
 * (Playwright da duoc cai cho phan kiem thu web client).
 *
 * Vi sao tu ve thay vi dung mot thu vien chart: bao cao chi can bon loai hinh,
 * va tu sinh thi hinh nao cung dung mot bang mau, mot co chu, mot kich thuoc —
 * quan trong hon la khong phai them dependency chi de ve bon cai bieu do.
 *
 * Chay:
 *   node plot.js --in ../statics/results/e1/summary.csv --x games --y p95_ms \
 *                --title "E1 - do tre theo so ban" --out ../statics/results/e1/e1-p95.png
 *
 *   node plot.js --in .../summary.csv --x games --y p50_ms,p95_ms,p99_ms --kind line
 *   node plot.js --in .../e3.csv      --x scenario --y bytes_per_move --kind bar
 *
 * Tham so:
 *   --in     file CSV (dong dau la ten cot)
 *   --x      ten cot dung lam truc hoanh
 *   --y      mot hoac nhieu cot (ngan cach bang dau phay) dung lam truc tung
 *   --kind   line | bar        (mac dinh: line neu x la so, bar neu x la chu)
 *   --title  tieu de hinh
 *   --ylabel nhan truc tung
 *   --out    duong dan .png (file .svg cung ten cung duoc ghi ra)
 *   --group  ten cot de tach thanh nhieu duong (vi du: io, format)
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const IN = argOf('in', null)
const X = argOf('x', null)
const Y = (argOf('y', '') || '').split(',').filter(Boolean)
const GROUP = argOf('group', null)
const TITLE = argOf('title', '')
const YLABEL = argOf('ylabel', '')
const OUT = argOf('out', null)

if (!IN || !X || !Y.length || !OUT) {
  console.error('Thieu tham so. Xem phan chu thich dau file de biet cach dung.')
  process.exit(2)
}

// ---------------------------------------------------------------- doc CSV

/** Doc CSV don gian: khong co dau phay trong o, du cho cac file cua nhom. */
function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim())
  const header = lines[0].split(',').map(name => name.trim())
  return lines.slice(1).map(line => {
    const cells = line.split(',')
    const row = {}
    header.forEach((name, index) => { row[name] = (cells[index] ?? '').trim() })
    return row
  })
}

const rows = readCsv(IN)
if (!rows.length) {
  console.error(`${IN} khong co dong du lieu nao`)
  process.exit(1)
}

const isNumeric = value => value !== '' && Number.isFinite(Number(value))
const xIsNumeric = rows.every(row => isNumeric(row[X]))
const KIND = argOf('kind', xIsNumeric ? 'line' : 'bar')

// Tach thanh cac chuoi: moi (cot y) x (gia tri group) la mot chuoi.
const groups = GROUP ? [...new Set(rows.map(row => row[GROUP]))] : [null]
const series = []
for (const column of Y) {
  for (const group of groups) {
    const points = rows
      .filter(row => group === null || row[GROUP] === group)
      .filter(row => isNumeric(row[column]))
      .map(row => ({ x: xIsNumeric ? Number(row[X]) : row[X], y: Number(row[column]) }))
    if (points.length) {
      series.push({ name: group === null ? column : `${column} (${group})`, points })
    }
  }
}
if (!series.length) {
  console.error(`Khong co so lieu cho cot ${Y.join(', ')}`)
  process.exit(1)
}

// ------------------------------------------------------------------ ve

const W = 900;
const H = 520;
const PAD = { top: 64, right: 28, bottom: 70, left: 78 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom

// Bang mau: phan biet duoc ca khi in den trang, va du tuong phan tren nen sang.
const COLORS = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2']

const xLabels = xIsNumeric
  ? [...new Set(series.flatMap(s => s.points.map(p => p.x)))].sort((a, b) => a - b)
  : [...new Set(series.flatMap(s => s.points.map(p => p.x)))]

const allY = series.flatMap(s => s.points.map(p => p.y))
const yMax = niceCeil(Math.max(...allY, 0))
const yMin = 0

/** Lam tron tran truc tung len mot con so "dep" de vach chia de doc. */
function niceCeil(value) {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (value <= step * magnitude) return step * magnitude
  }
  return 10 * magnitude
}

const yToPixel = value => PAD.top + PLOT_H - (value - yMin) / (yMax - yMin) * PLOT_H
const xToPixel = value => {
  if (xIsNumeric && KIND === 'line') {
    const min = Math.min(...xLabels)
    const max = Math.max(...xLabels)
    return max === min ? PAD.left + PLOT_W / 2
      : PAD.left + (value - min) / (max - min) * PLOT_W
  }
  const index = xLabels.indexOf(value)
  return PAD.left + (index + 0.5) * (PLOT_W / xLabels.length)
}

const escape = text => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const parts = []
parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`)
if (TITLE) {
  parts.push(`<text x="${W / 2}" y="34" text-anchor="middle" font-size="19" `
    + `font-weight="600" fill="#111827">${escape(TITLE)}</text>`)
}

// Vach chia ngang + nhan truc tung
const TICKS = 5
for (let i = 0; i <= TICKS; i++) {
  const value = yMin + (yMax - yMin) * i / TICKS
  const y = yToPixel(value)
  parts.push(`<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + PLOT_W}" y2="${y}" `
    + `stroke="#e5e7eb" stroke-width="1"/>`)
  parts.push(`<text x="${PAD.left - 10}" y="${y + 4}" text-anchor="end" font-size="12.5" `
    + `fill="#6b7280">${value >= 100 ? Math.round(value) : Number(value.toFixed(2))}</text>`)
}

// Truc
parts.push(`<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + PLOT_H}" `
  + `stroke="#9ca3af" stroke-width="1.5"/>`)
parts.push(`<line x1="${PAD.left}" y1="${PAD.top + PLOT_H}" x2="${PAD.left + PLOT_W}" `
  + `y2="${PAD.top + PLOT_H}" stroke="#9ca3af" stroke-width="1.5"/>`)

// Nhan truc hoanh
for (const label of xLabels) {
  parts.push(`<text x="${xToPixel(label)}" y="${PAD.top + PLOT_H + 22}" text-anchor="middle" `
    + `font-size="12.5" fill="#374151">${escape(label)}</text>`)
}
parts.push(`<text x="${PAD.left + PLOT_W / 2}" y="${H - 16}" text-anchor="middle" `
  + `font-size="13.5" fill="#4b5563">${escape(X)}</text>`)
if (YLABEL) {
  parts.push(`<text transform="translate(20 ${PAD.top + PLOT_H / 2}) rotate(-90)" `
    + `text-anchor="middle" font-size="13.5" fill="#4b5563">${escape(YLABEL)}</text>`)
}

if (KIND === 'bar') {
  const slot = PLOT_W / xLabels.length
  const barWidth = Math.min(58, slot * 0.7 / series.length)
  series.forEach((one, seriesIndex) => {
    for (const point of one.points) {
      const center = xToPixel(point.x)
      const x = center - (series.length * barWidth) / 2 + seriesIndex * barWidth
      const y = yToPixel(point.y)
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" `
        + `height="${(PAD.top + PLOT_H - y).toFixed(1)}" fill="${COLORS[seriesIndex % COLORS.length]}"/>`)
      parts.push(`<text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" `
        + `text-anchor="middle" font-size="11.5" fill="#374151">`
        + `${point.y >= 100 ? Math.round(point.y) : Number(point.y.toFixed(2))}</text>`)
    }
  })
} else {
  series.forEach((one, seriesIndex) => {
    const sorted = [...one.points].sort((a, b) => (a.x > b.x ? 1 : -1))
    const d = sorted.map((point, index) =>
      `${index === 0 ? 'M' : 'L'}${xToPixel(point.x).toFixed(1)},${yToPixel(point.y).toFixed(1)}`).join(' ')
    parts.push(`<path d="${d}" fill="none" stroke="${COLORS[seriesIndex % COLORS.length]}" `
      + `stroke-width="2.5" stroke-linejoin="round"/>`)
    for (const point of sorted) {
      parts.push(`<circle cx="${xToPixel(point.x).toFixed(1)}" cy="${yToPixel(point.y).toFixed(1)}" `
        + `r="4" fill="${COLORS[seriesIndex % COLORS.length]}"/>`)
    }
  })
}

// Chu thich
if (series.length > 1 || GROUP) {
  series.forEach((one, index) => {
    const x = PAD.left + index * 190
    const y = PAD.top - 20
    parts.push(`<rect x="${x}" y="${y - 9}" width="13" height="13" rx="2" `
      + `fill="${COLORS[index % COLORS.length]}"/>`)
    parts.push(`<text x="${x + 19}" y="${y + 2}" font-size="12.5" fill="#374151">`
      + `${escape(one.name)}</text>`)
  })
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" `
  + `viewBox="0 0 ${W} ${H}" font-family="Segoe UI, system-ui, sans-serif">\n`
  + parts.join('\n') + '\n</svg>\n'

fs.mkdirSync(path.dirname(OUT), { recursive: true })
const svgPath = OUT.replace(/\.png$/, '') + '.svg'
fs.writeFileSync(svgPath, svg)
console.log(`Da ghi ${svgPath}`)

// ------------------------------------------------------------ SVG -> PNG

/**
 * Render bang Chromium cua Playwright neu co.
 *
 * Khong co thi van giu file SVG — SVG chen truc tiep vao Word duoc, nen thieu
 * PNG khong chan duoc viec lam bao cao.
 */
const playwrightPath = path.resolve(
  import.meta.dirname, '../source/web-client/node_modules/playwright/index.mjs')

if (!OUT.endsWith('.png')) {
  process.exit(0)
}
if (!fs.existsSync(playwrightPath)) {
  console.log('Khong thay Playwright, bo qua buoc xuat PNG (file SVG van dung duoc).')
  process.exit(0)
}

const { chromium } = await import(pathToFileURL(playwrightPath).href)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
await page.setContent(`<body style="margin:0">${svg}</body>`)
await page.screenshot({ path: OUT })
await browser.close()
console.log(`Da ghi ${OUT}`)
