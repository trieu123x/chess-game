/**
 * CGP v1.0 codec — bản TypeScript.
 *
 * CODE CỦA NHÓM (không phải phần kế thừa từ upstream).
 * Đặc tả: ../../../PROTOCOL.md §A. Bản Java tương ứng: source/common-java.
 * Hai bản phải giải mã được cùng một file testvectors.json (đóng góp N6).
 *
 * Khung: LEN(u32) | TYPE(u8) | SEQ(u32) | PAYLOAD,  LEN = 5 + payload.length
 * Số nguyên: big-endian.
 */

export const T = {
  // client -> server
  LOGIN: 0x01, RESUME: 0x02, LOGOUT: 0x03, QUEUE_JOIN: 0x04, QUEUE_LEAVE: 0x05,
  MOVE: 0x06, RESIGN: 0x07, DRAW_OFFER: 0x08, DRAW_REPLY: 0x09,
  SPECTATE_JOIN: 0x0a, SPECTATE_LEAVE: 0x0b, HISTORY_REQ: 0x0c,
  CLOCK_PING: 0x0d, HEARTBEAT: 0x0e,
  // server -> client
  LOGIN_OK: 0x80, MATCH_FOUND: 0x81, GAME_SNAPSHOT: 0x82, MOVE_APPLIED: 0x83,
  MOVE_REJECTED: 0x84, CLOCK_PONG: 0x85, GAME_OVER: 0x86, PEER_STATUS: 0x87,
  DRAW_OFFERED: 0x88, SPECTATOR_COUNT: 0x89, HISTORY_RESULT: 0x8a,
  HEARTBEAT_ACK: 0x8e, ERROR: 0x8f,
} as const

export type MsgType = (typeof T)[keyof typeof T]

export const TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(T).map(([name, code]) => [code, name]),
)

export const MAX_FRAME = 65536

export type Frame = { type: number; seq: number; payload: Uint8Array }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeFrame(type: number, seq: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(4 + 5 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, 5 + payload.length)
  view.setUint8(4, type)
  view.setUint32(5, seq >>> 0)
  out.set(payload, 9)
  return out
}

/** Giải mã một frame trọn vẹn (WebSocket giữ nguyên ranh giới message). */
export function decodeFrame(data: ArrayBuffer): Frame {
  if (data.byteLength < 9) throw new CgpError(2001, `frame quá ngắn: ${data.byteLength} byte`)
  const view = new DataView(data)
  const len = view.getUint32(0)
  if (len < 5) throw new CgpError(2001, `LEN không hợp lệ: ${len}`)
  if (len > MAX_FRAME) throw new CgpError(2003, `frame vượt ${MAX_FRAME} byte`)
  if (len + 4 !== data.byteLength) throw new CgpError(2001, `LEN=${len} không khớp ${data.byteLength - 4}`)
  return {
    type: view.getUint8(4),
    seq: view.getUint32(5),
    payload: new Uint8Array(data, 9, len - 5),
  }
}

/**
 * Bộ gom frame cho luồng TCP: một message có thể tới làm nhiều lần đọc
 * (half-packet) hoặc nhiều message tới trong một lần đọc. Gateway dùng cái này;
 * đây cũng là test bắt buộc T02 trong PLAN.md §8.
 */
export class FrameAccumulator {
  private buffer = new Uint8Array(0)

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length)
    merged.set(this.buffer)
    merged.set(chunk, this.buffer.length)
    this.buffer = merged

    const frames: Frame[] = []
    for (;;) {
      if (this.buffer.length < 4) break
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength)
      const len = view.getUint32(0)
      if (len < 5) throw new CgpError(2001, `LEN không hợp lệ: ${len}`)
      if (len > MAX_FRAME) throw new CgpError(2003, `frame vượt ${MAX_FRAME} byte`)
      if (this.buffer.length < len + 4) break
      frames.push({
        type: view.getUint8(4),
        seq: view.getUint32(5),
        payload: this.buffer.slice(9, len + 4),
      })
      this.buffer = this.buffer.slice(len + 4)
    }
    return frames
  }
}

export class CgpError extends Error {
  // Khai báo tường minh thay vì dùng parameter property: cú pháp đó cần biên
  // dịch thật, trong khi cách này chạy được cả với `node --experimental-strip-types`
  // — nhờ vậy kiểm tra interop của bản TS không cần mở trình duyệt.
  readonly code: number

  constructor(code: number, message: string) {
    super(`CGP ${code}: ${message}`)
    this.code = code
  }
}

// ---------- payload JSON ----------

export const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value))

export function parseJson<T>(payload: Uint8Array): T {
  try {
    return JSON.parse(decoder.decode(payload)) as T
  } catch {
    throw new CgpError(2001, 'payload JSON hỏng')
  }
}

// ---------- ô cờ ----------

