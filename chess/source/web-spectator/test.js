/**
 * Kiem thu Web Gateway.
 *
 * Can co Game Server dang chay o 127.0.0.1:5555 (bien SERVER_HOST/SERVER_PORT
 * doi duoc), vi day la test tich hop: cai can kiem chinh la cau noi
 * WebSocket <-> TCP, khong phai tung ham roi rac.
 *
 * Chay:  node test.js
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as cgp from '../common-js/cgp.js'

const GATEWAY_PORT = Number(process.env.GATEWAY_TEST_PORT ?? 8099)
const TCP_TARGET = `${process.env.SERVER_HOST ?? '127.0.0.1'}:${process.env.SERVER_PORT ?? 5555}`

/**
 * Client WebSocket toi gian, du de noi chuyen voi gateway.
 *
 * Viet tay vi ly do giong nhu ben server: khong keo them dependency, va vi
 * chieu client -> server BAT BUOC phai mask (RFC 6455 §5.1) - tu viet thi thay
 * ro dieu do thay vi de thu vien lam ho.
 */
class TestClient {
  #socket
  #buffer = Buffer.alloc(0)
  #handlers = []

  static connect(port) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64')
      const request = http.request({
        port, path: '/', headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        },
      })
      request.on('upgrade', (response, socket) => {
        const expected = crypto.createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        if (response.headers['sec-websocket-accept'] !== expected) {
          reject(new Error('Sec-WebSocket-Accept sai'))
          return
        }
        resolve(new TestClient(socket))
      })
      request.on('error', reject)
      request.end()
    })
  }

  constructor(socket) {
    this.#socket = socket
    socket.on('data', chunk => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      for (;;) {
        const message = this.#readFrame()
        if (!message) return
        const handler = this.#handlers.shift()
        if (handler) handler(message)
      }
    })
  }

  #readFrame() {
    if (this.#buffer.length < 2) return null
    let length = this.#buffer.readUInt8(1) & 0x7f
    let offset = 2
    if (length === 126) {
      if (this.#buffer.length < 4) return null
      length = this.#buffer.readUInt16BE(2)
      offset = 4
    }
    if (this.#buffer.length < offset + length) return null
    const payload = this.#buffer.subarray(offset, offset + length)
    this.#buffer = this.#buffer.subarray(offset + length)
    return payload
  }

  send(frame) {
    const mask = crypto.randomBytes(4)
    const masked = Buffer.from(frame)
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3]

    const short = frame.length < 126
    const header = Buffer.allocUnsafe(short ? 6 : 8)
    header.writeUInt8(0x82, 0)                       // FIN + opcode binary
    if (short) {
      header.writeUInt8(0x80 | frame.length, 1)
      mask.copy(header, 2)
    } else {
      header.writeUInt8(0x80 | 126, 1)
      header.writeUInt16BE(frame.length, 2)
      mask.copy(header, 4)
    }
    this.#socket.write(Buffer.concat([header, masked]))
  }

  /** Cho mot frame CGP tiep theo, het gio thi bao loi thay vi treo mai. */
  next(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('het gio cho frame')), timeoutMs)
      this.#handlers.push(payload => {
        clearTimeout(timer)
        resolve(cgp.decodeFrame(payload))
      })
    })
  }

  close() {
    this.#socket.destroy()
  }
}

const startGateway = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath,
    ['gateway.js', '--ws', String(GATEWAY_PORT), '--tcp', TCP_TARGET],
    { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'inherit'] })
  const timer = setTimeout(() => reject(new Error('gateway khong khoi dong')), 5000)
  child.stdout.on('data', chunk => {
    if (chunk.toString().includes('Web Gateway')) {
      clearTimeout(timer)
      setTimeout(() => resolve(child), 150)
    }
  })
})

const gateway = await startGateway()

test('bat tay WebSocket dung RFC 6455 va chuyen duoc frame CGP hai chieu', async () => {
  const client = await TestClient.connect(GATEWAY_PORT)
  client.send(cgp.encodeFrame(cgp.T.LOGIN, 1, cgp.json({ username: 'carol', password: 'chess123' })))

  const reply = await client.next()
  assert.equal(reply.type, cgp.T.LOGIN_OK, `nhan ${cgp.typeName(reply.type)}`)
  const session = cgp.parseJson(reply.payload)
  assert.equal(session.username, 'carol')
  assert.ok(session.sessionToken.length > 10)
  client.close()
})

test('LOBBY_REQ tra ve danh sach van va bang xep hang', async () => {
  const client = await TestClient.connect(GATEWAY_PORT)
  client.send(cgp.encodeFrame(cgp.T.LOGIN, 1, cgp.json({ username: 'carol', password: 'chess123' })))
  await client.next()

  client.send(cgp.encodeFrame(cgp.T.LOBBY_REQ, 2))
  let frame = await client.next()
  while (frame.type !== cgp.T.LOBBY_RESULT) frame = await client.next()

  const lobby = cgp.parseJson(frame.payload)
  assert.ok(Array.isArray(lobby.games), 'phai co truong games')
  assert.ok(Array.isArray(lobby.leaderboard), 'phai co truong leaderboard')
  client.close()
})

test('sai mat khau tra ve ERROR 1001 chu khong dong im lang', async () => {
  const client = await TestClient.connect(GATEWAY_PORT)
  client.send(cgp.encodeFrame(cgp.T.LOGIN, 1, cgp.json({ username: 'carol', password: 'sai-mat-khau' })))

  const reply = await client.next()
  assert.equal(reply.type, cgp.T.ERROR)
  assert.equal(cgp.parseJson(reply.payload).code, cgp.ERR.BAD_CREDENTIALS)
  client.close()
})

test('frame lon hon 125 byte dung header 16-bit dung cach', async () => {
  const client = await TestClient.connect(GATEWAY_PORT)
  // Payload dai co y de ep ca hai chieu dung nhanh do dai 126 cua RFC 6455.
  const longName = 'x'.repeat(200)
  client.send(cgp.encodeFrame(cgp.T.LOGIN, 1, cgp.json({ username: longName, password: 'chess123' })))

  const reply = await client.next()
  assert.equal(reply.type, cgp.T.ERROR)
  assert.equal(cgp.parseJson(reply.payload).code, cgp.ERR.INVALID_CREDENTIALS_FORMAT)
  client.close()
})

test('gateway phuc vu trang khan gia', async () => {
  const body = await new Promise((resolve, reject) => {
    http.get({ port: GATEWAY_PORT, path: '/' }, response => {
      let text = ''
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, text }))
    }).on('error', reject)
  })
  assert.equal(body.status, 200)
  assert.ok(body.text.includes('DCGS'), 'trang phai la giao dien khan gia')
})

test.after(() => gateway.kill())
