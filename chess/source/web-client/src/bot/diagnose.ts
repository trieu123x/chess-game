/**
 * Chẩn đoán engine cờ, chạy độc lập với giao diện React.
 *
 * CODE CỦA NHÓM. Mở `http://localhost:5173/bot-test.html` để kiểm tra nhanh
 * xem engine có nạp được và có trả về nước đi hợp lệ không — tách bạch lỗi
 * engine với lỗi UI, giống vai trò của `--check` ở Game Server.
 */
import { Chess } from 'chess.js'
import { createStockfishWorker } from '../engine/stockfishWorker'
import { profileById } from '../engine/profiles'
import { buildGoCommand, buildPositionCommand, parseBestMoveLine } from '../engine/uci'

const out = document.getElementById('out') as HTMLPreElement
const lines: string[] = []

function log(line: string, kind: 'info' | 'ok' | 'bad' = 'info') {
  lines.push(kind === 'ok' ? `[OK]  ${line}` : kind === 'bad' ? `[LOI] ${line}` : `      ${line}`)
  out.textContent = lines.join('\n')
  console.log(line)
}

type Result = { booted: boolean; moves: string[]; errors: string[] }
const result: Result = { booted: false, moves: [], errors: [] }
;(window as unknown as { __diagnose: Result }).__diagnose = result

async function run() {
  const profile = profileById('lite-single-local')
  log(`profile = ${profile.id}, worker = ${profile.workerPath}`)

  let handle
  try {
    handle = createStockfishWorker(profile)
  } catch (failure) {
    log(`không tạo được worker: ${failure}`, 'bad')
    result.errors.push(String(failure))
    return
  }

  const waiters: Array<(line: string) => boolean> = []
  handle.worker.onmessage = event => {
    const line = String(event.data ?? '')
    if (line.startsWith('__BOOT_ERROR__:')) {
      log(line, 'bad')
      result.errors.push(line)
      return
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i](line)) waiters.splice(i, 1)
    }
  }
  handle.worker.onerror = event => {
    log(`worker lỗi: ${event.message}`, 'bad')
    result.errors.push(event.message)
  }

  const expect = (match: (line: string) => boolean, what: string, timeoutMs: number) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`quá hạn chờ ${what} (${timeoutMs} ms)`)), timeoutMs)
      waiters.push(line => {
        if (!match(line)) return false
        clearTimeout(timer)
        resolve(line)
        return true
      })
    })

  try {
    handle.worker.postMessage('uci')
    await expect(line => line.startsWith('uciok'), 'uciok', 30_000)
    log('engine trả lời uciok', 'ok')

    handle.worker.postMessage('isready')
    await expect(line => line.startsWith('readyok'), 'readyok', 15_000)
    log('engine trả lời readyok', 'ok')
    result.booted = true

    // Chơi thử 6 nước: mỗi nước lấy FEN hiện tại rồi hỏi engine.
    const board = new Chess()
    handle.worker.postMessage('ucinewgame')
    handle.worker.postMessage('setoption name Skill Level value 6')

    for (let ply = 0; ply < 6; ply++) {
      const fen = board.fen()
      handle.worker.postMessage(buildPositionCommand(fen))
      handle.worker.postMessage(buildGoCommand('custom', { movetime: 300, depth: 8 }))
      const line = await expect(l => l.startsWith('bestmove'), 'bestmove', 10_000)
      const best = parseBestMoveLine(line)?.bestMove

      if (!best) {
        log(`nước ${ply + 1}: engine không trả về nước đi (${line})`, 'bad')
        result.errors.push(line)
        break
      }
      try {
        const applied = board.move({
          from: best.slice(0, 2),
          to: best.slice(2, 4),
          promotion: best.length > 4 ? best[4] : undefined,
        })
        result.moves.push(applied.san)
        log(`nước ${ply + 1}: ${best} -> ${applied.san}`, 'ok')
      } catch (failure) {
        log(`nước ${ply + 1}: engine trả ${best} nhưng không hợp lệ với FEN ${fen}`, 'bad')
        result.errors.push(String(failure))
        break
      }
    }

    log(result.errors.length ? 'KET LUAN: co loi' : `KET LUAN: engine hoat dong (${result.moves.join(' ')})`,
        result.errors.length ? 'bad' : 'ok')
  } catch (failure) {
    log(String(failure), 'bad')
    result.errors.push(String(failure))
  } finally {
    handle.worker.terminate()
    if (handle.blobUrl) URL.revokeObjectURL(handle.blobUrl)
  }
}

void run()