/** 'e2' -> 12.  index = rank*8 + file, a1 = 0, h8 = 63. */
export function squareToIndex(square: string): number {
  const file = square.charCodeAt(0) - 97
  const rank = square.charCodeAt(1) - 49
  if (file < 0 || file > 7 || rank < 0 || rank > 7) throw new CgpError(2001, `ô không hợp lệ: ${square}`)
  return rank * 8 + file
}

export function indexToSquare(index: number): string {
  if (index < 0 || index > 63) throw new CgpError(2001, `chỉ số ô không hợp lệ: ${index}`)
  return String.fromCharCode(97 + (index % 8)) + String.fromCharCode(49 + Math.floor(index / 8))
}

const PROMO_CODES: Record<string, number> = { n: 1, b: 2, r: 3, q: 4 }
const PROMO_LETTERS = ['', 'n', 'b', 'r', 'q']

// ---------- MOVE (8 byte) ----------

export type MoveOut = { from: string; to: string; promo?: string; ply: number }

export function encodeMove(move: MoveOut): Uint8Array {
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setUint8(0, squareToIndex(move.from))
  view.setUint8(1, squareToIndex(move.to))
  view.setUint8(2, move.promo ? (PROMO_CODES[move.promo] ?? 0) : 0)
  view.setUint8(3, 0) // flags: server tự tính
  view.setUint16(4, move.ply)
  view.setUint16(6, 0) // reserved
  return out
}

// ---------- MOVE_APPLIED (16 byte) ----------

export const FLAG = {
  CAPTURE: 1 << 0, CASTLE: 1 << 1, EN_PASSANT: 1 << 2, PROMOTION: 1 << 3,
  CHECK: 1 << 4, CHECKMATE: 1 << 5, DRAW: 1 << 6,
} as const

export type MoveApplied = {
  ply: number
  from: string
  to: string
  promo: string
  flags: number
  clockWhiteMs: number
  clockBlackMs: number
  serverProcessMs: number
}

export function decodeMoveApplied(payload: Uint8Array): MoveApplied {
  if (payload.length !== 16) throw new CgpError(2001, `MOVE_APPLIED phải 16 byte, nhận ${payload.length}`)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  return {
    ply: view.getUint16(0),
    from: indexToSquare(view.getUint8(2)),
    to: indexToSquare(view.getUint8(3)),
    promo: PROMO_LETTERS[view.getUint8(4)] ?? '',
    flags: view.getUint8(5),
    clockWhiteMs: view.getUint32(6),
    clockBlackMs: view.getUint32(10),
    serverProcessMs: view.getUint16(14),
  }
}

export const hasFlag = (flags: number, flag: number): boolean => (flags & flag) !== 0

// ---------- CLOCK_PING / CLOCK_PONG ----------

export function encodeClockPing(t1: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.round(t1)))
  return out
}

export type ClockPong = { t1: number; t2: number; t3: number }

export function decodeClockPong(payload: Uint8Array): ClockPong {
  if (payload.length !== 24) throw new CgpError(2001, `CLOCK_PONG phải 24 byte, nhận ${payload.length}`)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  return {
    t1: Number(view.getBigUint64(0)),
    t2: Number(view.getBigUint64(8)),
    t3: Number(view.getBigUint64(16)),
  }
}

/**
 * Bù độ trễ kiểu NTP (PROTOCOL.md §A5).
 * offset = ((t2 - t1) + (t3 - t4)) / 2,  rtt = (t4 - t1) - (t3 - t2)
 *
 * Client chỉ dùng offset để HIỂN THỊ cho khớp server. Con số dùng để trừ giờ
 * là do server tự đo — client không được phép tự khai (ngoại lệ X33).
 */
export function clockOffset(pong: ClockPong, t4: number): { offsetMs: number; rttMs: number } {
  return {
    offsetMs: ((pong.t2 - pong.t1) + (pong.t3 - t4)) / 2,
    rttMs: (t4 - pong.t1) - (pong.t3 - pong.t2),
  }
}

export const median = (values: number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// ---------- payload JSON có kiểu ----------

export type LoginOk = { sessionToken: string; userId: number; username: string; elo: number }
export type MatchFound = { gameId: number; color: 'w' | 'b'; opponent: string; oppElo: number; timeControl: string }
export type GameSnapshot = {
  gameId: number; fen: string; ply: number; moves: string[]
  clockW: number; clockB: number; turn: 'w' | 'b'; status: string
}
export type MoveRejected = { code: number; reason: string; expectedPly: number }
export type GameOver = { result: '1-0' | '0-1' | '1/2-1/2'; reason: string; eloDelta: number; pgn?: string }
export type PeerStatus = { state: 'disconnected' | 'reconnected'; graceMs: number }
export type ServerError = { code: number; message: string }
