/**
 * Rules Service — kiem tra luat co, khong giu trang thai.
 *
 * CODE CUA NHOM. Noi RVP v1.0 tren TCP (PROTOCOL.md §B), dung `chess.js` lam
 * thu vien luat co (khai bao trong README theo Instruction.md §4).
 *
 * Vi sao tach ra thanh mot tien trinh rieng:
 *  - Server Java giu trang thai van dau; kiem tra luat thi khong can trang thai
 *    gi ca — moi request tu mang du FEN. Nho vay chay duoc N instance song song
 *    va them/bot instance khong can dong bo (thi nghiem E7).
 *  - Doi lai moi nuoc di ton them mot round-trip noi bo. Server bu lai bang
 *    connection pool + cache theo FEN; chinh con so nay la noi dung E7.
 *
 * Chay:  node index.js --port 6001
 */
import net from 'node:net'
import { Chess } from 'chess.js'
import * as cgp from '../common-js/cgp.js'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const PORT = Number(argOf('port', process.env.RULES_PORT ?? 6001))
const HOST = argOf('host', process.env.RULES_BIND ?? '0.0.0.0')
const VERBOSE = argv.includes('--verbose')

const stats = { connections: 0, validated: 0, illegal: 0, errors: 0, startedAt: Date.now() }

/**
 * Trang thai cua the co SAU nuoc di, theo dung cac gia tri ma server cho.
 * `insufficient_material` la truong hop X29: het gio ma doi thu khong du quan
 * chieu het thi hoa, nen server phai biet dieu nay.
 */
function statusOf(board) {
  if (board.isCheckmate()) return 'checkmate'
  if (board.isStalemate()) return 'stalemate'
  if (board.isInsufficientMaterial()) return 'draw_insufficient'
  if (board.isThreefoldRepetition()) return 'draw_threefold'
  if (board.isDraw()) return 'draw_fifty'
  if (board.inCheck()) return 'check'
  return 'ongoing'
}

function validate(request) {
  const board = new Chess()
  try {
    board.load(request.fen)
  } catch (failure) {
    return { ok: false, code: cgp.ERR.MALFORMED_FRAME, reason: `FEN khong doc duoc: ${failure.message}` }
  }

  // chess.js mac dinh phong cap thanh Hau. Server KHONG duoc tu chon thay
  // nguoi choi (ngoai le X27), nen thieu `promo` o nuoc phong cap la loi.
  const piece = board.get(request.from)
  const isPromotion = piece?.type === 'p'
    && ((piece.color === 'w' && request.to[1] === '8') || (piece.color === 'b' && request.to[1] === '1'))
  if (isPromotion && !request.promo) {
    return { ok: false, code: cgp.ERR.PROMOTION_REQUIRED, reason: 'thieu quan phong cap' }
  }

  let move
  try {
    move = board.move({ from: request.from, to: request.to, promotion: request.promo || undefined })
  } catch {
    return { ok: false, code: cgp.ERR.ILLEGAL_MOVE, reason: 'nuoc di khong hop le voi the co nay' }
  }

  const status = statusOf(board)
  return {
    ok: true,
    payload: {
      legal: true,
      fenAfter: board.fen(),
      san: move.san,
      uci: move.from + move.to + (move.promotion ?? ''),
      flags: cgp.flagsFromMove(move, status),
      status,
      halfmove: Number(board.fen().split(' ')[4] ?? 0),
      threefold: board.isThreefoldRepetition(),
    },
  }
}

/**
 * Ben `side` co du quan de chieu het khong?
 *
 * Can rieng cau hoi nay cho luc HET GIO (X29): theo luat FIDE, het gio ma doi
 * thu khong the chieu het bang bat ky chuoi nuoc di hop le nao thi van la HOA
 * chu khong phai thua. `isInsufficientMaterial()` cua chess.js tra loi cho CA
 * VAN chu khong cho tung ben, nen o day phai tu dem.
 *
 * Vua, vua + 1 tinh, vua + 1 ma: khong chieu het duoc. Hai ma thi co the (du
 * khong ep duoc), nen tinh la du quan - dung nhu cach FIDE xu.
 */
