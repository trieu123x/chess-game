/**
 * Sinh `statics/protocol.png` va `statics/architecture.png`.
 *
 * CODE CUA NHOM. Hinh duoc viet thang bang SVG roi render ra PNG bang Chromium
 * cua Playwright (giong `plot.js`).
 *
 * Vi sao khong ve tay bang cong cu do hoa: hinh trong bao cao phai khop voi
 * `PROTOCOL.md` va `ARCHITECTURE.md`. Khi doi protocol ma hinh ve tay thi se
 * quen sua; hinh sinh tu file nay thi chi can chay lai mot lenh. Cac con so
 * trong hinh (do dai truong, ma TYPE) duoc viet o mot cho duy nhat ben duoi.
 *
 * Chay:  node diagrams.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = import.meta.dirname
const STATICS = path.resolve(HERE, '..', 'statics')

const C = {
  ink: '#111827', muted: '#6b7280', line: '#9ca3af', soft: '#e5e7eb',
  blue: '#2563eb', blueFill: '#dbeafe',
  green: '#059669', greenFill: '#d1fae5',
  amber: '#d97706', amberFill: '#fef3c7',
  purple: '#7c3aed', purpleFill: '#ede9fe',
  red: '#dc2626', redFill: '#fee2e2',
  slate: '#475569', slateFill: '#f1f5f9',
}

const esc = text => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const text = (x, y, value, options = {}) => {
  const { size = 13, fill = C.ink, anchor = 'start', weight = 400, family = '', style = '' } = options
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" `
    + `font-weight="${weight}"${family ? ` font-family="${family}"` : ''}`
    + `${style ? ` font-style="${style}"` : ''}>${esc(value)}</text>`
}

const mono = 'ui-monospace, Consolas, monospace'

const box = (x, y, w, h, label, options = {}) => {
  const { fill = '#ffffff', stroke = C.line, sub = '', size = 14, radius = 8 } = options
  const parts = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" `
    + `fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>`]
  if (sub) {
    parts.push(text(x + w / 2, y + h / 2 - 3, label, { anchor: 'middle', size, weight: 600 }))
    parts.push(text(x + w / 2, y + h / 2 + 15, sub, { anchor: 'middle', size: 11.5, fill: C.muted }))
  } else {
    parts.push(text(x + w / 2, y + h / 2 + 5, label, { anchor: 'middle', size, weight: 600 }))
  }
  return parts.join('\n')
}

const ARROW_DEFS = `<defs>
  <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="${C.slate}"/>
  </marker>
  <marker id="ab" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="${C.blue}"/>
  </marker>
</defs>`

const arrow = (x1, y1, x2, y2, options = {}) => {
  const { color = C.slate, dash = '', marker = 'a', width = 1.6 } = options
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" `
    + `stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#${marker})"/>`
}

const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" `
  + `font-family="Segoe UI, system-ui, sans-serif">\n`
  + `<rect width="${w}" height="${h}" fill="#ffffff"/>\n${ARROW_DEFS}\n${body}\n</svg>\n`

// ============================================================== protocol.png

/**
 * Khung CGP — cac con so nay phai khop PROTOCOL.md §A1.
 * Doi o day thi doi ca hinh, nen khong co chuyen hinh va dac ta lech nhau.
 */
const FRAME_FIELDS = [
  { name: 'LEN', bits: 'u32', note: '= 5 + len(PAYLOAD)', width: 150, fill: C.blueFill, stroke: C.blue },
  { name: 'TYPE', bits: 'u8', note: 'bang A2', width: 95, fill: C.greenFill, stroke: C.green },
  { name: 'SEQ', bits: 'u32', note: 'so thu tu', width: 130, fill: C.amberFill, stroke: C.amber },
  { name: 'PAYLOAD', bits: 'LEN - 5 byte', note: 'JSON hoac nhi phan', width: 325, fill: C.slateFill, stroke: C.slate },
]

const MOVE_FIELDS = [
  { name: 'from', bits: 'u8', width: 84 },
  { name: 'to', bits: 'u8', width: 84 },
  { name: 'promo', bits: 'u8', width: 84 },
  { name: 'flags', bits: 'u8', width: 84 },
  { name: 'ply', bits: 'u16', width: 96 },
  { name: 'reserved', bits: 'u16', width: 96 },
]

