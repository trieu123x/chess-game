/**
 * Kết nối tới Game Server qua Web Gateway (WebSocket mang frame CGP).
 *
 * CODE CỦA NHÓM. Xử lý: đăng nhập, hàng đợi ghép cặp, gửi/nhận nước đi,
 * heartbeat, đo RTT, tự nối lại + RESUME (ngoại lệ X01/X08/X14 trong PLAN.md §7).
 *
 * Server là nguồn chân lý: bàn cờ cục bộ chỉ được cập nhật khi nhận MOVE_APPLIED,
 * hoặc cập nhật lạc quan rồi ROLLBACK khi nhận MOVE_REJECTED.
 */
import { Chess } from 'chess.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CgpError, T, clockOffset, decodeClockPong, decodeFrame, decodeMoveApplied, encodeClockPing,
  encodeFrame, encodeMove, json, median, parseJson,
  type GameOver, type GameSnapshot, type LoginOk, type MatchFound, type MoveApplied,
  type MoveRejected, type PeerStatus, type ServerError,
} from './cgp'

export type Status = 'offline' | 'connecting' | 'connected' | 'authenticated' | 'queued' | 'playing' | 'finished'

export type GameView = {
  gameId: number
  color: 'w' | 'b'
  opponent: string
  timeControl: string
  fen: string
  ply: number
  moves: string[]
  clockWhiteMs: number
  clockBlackMs: number
  turn: 'w' | 'b'
  lastMove: { from: string; to: string } | null
  over: GameOver | null
  peerOnline: boolean
}

const HEARTBEAT_MS = 5_000
const CLOCK_PING_MS = 10_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const TOKEN_KEY = 'dcgs.sessionToken'

