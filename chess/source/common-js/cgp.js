/**
 * CGP v1.0 + RVP v1.0 codec — ban Node.js dung chung cho gateway, bot va rules service.
 *
 * CODE CUA NHOM. Dac ta: chess/PROTOCOL.md
 *
 * Ba ban hien thuc cua cung mot protocol:
 *   - Java      : source/common-java  (server, client-cli)
 *   - Node      : file nay            (gateway, bot, rules service)
 *   - Browser TS: source/web-client/src/net/cgp.ts
 * Ca ba deu phai giai ma dung file testvectors.json trong thu muc nay — day la
 * bang chung cho dong gop N6 (protocol doc lap ngon ngu).
 *
 * Khung: LEN(u32) | TYPE(u8) | SEQ(u32) | PAYLOAD,  LEN = 5 + payload.length
 * Thu tu byte: big-endian.
 */

export const T = {
  // CGP client -> server
  LOGIN: 0x01, RESUME: 0x02, LOGOUT: 0x03, QUEUE_JOIN: 0x04, QUEUE_LEAVE: 0x05,
  MOVE: 0x06, RESIGN: 0x07, DRAW_OFFER: 0x08, DRAW_REPLY: 0x09,
  SPECTATE_JOIN: 0x0a, SPECTATE_LEAVE: 0x0b, HISTORY_REQ: 0x0c, LOBBY_REQ: 0x10,
  CLOCK_PING: 0x0d, HEARTBEAT: 0x0e, REGISTER: 0x0f,
  // RVP server -> rules service
  RULES_VALIDATE: 0x20, RULES_LEGAL_MOVES: 0x21, RULES_PING: 0x22, RULES_MATERIAL: 0x23,
  // CGP server -> client
  LOGIN_OK: 0x80, MATCH_FOUND: 0x81, GAME_SNAPSHOT: 0x82, MOVE_APPLIED: 0x83,
  MOVE_REJECTED: 0x84, CLOCK_PONG: 0x85, GAME_OVER: 0x86, PEER_STATUS: 0x87,
  DRAW_OFFERED: 0x88, SPECTATOR_COUNT: 0x89, HISTORY_RESULT: 0x8a,
  LOBBY_RESULT: 0x8b, HEARTBEAT_ACK: 0x8e, ERROR: 0x8f,
  // RVP rules service -> server
  RULES_OK: 0xa0, RULES_ILLEGAL: 0xa1, RULES_LEGAL_MOVES_RESULT: 0xa2, RULES_ERROR: 0xaf,
}

export const TYPE_NAMES = Object.fromEntries(Object.entries(T).map(([name, code]) => [code, name]))

export const typeName = type => TYPE_NAMES[type] ?? `UNKNOWN(0x${type.toString(16).padStart(2, '0')})`

export const ERR = {
  BAD_CREDENTIALS: 1001, SESSION_EXPIRED: 1002, LOGGED_IN_ELSEWHERE: 1003,
  USERNAME_TAKEN: 1004, INVALID_CREDENTIALS_FORMAT: 1005,
  MALFORMED_FRAME: 2001, UNKNOWN_TYPE: 2002, FRAME_TOO_LARGE: 2003,
  BAD_PROTOCOL_VERSION: 2004, NOT_AUTHENTICATED: 2005,
  NOT_YOUR_TURN: 3001, ILLEGAL_MOVE: 3002, GAME_NOT_FOUND: 3003, NOT_A_PLAYER: 3004,
  STALE_PLY: 3005, PROMOTION_REQUIRED: 3006, GAME_ALREADY_OVER: 3007, ALREADY_QUEUED: 3008,
  RULES_UNAVAILABLE: 4001, DATABASE_ERROR: 4002, SERVER_OVERLOADED: 4003,
  INTERNAL_ERROR: 4004, RATE_LIMITED: 4005,
}

export const MAX_FRAME = 65536

export class CgpError extends Error {
  constructor(code, message) {
    super(`CGP ${code}: ${message}`)
    this.code = code
  }
}

// ---------------------------------------------------------------- khung

export function encodeFrame(type, seq, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  if (body.length + 5 > MAX_FRAME) {
    throw new CgpError(ERR.FRAME_TOO_LARGE, `payload ${body.length} byte vuot gioi han`)
  }
  const out = Buffer.allocUnsafe(9 + body.length)
  out.writeUInt32BE(5 + body.length, 0)
  out.writeUInt8(type, 4)
  out.writeUInt32BE(seq >>> 0, 5)
  body.copy(out, 9)
  return out
}

/** Payload JSON dang Buffer — cung ten voi ban TypeScript de ba ban doc giong nhau. */
export const json = value => Buffer.from(JSON.stringify(value), 'utf8')