function canMate(fen, side) {
  const board = new Chess()
  board.load(fen)
  let minors = 0
  for (const row of board.board()) {
    for (const square of row) {
      if (!square || square.color !== side) continue
      if (square.type === 'p' || square.type === 'r' || square.type === 'q') return true
      if (square.type === 'b' || square.type === 'n') minors += 1
    }
  }
  return minors >= 2
}

function legalMoves(fen) {
  const board = new Chess()
  board.load(fen)
  return board.moves({ verbose: true }).map(move => move.from + move.to + (move.promotion ?? ''))
}

function handleFrame(socket, frame) {
  const reply = (type, value) => socket.write(cgp.encodeFrame(type, frame.seq, cgp.json(value)))

  switch (frame.type) {
    case cgp.T.RULES_VALIDATE: {
      const request = cgp.parseJson(frame.payload)
      const outcome = validate(request)
      if (outcome.ok) {
        stats.validated += 1
        reply(cgp.T.RULES_OK, outcome.payload)
      } else if (outcome.code === cgp.ERR.ILLEGAL_MOVE || outcome.code === cgp.ERR.PROMOTION_REQUIRED) {
        stats.illegal += 1
        reply(cgp.T.RULES_ILLEGAL, { legal: false, code: outcome.code, reason: outcome.reason })
      } else {
        stats.errors += 1
        reply(cgp.T.RULES_ERROR, { code: outcome.code, message: outcome.reason })
      }
      if (VERBOSE) console.log(`  VALIDATE ${request.from}${request.to} -> ${outcome.ok ? outcome.payload.san : outcome.reason}`)
      break
    }

    case cgp.T.RULES_LEGAL_MOVES: {
      const { fen } = cgp.parseJson(frame.payload)
      reply(cgp.T.RULES_LEGAL_MOVES_RESULT, { moves: legalMoves(fen) })
      break
    }

    case cgp.T.RULES_MATERIAL: {
      const { fen, side } = cgp.parseJson(frame.payload)
      try {
        reply(cgp.T.RULES_OK, { sufficient: canMate(fen, side === 'b' ? 'b' : 'w') })
      } catch (failure) {
        stats.errors += 1
        reply(cgp.T.RULES_ERROR, { code: cgp.ERR.MALFORMED_FRAME, message: failure.message })
      }
      break
    }

    case cgp.T.RULES_PING:
      reply(cgp.T.RULES_OK, { pong: true, uptimeMs: Date.now() - stats.startedAt, ...stats })
      break

    default:
      stats.errors += 1
      reply(cgp.T.RULES_ERROR, {
        code: cgp.ERR.UNKNOWN_TYPE,
        message: `loai message khong phuc vu: ${cgp.typeName(frame.type)}`,
      })
  }
}

const server = net.createServer(socket => {
  const id = ++stats.connections
  socket.setNoDelay(true)                      // nuoc di nho, khong cho gom goi Nagle
  const accumulator = new cgp.FrameAccumulator()
  if (VERBOSE) console.log(`+ ket noi #${id} tu ${socket.remoteAddress}`)

  socket.on('data', chunk => {
    try {
      for (const frame of accumulator.push(chunk)) handleFrame(socket, frame)
    } catch (failure) {
      // Frame hong chi giet ket noi do, khong duoc lam sap service (X06).
      stats.errors += 1
      console.error(`! ket noi #${id}: ${failure.message}`)
      try {
        socket.write(cgp.encodeFrame(cgp.T.RULES_ERROR, 0,
          cgp.json({ code: failure.code ?? cgp.ERR.INTERNAL_ERROR, message: failure.message })))
      } catch { /* socket co the da dong */ }
      socket.destroy()
    }
  })

  socket.on('error', failure => {
    if (VERBOSE) console.error(`! ket noi #${id}: ${failure.message}`)
  })
  socket.on('close', () => { if (VERBOSE) console.log(`- dong ket noi #${id}`) })
})

server.on('error', failure => {
  console.error(`Khong mo duoc cong ${PORT}: ${failure.message}`)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`Rules Service | RVP v1.0 | ${HOST}:${PORT} | chess.js`)
  console.log('Cho RULES_VALIDATE / RULES_LEGAL_MOVES / RULES_PING')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nDung lai. Da kiem tra ${stats.validated} nuoc hop le, ${stats.illegal} nuoc bi tu choi.`)
    server.close(() => process.exit(0))
  })
}