export function useGameConnection(url: string) {
  const [status, setStatus] = useState<Status>('offline')
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<LoginOk | null>(null)
  const [game, setGame] = useState<GameView | null>(null)
  const [rttMs, setRttMs] = useState<number | null>(null)
  const [log, setLog] = useState<string[]>([])

  const socket = useRef<WebSocket | null>(null)
  const seq = useRef(1)
  const chess = useRef(new Chess())
  const rttSamples = useRef<number[]>([])
  const reconnectAttempt = useRef(0)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const credentials = useRef<{ username: string; password: string } | null>(null)
  const wanted = useRef(false)

  const trace = useCallback((line: string) => {
    setLog(previous => [`${new Date().toLocaleTimeString()} ${line}`, ...previous].slice(0, 60))
  }, [])

  const send = useCallback((type: number, payload?: Uint8Array) => {
    const ws = socket.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(encodeFrame(type, seq.current++, payload))
    return true
  }, [])

  // ---- xử lý message từ server ----
  const handle = useCallback((type: number, payload: Uint8Array) => {
    switch (type) {
      case T.LOGIN_OK: {
        const ok = parseJson<LoginOk>(payload)
        sessionStorage.setItem(TOKEN_KEY, ok.sessionToken)
        setProfile(ok)
        setStatus('authenticated')
        setError(null)
        trace(`đăng nhập: ${ok.username} (Elo ${ok.elo})`)
        break
      }
      case T.MATCH_FOUND: {
        const match = parseJson<MatchFound>(payload)
        chess.current = new Chess()
        setGame({
          gameId: match.gameId, color: match.color, opponent: match.opponent,
          timeControl: match.timeControl, fen: chess.current.fen(), ply: 0, moves: [],
          clockWhiteMs: 0, clockBlackMs: 0, turn: 'w', lastMove: null, over: null, peerOnline: true,
        })
        setStatus('playing')
        trace(`ghép cặp: ván #${match.gameId} vs ${match.opponent}, bạn cầm ${match.color === 'w' ? 'Trắng' : 'Đen'}`)
        break
      }
      case T.GAME_SNAPSHOT: {
        const snapshot = parseJson<GameSnapshot>(payload)
        chess.current = new Chess(snapshot.fen)
        setGame(previous => previous && {
          ...previous,
          gameId: snapshot.gameId, fen: snapshot.fen, ply: snapshot.ply, moves: snapshot.moves,
          clockWhiteMs: snapshot.clockW, clockBlackMs: snapshot.clockB, turn: snapshot.turn,
        })
        setStatus(snapshot.status === 'FINISHED' ? 'finished' : 'playing')
        trace(`đồng bộ lại trạng thái ván tại nước ${snapshot.ply}`)
        break
      }
      case T.MOVE_APPLIED: {
        const applied: MoveApplied = decodeMoveApplied(payload)
        setGame(previous => {
          if (!previous) return previous
          // Nước của chính mình đã áp dụng lạc quan -> chỉ đồng bộ đồng hồ.
          if (applied.ply > previous.ply) {
            try {
              chess.current.move({ from: applied.from, to: applied.to, promotion: applied.promo || undefined })
            } catch {
              // Bàn cờ cục bộ lệch với server: xin lại snapshot thay vì đoán.
              send(T.HISTORY_REQ, json({ gameId: previous.gameId }))
            }
          }
          return {
            ...previous,
            fen: chess.current.fen(),
            ply: Math.max(previous.ply, applied.ply),
            moves: chess.current.history(),
            clockWhiteMs: applied.clockWhiteMs,
            clockBlackMs: applied.clockBlackMs,
            turn: chess.current.turn(),
            lastMove: { from: applied.from, to: applied.to },
          }
        })
        break
      }
      case T.MOVE_REJECTED: {
        const rejected = parseJson<MoveRejected>(payload)
        // Rollback nước đi lạc quan.
        chess.current.undo()
        setGame(previous => previous && {
          ...previous,
          fen: chess.current.fen(),
          ply: rejected.expectedPly,
          moves: chess.current.history(),
          turn: chess.current.turn(),
        })
        setError(`Nước đi bị từ chối (${rejected.code}): ${rejected.reason}`)
        trace(`MOVE_REJECTED ${rejected.code} ${rejected.reason}`)
        break
      }
      case T.GAME_OVER: {
        const over = parseJson<GameOver>(payload)
        setGame(previous => previous && { ...previous, over })
        setStatus('finished')
        trace(`kết thúc: ${over.result} (${over.reason})`)
        break
      }
      case T.PEER_STATUS: {
        const peer = parseJson<PeerStatus>(payload)
        setGame(previous => previous && { ...previous, peerOnline: peer.state === 'reconnected' })
        trace(`đối thủ ${peer.state === 'reconnected' ? 'đã nối lại' : `mất kết nối (ân hạn ${peer.graceMs / 1000}s)`}`)
        break
      }
      case T.CLOCK_PONG: {
        const { rttMs: sample } = clockOffset(decodeClockPong(payload), Date.now())
        rttSamples.current = [...rttSamples.current, sample].slice(-5)
        setRttMs(Math.round(median(rttSamples.current)))
        break
      }
      case T.DRAW_OFFERED:
        trace('đối thủ xin hoà')
        break
      case T.HEARTBEAT_ACK:
        break
      case T.ERROR: {
        const failure = parseJson<ServerError>(payload)
        setError(`Lỗi ${failure.code}: ${failure.message}`)
        trace(`ERROR ${failure.code} ${failure.message}`)
        if (failure.code === 1002) sessionStorage.removeItem(TOKEN_KEY)
        break
      }
      default:
        trace(`message lạ: 0x${type.toString(16)}`)
    }
  }, [send, trace])

  // ---- vòng đời kết nối ----
  const connect = useCallback(() => {
    wanted.current = true
    setStatus('connecting')
    setError(null)
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    socket.current = ws

    ws.onopen = () => {
      reconnectAttempt.current = 0
      setStatus('connected')
      const token = sessionStorage.getItem(TOKEN_KEY)
      const current = game
      if (token) {
        send(T.RESUME, json({ sessionToken: token, lastPly: current?.ply ?? 0 }))
        trace('gửi RESUME bằng session token')
      } else if (credentials.current) {
        send(T.LOGIN, json(credentials.current))
      }
    }

    ws.onmessage = event => {
      try {
        const frame = decodeFrame(event.data as ArrayBuffer)
        handle(frame.type, frame.payload)
      } catch (failure) {
        // Frame hỏng không được làm sập UI (ngoại lệ X06).
        setError(failure instanceof CgpError ? failure.message : String(failure))
      }
    }

    ws.onclose = () => {
      socket.current = null
      if (!wanted.current) { setStatus('offline'); return }
      // Backoff có jitter, chống bão reconnect (ngoại lệ X08).
      const attempt = ++reconnectAttempt.current
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)
      const jittered = delay * (0.5 + Math.random())
      setStatus('connecting')
      trace(`mất kết nối, thử lại sau ${Math.round(jittered)}ms (lần ${attempt})`)
      reconnectTimer.current = setTimeout(connect, jittered)
    }

    ws.onerror = () => setError('Không kết nối được tới gateway')
  }, [url, send, handle, trace, game])

  const disconnect = useCallback(() => {
    wanted.current = false
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    socket.current?.close()
    socket.current = null
    setStatus('offline')
  }, [])

  // heartbeat + đo RTT
  useEffect(() => {
    if (status === 'offline') return
    const beat = setInterval(() => send(T.HEARTBEAT), HEARTBEAT_MS)
    const ping = setInterval(() => send(T.CLOCK_PING, encodeClockPing(Date.now())), CLOCK_PING_MS)
    return () => { clearInterval(beat); clearInterval(ping) }
  }, [status, send])

  useEffect(() => () => { wanted.current = false; socket.current?.close() }, [])

  // ---- thao tác của người dùng ----
  const login = useCallback((username: string, password: string) => {
    credentials.current = { username, password }
    if (socket.current?.readyState === WebSocket.OPEN) send(T.LOGIN, json({ username, password }))
    else connect()
  }, [connect, send])

  const joinQueue = useCallback((timeControl: string) => {
    if (send(T.QUEUE_JOIN, json({ timeControl }))) {
      setStatus('queued')
      trace(`vào hàng đợi ${timeControl}`)
    }
  }, [send, trace])

  const leaveQueue = useCallback(() => {
    send(T.QUEUE_LEAVE)
    setStatus('authenticated')
  }, [send])

  /** Cập nhật lạc quan rồi chờ server xác nhận; bị từ chối thì rollback. */
  const playMove = useCallback((from: string, to: string, promo?: string): boolean => {
    if (!game || game.turn !== game.color) return false
    try {
      chess.current.move({ from, to, promotion: promo ?? 'q' })
    } catch {
      return false
    }
    const ply = game.ply + 1
    setGame(previous => previous && {
      ...previous,
      fen: chess.current.fen(), ply, moves: chess.current.history(),
      turn: chess.current.turn(), lastMove: { from, to },
    })
    send(T.MOVE, encodeMove({ from, to, promo, ply: game.ply }))
    return true
  }, [game, send])

  const resign = useCallback(() => send(T.RESIGN), [send])
  const offerDraw = useCallback(() => send(T.DRAW_OFFER), [send])
  const spectate = useCallback((gameId: number) => send(T.SPECTATE_JOIN, json({ gameId })), [send])

  return {
    status, error, profile, game, rttMs, log,
    connect, disconnect, login, joinQueue, leaveQueue, playMove, resign, offerDraw, spectate,
    board: chess.current,
    clearError: () => setError(null),
  }
}