const APPLIED_FIELDS = [
  { name: 'ply', bits: 'u16', width: 74 },
  { name: 'from', bits: 'u8', width: 62 },
  { name: 'to', bits: 'u8', width: 62 },
  { name: 'promo', bits: 'u8', width: 62 },
  { name: 'flags', bits: 'u8', width: 62 },
  { name: 'clockW', bits: 'u32 ms', width: 92 },
  { name: 'clockB', bits: 'u32 ms', width: 92 },
  { name: 'tsOff', bits: 'u16', width: 74 },
]

/** Ve mot day o lien nhau bieu dien bo cuc byte. */
function fieldRow(x, y, height, fields, defaults = {}) {
  const parts = []
  let cursor = x
  for (const field of fields) {
    const fill = field.fill ?? defaults.fill ?? '#ffffff'
    const stroke = field.stroke ?? defaults.stroke ?? C.line
    parts.push(`<rect x="${cursor}" y="${y}" width="${field.width}" height="${height}" `
      + `fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`)
    parts.push(text(cursor + field.width / 2, y + 24, field.name,
      { anchor: 'middle', size: 13.5, weight: 600, family: mono }))
    parts.push(text(cursor + field.width / 2, y + 43, field.bits,
      { anchor: 'middle', size: 11.5, fill: C.muted, family: mono }))
    if (field.note) {
      parts.push(text(cursor + field.width / 2, y + height + 17, field.note,
        { anchor: 'middle', size: 11, fill: C.muted }))
    }
    cursor += field.width
  }
  return { svg: parts.join('\n'), end: cursor }
}

/** Mot muc trong so do tuan tu: mui ten giua hai cot doc. */
function message(leftX, rightX, y, label, options = {}) {
  const { direction = 'right', color = C.slate, note = '' } = options
  const from = direction === 'right' ? leftX : rightX
  const to = direction === 'right' ? rightX : leftX
  const parts = [arrow(from, y, to, y, { color, marker: color === C.blue ? 'ab' : 'a' })]
  parts.push(text((leftX + rightX) / 2, y - 8, label,
    { anchor: 'middle', size: 12.5, weight: 600, fill: color, family: mono }))
  if (note) {
    parts.push(text((leftX + rightX) / 2, y + 16, note, { anchor: 'middle', size: 11, fill: C.muted }))
  }
  return parts.join('\n')
}

