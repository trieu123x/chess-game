/**
 * Phia server cua WebSocket (RFC 6455), du dung cho gateway CGP.
 *
 * CODE CUA NHOM. Tu viet thay vi `npm i ws` vi hai ly do:
 *  1. Dong khung la dung noi dung mon hoc — va no cho thay CGP khong phu thuoc
 *     vao thu vien nao, chi phu thuoc vao dac ta.
 *  2. Thi nghiem E8 do overhead moi message cua WebSocket so voi TCP thuan.
 *     Con so do chi giai thich duoc khi biet chinh xac header nao duoc them
 *     vao — ma o day thi no nam ngay trong {@link WebSocketConnection#sendBinary}.
 *
 * Pham vi co chu dich: chi lam server, chi nhan binary + close + ping/pong, co
 * xu ly frame noi (continuation). Khong lam permessage-deflate, khong lam
 * extension — frame CGP von da nhi phan va nho, nen nen lai khong duoc gi.
 *
 * ## Khung WebSocket (§5.2)
 *
 *   byte 0 : FIN(1) RSV(3) OPCODE(4)
 *   byte 1 : MASK(1) LEN7(7)
 *   + LEN7 = 126 -> 2 byte do dai tiep theo; = 127 -> 8 byte
 *   + MASK = 1    -> 4 byte khoa mask (client -> server LUON mask)
 *   PAYLOAD
 */
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

/** Hang so cua RFC 6455 §1.3 — khong phai mot lua chon, la con so co dinh. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** Mot message ghep tu nhieu frame lon hon nguong nay bi coi la tan cong. */
const MAX_MESSAGE = 1 << 20

/**
 * Tra loi bat tay. Tra ve false (va da dong socket) neu request khong hop le.
 */
export function acceptUpgrade(request, socket) {
  const key = request.headers['sec-websocket-key']
  if (request.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return false
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
  socket.setNoDelay(true)
  return true
}

export class WebSocketConnection extends EventEmitter {

  #socket
  #buffer = Buffer.alloc(0)
  #fragments = []
  #fragmentOpcode = 0
  #closed = false

  constructor(socket, head) {
    super()
    this.#socket = socket
    socket.on('data', chunk => this.#onData(chunk))
    socket.on('close', () => this.#onClose())
    socket.on('error', failure => this.emit('error', failure))
    if (head && head.length) this.#onData(head)
  }

  #onClose() {
    if (this.#closed) return
    this.#closed = true
    this.emit('close')
  }

  #onData(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk
    for (;;) {
      const frame = this.#readFrame()
      if (!frame) return
      this.#handleFrame(frame)
      if (this.#closed) return
    }
  }

  /** Doc mot frame neu da du byte; tra ve null neu con thieu (half-packet). */
  #readFrame() {
    const buffer = this.#buffer
    if (buffer.length < 2) return null

    const first = buffer.readUInt8(0)
    const second = buffer.readUInt8(1)
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2

    if (length === 126) {
      if (buffer.length < offset + 2) return null
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null
      const big = buffer.readBigUInt64BE(offset)
      if (big > BigInt(MAX_MESSAGE)) {
        this.close(1009, 'message qua lon')
        return null
      }
      length = Number(big)
      offset += 8
    }

    let mask = null
    if (masked) {
      if (buffer.length < offset + 4) return null
      mask = buffer.subarray(offset, offset + 4)
      offset += 4
    } else {
      // RFC 6455 §5.1: client BAT BUOC phai mask. Khong mask la sai protocol.
      this.close(1002, 'client phai mask frame')
      return null
    }

    if (buffer.length < offset + length) return null
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i & 3]
    }
    this.#buffer = buffer.subarray(offset + length)
    return { fin, opcode, payload }
  }

  #handleFrame(frame) {
    switch (frame.opcode) {
      case OP_CLOSE:
        this.close()
        return

      case OP_PING:
        this.#write(OP_PONG, frame.payload)
        return

      case OP_PONG:
        return

      case OP_CONTINUATION: {
        if (!this.#fragmentOpcode) {
          this.close(1002, 'continuation khong co frame dau')
          return
        }
        this.#fragments.push(frame.payload)
        if (frame.fin) this.#emitMessage()
        return
      }

      case OP_BINARY:
      case OP_TEXT: {
        if (frame.fin) {
          this.#fragmentOpcode = frame.opcode
          this.#fragments = [frame.payload]
          this.#emitMessage()
          return
        }
        this.#fragmentOpcode = frame.opcode
        this.#fragments = [frame.payload]
        return
      }

      default:
        this.close(1002, `opcode la: ${frame.opcode}`)
    }
  }

  #emitMessage() {
    const total = this.#fragments.reduce((sum, part) => sum + part.length, 0)
    const opcode = this.#fragmentOpcode
    const body = this.#fragments.length === 1 ? this.#fragments[0] : Buffer.concat(this.#fragments)
    this.#fragments = []
    this.#fragmentOpcode = 0
    if (total > MAX_MESSAGE) {
      this.close(1009, 'message qua lon')
      return
    }
    this.emit('message', body, opcode === OP_BINARY)
  }

  /**
   * Gui mot message binary.
   *
   * Overhead la 2 byte header voi payload < 126 byte, 4 byte voi payload < 64 KiB
   * — server khong mask. Do chinh la con so ma E8 so voi TCP thuan.
   */
  sendBinary(payload) {
    this.#write(OP_BINARY, Buffer.isBuffer(payload) ? payload : Buffer.from(payload))
  }

  #write(opcode, payload) {
    if (this.#closed || !this.#socket.writable) return

    let header
    if (payload.length < 126) {
      header = Buffer.allocUnsafe(2)
      header.writeUInt8(0x80 | opcode, 0)
      header.writeUInt8(payload.length, 1)
    } else if (payload.length < 65536) {
      header = Buffer.allocUnsafe(4)
      header.writeUInt8(0x80 | opcode, 0)
      header.writeUInt8(126, 1)
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.allocUnsafe(10)
      header.writeUInt8(0x80 | opcode, 0)
      header.writeUInt8(127, 1)
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    this.#socket.write(Buffer.concat([header, payload]))
  }

  close(code = 1000, reason = '') {
    if (this.#closed) return
    const body = Buffer.allocUnsafe(2 + Buffer.byteLength(reason))
    body.writeUInt16BE(code, 0)
    body.write(reason, 2, 'utf8')
    this.#write(OP_CLOSE, body)
    this.#closed = true
    this.#socket.end()
    this.emit('close')
  }
}