export const encodeJson = (type, seq, value) => encodeFrame(type, seq, json(value))

/**
 * Giai ma mot frame TRON VEN.
 *
 * Dung cho WebSocket (moi message la mot frame) va cho test. Luong TCP phai
 * dung {@link FrameAccumulator} vi ranh gioi message khong duoc bao toan.
 */
export function decodeFrame(buffer) {
  if (buffer.length < 9) {
    throw new CgpError(ERR.MALFORMED_FRAME, `frame qua ngan: ${buffer.length} byte`)
  }
  const len = buffer.readUInt32BE(0)
  if (len < 5) throw new CgpError(ERR.MALFORMED_FRAME, `LEN khong hop le: ${len}`)
  if (len > MAX_FRAME) throw new CgpError(ERR.FRAME_TOO_LARGE, `LEN = ${len}`)
  if (len + 4 !== buffer.length) {
    throw new CgpError(ERR.MALFORMED_FRAME, `LEN=${len} khong khop ${buffer.length - 4}`)
  }
  return {
    type: buffer.readUInt8(4),
    seq: buffer.readUInt32BE(5),
    payload: buffer.subarray(9),
  }
}

export function parseJson(payload) {
  try {
    return JSON.parse(payload.toString('utf8'))
  } catch {
    throw new CgpError(ERR.MALFORMED_FRAME, 'payload JSON hong')
  }
}

/**
 * Bo gom byte cho mot ket noi TCP.
 *
 * TCP khong giu ranh gioi message: mot lan `data` co the mang nua frame hoac
 * nam frame dinh lien. Moi ket noi giu mot Decoder rieng.
 */
export class FrameAccumulator {
  #buffer = Buffer.alloc(0)