function protocolDiagram() {
  const W = 1180;
  const H = 1030
  const parts = []

  parts.push(text(W / 2, 40, 'CGP v1.2 — Chess Game Protocol', { anchor: 'middle', size: 23, weight: 700 }))
  parts.push(text(W / 2, 63, 'Giao thuc nhi phan tu thiet ke, client <-> server, tren TCP',
    { anchor: 'middle', size: 13.5, fill: C.muted }))

  // --- 1. Khung
  parts.push(text(60, 110, '1. Khung truyen — tu dong khung vi TCP la dong byte khong co ranh gioi message',
    { size: 15, weight: 600 }))
  const frame = fieldRow(60, 128, 58, FRAME_FIELDS)
  parts.push(frame.svg)
  parts.push(text(60, 222, 'Big-endian. LEN khong tinh 4 byte cua chinh no. LEN > 65536 -> ERROR 2003 va dong ket noi.',
    { size: 12, fill: C.muted }))
  parts.push(text(60, 240, 'Bo giai ma phai xu ly duoc nua frame (half-packet) va nhieu frame dinh lien trong mot lan doc.',
    { size: 12, fill: C.muted }))

  // --- 2. Hai message nhi phan cua duong nong
  parts.push(text(60, 288, '2. Duong nong dung nhi phan — khong gui FEN, client tu ap nuoc di (delta encoding)',
    { size: 15, weight: 600 }))

  parts.push(text(60, 316, 'MOVE (0x06) — client gui len, 8 byte', { size: 13, weight: 600, family: mono }))
  const move = fieldRow(60, 326, 50, MOVE_FIELDS, { fill: C.blueFill, stroke: C.blue })
  parts.push(move.svg)
  parts.push(text(move.end + 16, 356, 'o co: 0..63, a1 = 0', { size: 11.5, fill: C.muted }))
  parts.push(text(move.end + 16, 373, 'promo: 0=khong 1=N 2=B 3=R 4=Q', { size: 11.5, fill: C.muted }))

  parts.push(text(60, 418, 'MOVE_APPLIED (0x83) — server tra ve, 16 byte', { size: 13, weight: 600, family: mono }))
  const applied = fieldRow(60, 428, 50, APPLIED_FIELDS, { fill: C.greenFill, stroke: C.green })
  parts.push(applied.svg)
  parts.push(text(60, 512, 'flags: bit0 an quan · bit1 nhap thanh · bit2 bat tot qua duong · bit3 phong cap · bit4 chieu · bit5 chieu het · bit6 hoa',
    { size: 11.5, fill: C.muted }))
  parts.push(text(60, 530, 'Ca hai dong ho di kem moi nuoc: server la nguon chan ly duy nhat ve thoi gian.',
    { size: 11.5, fill: C.muted }))

  // --- 3. So do tuan tu
  parts.push(text(60, 582, '3. Mot van dau, tu dang nhap den ket thuc', { size: 15, weight: 600 }))

  const leftX = 250;
  const rightX = 760;
  const rulesX = 1010
  const top = 606;
  const bottom = 985

  for (const [x, label, sub] of [
    [leftX, 'Client', 'Java / Node / trinh duyet'],
    [rightX, 'Game Server', 'Java, co state'],
    [rulesX, 'Rules Service', 'Node, stateless'],
  ]) {
    parts.push(box(x - 92, top, 184, 44, label, { sub: '', fill: C.slateFill, stroke: C.slate, size: 13.5 }))
    parts.push(text(x, top + 60, sub, { anchor: 'middle', size: 10.5, fill: C.muted }))
    parts.push(`<line x1="${x}" y1="${top + 68}" x2="${x}" y2="${bottom}" stroke="${C.soft}" `
      + `stroke-width="2" stroke-dasharray="4 4"/>`)
  }

  let y = top + 96
  const step = 34
  parts.push(message(leftX, rightX, y, 'LOGIN  {username, password}', { color: C.blue }))
  y += step
  parts.push(message(leftX, rightX, y, 'LOGIN_OK  {sessionToken, elo}', { direction: 'left' }))
  y += step
  parts.push(message(leftX, rightX, y, 'QUEUE_JOIN  {timeControl}', { color: C.blue }))
  y += step
  parts.push(message(leftX, rightX, y, 'MATCH_FOUND + GAME_SNAPSHOT', { direction: 'left' }))
  y += step + 8

  parts.push(message(leftX, rightX, y, 'MOVE  (8 byte)', { color: C.blue, note: 't_recv duoc ghi o day (X25)' }))
  parts.push(message(rightX, rulesX, y, 'VALIDATE', {}))
  y += step + 10
  parts.push(message(rightX, rulesX, y, 'RULES_OK {fen, san, flags}', { direction: 'left' }))
  y += step - 4
  parts.push(message(leftX, rightX, y, 'MOVE_APPLIED  (16 byte)', { direction: 'left',
    note: 'tru gio = (t_recv - t_gui_state) - min(rtt/2, 200 ms)' }))
  y += step + 14
  parts.push(text((leftX + rightX) / 2, y, '... lap lai cho tung nuoc ...',
    { anchor: 'middle', size: 12, fill: C.muted, style: 'italic' }))
  y += 26
  parts.push(message(leftX, rightX, y, 'GAME_OVER  {result, reason, pgn}', { direction: 'left', color: C.green }))

  // Chu thich RTT
  parts.push(`<rect x="60" y="${top + 96}" width="150" height="70" rx="7" fill="${C.amberFill}" `
    + `stroke="${C.amber}" stroke-width="1.3"/>`)
  parts.push(text(135, top + 118, 'HEARTBEAT', { anchor: 'middle', size: 12, weight: 600, family: mono }))
  parts.push(text(135, top + 136, 'hai chieu, 5 s', { anchor: 'middle', size: 11, fill: C.muted }))
  parts.push(text(135, top + 154, 'server TU DO rtt', { anchor: 'middle', size: 11, fill: C.muted }))

  return svg(W, H, parts.join('\n'))
}

// ========================================================== architecture.png

