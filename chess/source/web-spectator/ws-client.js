/**
 * Client WebSocket toi gian — du de noi CGP qua Web Gateway tu Node.
 *
 * CODE CUA NHOM. Dung cho kiem thu gateway va cho thi nghiem E8 (do overhead
 * cua WebSocket so voi TCP thuan). Viet tay vi ly do giong nhu ben server:
 * chieu client -> server BAT BUOC phai mask (RFC 6455 §5.1), va tu viet thi
 * con so overhead do duoc o E8 giai thich duoc tung byte mot.
 *
 * Pham vi: chi binary + close + ping/pong, khong extension, khong nen.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export class WsClient extends EventEmitter {

  #socket
  #buffer = Buffer.alloc(0)

  /** So byte THAT SU doc duoc tu socket, ke ca header cua WebSocket (cho E8). */
  bytesRead = 0
  bytesWritten = 0
  messages = 0

  static connect(port, host = '127.0.0.1', path = '/') {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64')
      const request = http.request({
        host, port, path, headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        },
      })
      request.on('upgrade', (response, socket) => {
        const expected = crypto.createHash('sha1')
          .update(key + GUID).digest('base64')
        if (response.headers['sec-websocket-accept'] !== expected) {
          reject(new Error('Sec-WebSocket-Accept sai'))
          return
        }
        resolve(new WsClient(socket))
      })
      request.on('error', reject)
      request.end()
    })
  }

  constructor(socket) {
    super()
    this.#socket = socket
    socket.setNoDelay(true)
    socket.on('data', chunk => {
      this.bytesRead += chunk.length
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      for (;;) {
        const message = this.#read()
        if (!message) return
        this.messages += 1
        this.emit('message', message)
      }
    })
    socket.on('close', () => this.emit('close'))
    socket.on('error', failure => this.emit('error', failure))
  }

  #read() {
    if (this.#buffer.length < 2) return null
    const opcode = this.#buffer.readUInt8(0) & 0x0f
    let length = this.#buffer.readUInt8(1) & 0x7f
    let offset = 2
    if (length === 126) {
      if (this.#buffer.length < 4) return null
      length = this.#buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (this.#buffer.length < 10) return null
      length = Number(this.#buffer.readBigUInt64BE(2))
      offset = 10
    }
    if (this.#buffer.length < offset + length) return null
    const payload = this.#buffer.subarray(offset, offset + length)
    this.#buffer = this.#buffer.subarray(offset + length)
    if (opcode === 0x8) {
      this.close()
      return null
    }
    return payload
  }

  /**
   * Gui mot frame CGP trong mot message binary.
   *
   * Overhead chieu nay la 6 byte voi payload < 126 (2 byte header + 4 byte
   * mask), nhieu hon chieu server -> client vi client bat buoc phai mask.
   */
  send(frame) {
    const body = Buffer.from(frame)
    const mask = crypto.randomBytes(4)
    const masked = Buffer.from(body)
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3]

    const short = body.length < 126
    const header = Buffer.allocUnsafe(short ? 6 : 8)
    header.writeUInt8(0x82, 0)
    if (short) {
      header.writeUInt8(0x80 | body.length, 1)
      mask.copy(header, 2)
    } else {
      header.writeUInt8(0x80 | 126, 1)
      header.writeUInt16BE(body.length, 2)
      mask.copy(header, 4)
    }
    const out = Buffer.concat([header, masked])
    this.bytesWritten += out.length
    this.#socket.write(out)
  }

  close() {
    this.#socket.destroy()
  }
}