  /** @returns {{type:number, seq:number, payload:Buffer}[]} */
  push(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk
    const frames = []
    let offset = 0
    for (;;) {
      if (this.#buffer.length - offset < 4) break
      const len = this.#buffer.readUInt32BE(offset)
      if (len < 5) throw new CgpError(ERR.MALFORMED_FRAME, `LEN khong hop le: ${len}`)
      if (len > MAX_FRAME) throw new CgpError(ERR.FRAME_TOO_LARGE, `LEN = ${len}`)
      if (this.#buffer.length - offset < len + 4) break
      frames.push({
        type: this.#buffer.readUInt8(offset + 4),
        seq: this.#buffer.readUInt32BE(offset + 5),
        payload: this.#buffer.subarray(offset + 9, offset + 4 + len),
      })
      offset += 4 + len
    }
    this.#buffer = offset ? this.#buffer.subarray(offset) : this.#buffer
    return frames
  }

  get pending() {
    return this.#buffer.length
  }
}

/** Ten cu, giu lai de code da viet khong hong. */
export const Decoder = FrameAccumulator

// ---------------------------------------------------------------- o co

export function squareToIndex(square) {
  const file = square.charCodeAt(0) - 97
  const rank = square.charCodeAt(1) - 49
  if (!(file >= 0 && file <= 7 && rank >= 0 && rank <= 7)) {
    throw new CgpError(ERR.MALFORMED_FRAME, `o co khong hop le: ${square}`)
  }
  return rank * 8 + file
}

export const indexToSquare = index => {
  if (index < 0 || index > 63) throw new CgpError(ERR.MALFORMED_FRAME, `chi so o: ${index}`)
  return String.fromCharCode(97 + (index % 8)) + String.fromCharCode(49 + Math.floor(index / 8))
}

const PROMO_CODES = { n: 1, b: 2, r: 3, q: 4 }
const PROMO_LETTERS = ['', 'n', 'b', 'r', 'q']

export const promotionCode = letter => (letter ? PROMO_CODES[letter.toLowerCase()] ?? 0 : 0)
export const promotionLetter = code => PROMO_LETTERS[code] ?? ''

// ---------------------------------------------------------------- nuoc di

export const FLAG = {
  CAPTURE: 1, CASTLE: 2, EN_PASSANT: 4, PROMOTION: 8,
  CHECK: 16, CHECKMATE: 32, DRAW: 64,
}

export function encodeMove({ from, to, promo = '', ply = 0 }) {
  const out = Buffer.alloc(8)
  out.writeUInt8(squareToIndex(from), 0)
  out.writeUInt8(squareToIndex(to), 1)
  out.writeUInt8(promotionCode(promo), 2)
  out.writeUInt8(0, 3)              // flags: server tu tinh
  out.writeUInt16BE(ply, 4)
  out.writeUInt16BE(0, 6)           // reserved
  return out
}

export function decodeMove(payload) {
  if (payload.length !== 8) {
    throw new CgpError(ERR.MALFORMED_FRAME, `MOVE phai 8 byte, nhan ${payload.length}`)
  }
  return {
    from: indexToSquare(payload.readUInt8(0)),
    to: indexToSquare(payload.readUInt8(1)),
    promo: promotionLetter(payload.readUInt8(2)),
    flags: payload.readUInt8(3),
    ply: payload.readUInt16BE(4),
  }
}

export function encodeMoveApplied(applied) {
  const out = Buffer.alloc(16)
  out.writeUInt16BE(applied.ply, 0)
  out.writeUInt8(squareToIndex(applied.from), 2)
  out.writeUInt8(squareToIndex(applied.to), 3)
  out.writeUInt8(promotionCode(applied.promo ?? ''), 4)
  out.writeUInt8(applied.flags ?? 0, 5)
  out.writeUInt32BE(Math.max(0, applied.clockWhiteMs), 6)
  out.writeUInt32BE(Math.max(0, applied.clockBlackMs), 10)
  out.writeUInt16BE(applied.serverProcessMs ?? 0, 14)
  return out
}

export function decodeMoveApplied(payload) {
  if (payload.length !== 16) {
    throw new CgpError(ERR.MALFORMED_FRAME, `MOVE_APPLIED phai 16 byte, nhan ${payload.length}`)
  }
  return {
    ply: payload.readUInt16BE(0),
    from: indexToSquare(payload.readUInt8(2)),
    to: indexToSquare(payload.readUInt8(3)),
    promo: promotionLetter(payload.readUInt8(4)),
    flags: payload.readUInt8(5),
    clockWhiteMs: payload.readUInt32BE(6),
    clockBlackMs: payload.readUInt32BE(10),
    serverProcessMs: payload.readUInt16BE(14),
  }
}

export const hasFlag = (flags, flag) => (flags & flag) !== 0

// ---------------------------------------------------------------- dong ho

export const encodeClockPing = t1 => {
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(BigInt(Math.round(t1)))
  return out
}

export function encodeClockPong(t1, t2, t3) {
  const out = Buffer.alloc(24)
  out.writeBigUInt64BE(BigInt(Math.round(t1)), 0)
  out.writeBigUInt64BE(BigInt(Math.round(t2)), 8)
  out.writeBigUInt64BE(BigInt(Math.round(t3)), 16)
  return out
}

export function decodeClockPong(payload) {
  if (payload.length !== 24) {
    throw new CgpError(ERR.MALFORMED_FRAME, `CLOCK_PONG phai 24 byte, nhan ${payload.length}`)
  }
  return {
    t1: Number(payload.readBigUInt64BE(0)),
    t2: Number(payload.readBigUInt64BE(8)),
    t3: Number(payload.readBigUInt64BE(16)),
  }
}

/** offset = ((t2-t1) + (t3-t4)) / 2 ; rtt = (t4-t1) - (t3-t2)  — PROTOCOL.md §A5 */
export const clockOffset = ({ t1, t2, t3 }, t4) => ({
  offsetMs: ((t2 - t1) + (t3 - t4)) / 2,
  rttMs: (t4 - t1) - (t3 - t2),
})

// ---------------------------------------------------------------- tien ich

/**
 * Dung byte `flags` cua MOVE_APPLIED tu mot nuoc di cua chess.js.
 *
 * Server la ben duy nhat duoc tinh cac co nay (client gui len luon bang 0),
 * nen ham nay chay o rules service va o server, khong chay o client.
 *
 * chess.js dung chu cai cho flags: c=an quan, e=bat tot qua duong,
 * p=phong cap, k/q=nhap thanh.
 */
export function flagsFromMove(move, status = 'ongoing') {
  const raw = move.flags ?? ''
  const san = move.san ?? ''
  let flags = 0

  if (move.captured || raw.includes('c') || raw.includes('e')) flags |= FLAG.CAPTURE
  if (raw.includes('k') || raw.includes('q') || san.startsWith('O-O')) flags |= FLAG.CASTLE
  if (raw.includes('e')) flags |= FLAG.EN_PASSANT
  if (raw.includes('p') || san.includes('=')) flags |= FLAG.PROMOTION
  if (san.includes('+') || status === 'check') flags |= FLAG.CHECK
  // Chieu het cung la chieu: client chi nhin flags de phat am thanh va to mau.
  if (san.includes('#') || status === 'checkmate') flags |= FLAG.CHECK | FLAG.CHECKMATE
  if (status === 'stalemate' || status.startsWith('draw')) flags |= FLAG.DRAW

  return flags
}

/** Trung vi — dung de loc nhieu khi do RTT (PROTOCOL.md §A5). */
export const median = values => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
