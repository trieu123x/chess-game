/**
 * Bot cờ chạy trong trình duyệt (Stockfish 18 lite, WebAssembly, một luồng).
 *
 * CODE CỦA NHÓM, dựng trên module engine kế thừa từ upstream
 * (`engine/stockfishWorker.ts`, `engine/profiles.ts`, `engine/uci.ts`).
 *
 * Khác với upstream: upstream dùng engine để **phân tích** ván đấu (nhiều biến,
 * điểm đánh giá, review cả ván). Ở đây nhóm chỉ cần một **đối thủ**: một hàm
 * `bestMove(fen, history)` trả về đúng một nước đi, có mức độ khó, có huỷ giữa
 * chừng và có timeout — nên nhóm viết lại vòng đời worker thay vì kéo theo cả
 * tầng phân tích của upstream.
 *
 * Bản chất là một dịch vụ bất đồng bộ giống Rules Service phía server: gửi
 * lệnh, chờ phản hồi có tương quan, có timeout và có đường thoát khi hỏng.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createStockfishWorker, type StockfishWorkerHandle } from '../engine/stockfishWorker'
import { engineStartupTimeoutMs } from '../engine/engineStartup'
import { profileById } from '../engine/profiles'
import { buildGoCommand, buildPositionCommand, parseBestMoveLine } from '../engine/uci'
import { botLevelById, type BotLevelId } from './difficulty'

/**
 * Bản lite một luồng: chạy được mà không cần header COOP/COEP, nên mở bằng
 * `npm run dev`, qua nginx trong Docker hay mở file tĩnh đều như nhau.
 */
const PROFILE = profileById('lite-single-local')

export type BotStatus = 'idle' | 'booting' | 'ready' | 'thinking' | 'failed'

type Pending = {
  resolve: (move: string | null) => void
  timer: ReturnType<typeof setTimeout>
}

export function useChessBot() {
  const [status, setStatus] = useState<BotStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [lastThinkMs, setLastThinkMs] = useState<number | null>(null)

  const handle = useRef<StockfishWorkerHandle | null>(null)
  const pending = useRef<Pending | null>(null)
  const readyWaiters = useRef<Array<() => void>>([])

  const settle = useCallback((move: string | null) => {
    const current = pending.current
    if (!current) return
    clearTimeout(current.timer)
    pending.current = null
    setStatus('ready')
    current.resolve(move)
  }, [])

  /** Khởi động engine. Gọi được nhiều lần; lần sau dùng lại worker đã có. */
  const boot = useCallback(async (): Promise<boolean> => {
    if (handle.current) return status !== 'failed'
    setStatus('booting')
    setError(null)

    try {
      const created = createStockfishWorker(PROFILE)
      handle.current = created

      created.worker.onmessage = event => {
        const line = String(event.data ?? '')

        if (line.startsWith('__BOOT_ERROR__:')) {
          setError(line.slice('__BOOT_ERROR__:'.length))
          setStatus('failed')
          settle(null)
          return
        }
        if (line.startsWith('uciok') || line.startsWith('readyok')) {
          readyWaiters.current.forEach(waiter => waiter())
          readyWaiters.current = []
          return
        }
        const best = parseBestMoveLine(line)
        if (best) settle(best.bestMove)
      }

      created.worker.onerror = event => {
        setError(event.message || 'Worker lỗi')
        setStatus('failed')
        settle(null)
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Engine không phản hồi trong thời gian cho phép')),
          engineStartupTimeoutMs(PROFILE),
        )
        readyWaiters.current.push(() => { clearTimeout(timer); resolve() })
        created.worker.postMessage('uci')
      })

      setStatus('ready')
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setStatus('failed')
      return false
    }
  }, [status, settle])

  /**
   * Xin engine một nước đi.
   *
   * Trả về `null` nếu engine hỏng hoặc quá hạn — người gọi phải xử lý được
   * trường hợp đó thay vì treo ván (cùng nguyên tắc với X44: một dịch vụ phụ
   * chết thì ván vẫn phải sống).
   */
  const bestMove = useCallback(async (
    fen: string,
    levelId: BotLevelId,
  ): Promise<string | null> => {
    const engine = handle.current
    if (!engine || status === 'failed') return null
    // Yeu cau cu chua xong (engine treo hoac phan hoi den muon): huy no truoc,
    // khong de bot ket cung mai mai.
    if (pending.current) {
      engine.worker.postMessage('stop')
      settle(null)
    }

    const level = botLevelById(levelId)
    const startedAt = performance.now()
    setStatus('thinking')

    engine.worker.postMessage(`setoption name Skill Level value ${level.skill}`)
    engine.worker.postMessage(buildPositionCommand(fen))
    engine.worker.postMessage(buildGoCommand('custom', {
      movetime: level.movetimeMs,
      depth: level.depth,
    }))

    return new Promise<string | null>(resolve => {
      const timer = setTimeout(() => {
        // Quá hạn: bảo engine dừng, ván vẫn tiếp tục bằng kết quả tốt nhất nó có.
        engine.worker.postMessage('stop')
        settle(null)
      }, level.movetimeMs + 5_000)

      pending.current = {
        timer,
        resolve: move => {
          setLastThinkMs(Math.round(performance.now() - startedAt))
          resolve(move)
        },
      }
    })
  }, [status, settle])

  const newGame = useCallback(() => {
    handle.current?.worker.postMessage('ucinewgame')
  }, [])

  const stop = useCallback(() => {
    handle.current?.worker.postMessage('stop')
    settle(null)
  }, [settle])

  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current.timer)
    handle.current?.worker.terminate()
    if (handle.current?.blobUrl) URL.revokeObjectURL(handle.current.blobUrl)
    handle.current = null
  }, [])

  return { status, error, lastThinkMs, boot, bestMove, newGame, stop }
}