function architectureDiagram() {
  const W = 1180;
  const H = 780
  const parts = []

  parts.push(text(W / 2, 40, 'DCGS — Kien truc he thong', { anchor: 'middle', size: 23, weight: 700 }))
  parts.push(text(W / 2, 63, 'Ba tien trinh, hai giao thuc nhi phan tu thiet ke, mot nguon chan ly duy nhat',
    { anchor: 'middle', size: 13.5, fill: C.muted }))

  // --- Client
  // Thu tu co chu dich: hai client TRINH DUYET o tren (phai di qua gateway vi
  // trinh duyet khong mo duoc socket TCP), hai client TCP THUAN o duoi.
  parts.push(text(60, 112, 'Client', { size: 14, weight: 600, fill: C.muted }))
  parts.push(box(60, 126, 176, 62, 'Web Client', { sub: 'React + TS', fill: C.blueFill, stroke: C.blue }))
  parts.push(box(60, 200, 176, 62, 'Khan gia', { sub: 'trang web', fill: C.blueFill, stroke: C.blue }))
  parts.push(box(60, 296, 176, 62, 'Java CLI Client', { sub: 'TCP thuan', fill: C.blueFill, stroke: C.blue }))
  parts.push(box(60, 386, 176, 62, 'Bot sinh tai', { sub: 'Node, do E1..E5', fill: C.blueFill, stroke: C.blue }))

  // --- Gateway
  parts.push(box(300, 132, 150, 124, 'Web Gateway', { sub: 'WS <-> TCP', fill: C.purpleFill, stroke: C.purple }))
  parts.push(text(375, 272, 'mang nguyen frame CGP', { anchor: 'middle', size: 10.5, fill: C.muted }))
  parts.push(text(375, 288, 'khong giu state (X60)', { anchor: 'middle', size: 10.5, fill: C.muted }))

  // --- Delay proxy
  parts.push(box(300, 388, 150, 58, 'Delay proxy', { sub: 'bom tre, E4', fill: C.amberFill, stroke: C.amber }))

  // --- Server
  const sx = 520;
  const sw = 380
  parts.push(`<rect x="${sx}" y="112" width="${sw}" height="410" rx="12" fill="#fbfdff" `
    + `stroke="${C.blue}" stroke-width="2"/>`)
  parts.push(text(sx + sw / 2, 138, 'GAME SERVER (Java 17)', { anchor: 'middle', size: 15, weight: 700, fill: C.blue }))

  parts.push(box(sx + 22, 154, sw - 44, 94, 'Network Layer', {
    sub: 'Acceptor · Selector · FrameCodec', fill: '#ffffff', stroke: C.line }))
  parts.push(text(sx + sw / 2, 232, 'ConnectionManager · Heartbeat · Backpressure',
    { anchor: 'middle', size: 10.5, fill: C.muted }))

  parts.push(`<rect x="${sx + 22}" y="262" width="${sw - 44}" height="110" rx="8" `
    + `fill="#ffffff" stroke="${C.line}" stroke-width="1.6"/>`)
  parts.push(text(sx + sw / 2, 289, 'Game Layer', { anchor: 'middle', size: 14, weight: 600 }))
  parts.push(text(sx + sw / 2, 311, 'SessionManager · Matchmaker',
    { anchor: 'middle', size: 11.5, fill: C.muted }))
  parts.push(text(sx + sw / 2, 331, 'GameActor (mot hang doi moi ban, chay tuan tu)',
    { anchor: 'middle', size: 11.5, fill: C.muted }))
  parts.push(text(sx + sw / 2, 351, 'ClockEngine · Elo · PGN',
    { anchor: 'middle', size: 11.5, fill: C.muted }))

  parts.push(box(sx + 22, 386, sw - 44, 62, 'RulesClient', {
    sub: 'pool · cache LRU · circuit breaker', fill: '#ffffff', stroke: C.line }))
  parts.push(box(sx + 22, 458, sw - 44, 50, 'DbWriter', {
    sub: 'hang doi co chan — JDBC khong bao gio chan game thread (X51)',
    fill: '#ffffff', stroke: C.line, size: 13 }))

  // --- Rules + DB
  parts.push(box(960, 200, 160, 58, 'Rules Service #1', { sub: 'Node + chess.js', fill: C.greenFill, stroke: C.green, size: 13 }))
  parts.push(box(960, 272, 160, 58, 'Rules Service #2', { sub: 'stateless, N ban', fill: C.greenFill, stroke: C.green, size: 13 }))
  parts.push(box(960, 452, 160, 58, 'PostgreSQL 18', { sub: '5 bang', fill: C.redFill, stroke: C.red, size: 13 }))

  // --- Mui ten
  // Trinh duyet -> gateway (WebSocket), gateway -> server (TCP).
  parts.push(arrow(236, 157, 298, 165, { color: C.purple, marker: 'a' }))
  parts.push(arrow(236, 231, 298, 220, { color: C.purple, marker: 'a' }))
  parts.push(arrow(450, 194, sx - 2, 200, { color: C.blue, marker: 'ab' }))

  // Client TCP thuan noi thang vao server, khong qua gateway.
  parts.push(arrow(236, 327, sx - 2, 300, { color: C.blue, marker: 'ab' }))
  // Bot di qua delay proxy khi can mo phong do tre (E4); binh thuong noi thang.
  parts.push(arrow(236, 417, 298, 417, { color: C.amber }))
  parts.push(arrow(450, 417, sx - 2, 400, { color: C.amber }))

  parts.push(arrow(sx + sw + 2, 410, 958, 240, { color: C.green }))
  parts.push(arrow(sx + sw + 2, 418, 958, 305, { color: C.green }))
  parts.push(arrow(sx + sw + 2, 484, 958, 481, { color: C.red }))

  parts.push(text(242, 144, 'CGP/WS', { size: 11, fill: C.purple, weight: 600, family: mono }))
  parts.push(text(456, 182, 'CGP/TCP', { size: 11, fill: C.blue, weight: 600, family: mono }))
  parts.push(text(330, 306, 'CGP/TCP', { size: 11, fill: C.blue, weight: 600, family: mono }))
  parts.push(text(930, 458, 'RVP/TCP', { size: 11, fill: C.green, weight: 600, family: mono, anchor: 'middle' }))
  parts.push(text(915, 470, 'JDBC', { size: 11, fill: C.red, weight: 600, family: mono }))

  // --- Chu thich duoi
  const notes = [
    ['Server la nguon chan ly duy nhat', 'client khong quyet dinh nuoc di hop le, cung khong quyet dinh minh tieu bao nhieu gio'],
    ['Mot ban co = mot hang doi tuan tu', 'khong can khoa tren ban co; hai message cung ban khong bao gio chay song song'],
    ['Loi bi co lap theo bien', 'mot client hong chi lam hong ket noi cua chinh no; gateway chet chi mat nguoi xem'],
  ]
  notes.forEach(([title, body], index) => {
    const y = 566 + index * 64
    parts.push(`<rect x="60" y="${y}" width="1060" height="52" rx="8" fill="${C.slateFill}" `
      + `stroke="${C.soft}" stroke-width="1"/>`)
    parts.push(text(78, y + 22, title, { size: 12.5, weight: 700 }))
    parts.push(text(78, y + 40, body, { size: 11.5, fill: C.muted }))
  })

  return svg(W, H, parts.join('\n'))
}

// ------------------------------------------------------------------ xuat

const outputs = [
  ['protocol', protocolDiagram(), 1180, 1030],
  ['architecture', architectureDiagram(), 1180, 780],
]

fs.mkdirSync(STATICS, { recursive: true })
for (const [name, content] of outputs) {
  fs.writeFileSync(path.join(STATICS, `${name}.svg`), content)
  console.log(`Da ghi statics/${name}.svg`)
}

const playwrightPath = path.resolve(HERE, '../source/web-client/node_modules/playwright/index.mjs')
if (!fs.existsSync(playwrightPath)) {
  console.log('Khong thay Playwright — chi co file SVG (chen thang vao Word duoc).')
  process.exit(0)
}

const { chromium } = await import(pathToFileURL(playwrightPath).href)
const browser = await chromium.launch()
for (const [name, content, width, height] of outputs) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  await page.setContent(`<body style="margin:0">${content}</body>`)
  await page.screenshot({ path: path.join(STATICS, `${name}.png`) })
  await page.close()
  console.log(`Da ghi statics/${name}.png`)
}
await browser.close()
