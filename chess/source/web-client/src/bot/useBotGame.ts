/**
 * Ván cờ chạy hoàn toàn trong trình duyệt: đấu với bot, hoặc hai người cùng máy.
 *
 * CODE CỦA NHÓM. Vai trò trong đồ án:
 *  1. Kiểm thử giao diện khi Game Server (Java) chưa chạy.
 *  2. Phương án dự phòng khi demo mất mạng (ngoại lệ X64 trong PLAN.md §7).
 *  3. Đối chứng cho phần thảo luận: cùng một giao diện, một bên mọi quyết định
 *     nằm ở client, một bên mọi quyết định nằm ở server — làm rõ ý nghĩa của
 *     kiến trúc server-authoritative.
 *
 * Chế độ này KHÔNG dùng để lấy số liệu cho E1–E8: nó không đi qua mạng.
 */
import { Chess } from 'chess.js'
import { useCallback, useRef, useState } from 'react'
import type { GameView } from '../net/useGameConnection'
import { parseTimeControl } from '../net/timeControl'
import { botLevelById, type BotLevelId } from './difficulty'
import type { useChessBot } from './useChessBot'

export type LocalOpponent = 'bot' | 'human'

type BotApi = ReturnType<typeof useChessBot>

export function useBotGame(bot: BotApi) {
  const chess = useRef(new Chess())
  const lastMoveAt = useRef(Date.now())
  const opponent = useRef<LocalOpponent>('bot')
  const level = useRef<BotLevelId>('casual')
  const playerColor = useRef<'w' | 'b'>('w')

  const [game, setGame] = useState<GameView | null>(null)
  const [thinking, setThinking] = useState(false)

  /** Trừ giờ cho bên vừa đi xong, cộng increment. Không có server nên client tự tính. */
  const chargeClock = useCallback((view: GameView, mover: 'w' | 'b'): GameView => {
    const control = parseTimeControl(view.timeControl)
    const now = Date.now()
    const elapsed = now - lastMoveAt.current
    lastMoveAt.current = now

    const remaining = Math.max(0,
      (mover === 'w' ? view.clockWhiteMs : view.clockBlackMs) - elapsed + control.incrementMs)

    return {
      ...view,
      clockWhiteMs: mover === 'w' ? remaining : view.clockWhiteMs,
      clockBlackMs: mover === 'b' ? remaining : view.clockBlackMs,
      over: remaining === 0
        ? { result: mover === 'w' ? '0-1' : '1-0', reason: 'timeout', eloDelta: 0 }
        : view.over,
    }
  }, [])

  const describeEnd = useCallback((): GameView['over'] => {
    if (!chess.current.isGameOver()) return null
    if (chess.current.isCheckmate()) {
      return { result: chess.current.turn() === 'b' ? '1-0' : '0-1', reason: 'checkmate', eloDelta: 0 }
    }
    const reason = chess.current.isStalemate() ? 'stalemate'
      : chess.current.isInsufficientMaterial() ? 'insufficient_material'
      : chess.current.isThreefoldRepetition() ? 'draw_threefold'
      : 'draw_fifty'
    return { result: '1/2-1/2', reason, eloDelta: 0 }
  }, [])

  const applyMove = useCallback((from: string, to: string, promo?: string): boolean => {
    try {
      chess.current.move({ from, to, promotion: promo ?? 'q' })
    } catch {
      return false
    }
    const mover: 'w' | 'b' = chess.current.turn() === 'w' ? 'b' : 'w'
    setGame(previous => {
      if (!previous) return previous
      const moved: GameView = {
        ...previous,
        fen: chess.current.fen(),
        ply: previous.ply + 1,
        moves: chess.current.history(),
        turn: chess.current.turn(),
        lastMove: { from, to },
        over: describeEnd(),
      }
      return chargeClock(moved, mover)
    })
    return true
  }, [chargeClock, describeEnd])

  /** Nước trả lời của bot. Bot hỏng hoặc quá hạn thì ván vẫn sống, chỉ báo lỗi. */
  const botReply = useCallback(async () => {
    if (opponent.current !== 'bot' || chess.current.isGameOver()) return
    setThinking(true)
    // Gui THE CO HIEN TAI. buildPositionCommand chi dung history khi co rootFen;
    // truyen FEN hien tai la du va khong phu thuoc vao thu tu nuoc di.
    const uci = await bot.bestMove(chess.current.fen(), level.current)
    setThinking(false)
    if (!uci) return
    if (!applyMove(uci.slice(0, 2), uci.slice(2, 4), uci.length > 4 ? uci[4] : undefined)) {
      console.warn('[bot] engine tra ve nuoc khong ap dung duoc:', uci, chess.current.fen())
    }
  }, [bot, applyMove])

  const start = useCallback(async (
    timeControl: string,
    color: 'w' | 'b',
    opponentKind: LocalOpponent,
    levelId: BotLevelId,
  ) => {
    chess.current = new Chess()
    lastMoveAt.current = Date.now()
    opponent.current = opponentKind
    level.current = levelId
    playerColor.current = color

    const control = parseTimeControl(timeControl)
    setGame({
      gameId: 0,
      color,
      opponent: opponentKind === 'bot'
        ? `Bot ${botLevelById(levelId).label} (~${botLevelById(levelId).approxElo})`
        : 'Người cùng máy',
      timeControl,
      fen: chess.current.fen(),
      ply: 0,
      moves: [],
      clockWhiteMs: control.initialMs,
      clockBlackMs: control.initialMs,
      turn: 'w',
      lastMove: null,
      over: null,
      peerOnline: true,
    })

    if (opponentKind === 'bot') {
      const booted = await bot.boot()
      bot.newGame()
      if (booted && color === 'b') void botReply()
    }
  }, [bot, botReply])

  const playMove = useCallback((from: string, to: string, promo?: string): boolean => {
    if (thinking) return false
    if (!applyMove(from, to, promo)) return false
    if (opponent.current === 'bot') void botReply()
    return true
  }, [thinking, applyMove, botReply])

  const stop = useCallback(() => {
    bot.stop()
    setGame(null)
    setThinking(false)
  }, [bot])

  const resign = useCallback(() => {
    setGame(previous => previous && {
      ...previous,
      over: { result: previous.color === 'w' ? '0-1' : '1-0', reason: 'resign', eloDelta: 0 },
    })
  }, [])

  return {
    game,
    thinking,
    /** Ở chế độ đấu bot chỉ được đi quân của mình; hai người cùng máy thì đi cả hai bên. */
    canMove: game !== null && !game.over && !thinking
      && (opponent.current === 'human' || game.turn === playerColor.current),
    board: chess.current,
    start,
    playMove,
    resign,
    stop,
  }
}
