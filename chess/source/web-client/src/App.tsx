/**
 * DCGS Web Client — vỏ ứng dụng.
 *
 * CODE CỦA NHÓM. Các component bàn cờ, đồng hồ, âm thanh, engine Stockfish và
 * toàn bộ CSS kế thừa từ Sir-Teo/web-chess (MIT) — chi tiết từng file trong
 * NOTICE.md. `App.tsx` gốc của upstream (9150 dòng, phục vụ phân tích offline)
 * không được dùng; file này viết mới cho ba chế độ:
 *
 *   1. ONLINE  – chơi qua Game Server (Java) bằng protocol CGP, server là
 *                nguồn chân lý về nước đi và thời gian.
 *   2. VS BOT  – đấu Stockfish ngay trong trình duyệt, mọi quyết định ở client.
 *   3. HOT-SEAT– hai người trên cùng một máy.
 *
 * Chế độ 2 và 3 tồn tại để kiểm thử giao diện khi server chưa chạy, để dự phòng
 * lúc demo (X64), và để đối chiếu "quyết định ở client" với "quyết định ở
 * server" trong phần thảo luận của báo cáo.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Square } from 'chess.js'
import type { PieceDropHandlerArgs } from 'react-chessboard'
import { BoardCanvas } from './components/BoardCanvas'
import { ChessClock } from './components/ChessClock'
import { BOARD_THEMES } from './engine/boardThemes'
import { TIME_CONTROL_PRESETS } from './engine/chessClock'
import { materialAdvantageLabel, materialBalance } from './engine/material'
import { moveSoundFor } from './engine/moveSound'
import { useMoveSound } from './hooks/useMoveSound'
import { useGameConnection } from './net/useGameConnection'
import { clockStateFromServer, formatTimeControl, parseTimeControl } from './net/timeControl'
import { useChessBot } from './bot/useChessBot'
import { useBotGame, type LocalOpponent } from './bot/useBotGame'
import { BOT_LEVELS, DEFAULT_BOT_LEVEL, type BotLevelId } from './bot/difficulty'
import './App.css'
import './online.css'

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL ?? 'ws://localhost:8080'
const PLAYABLE_PRESETS = TIME_CONTROL_PRESETS.filter(preset => preset.control !== null)
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

type Mode = 'menu' | 'online' | 'local'

export default function App() {
  const online = useGameConnection(GATEWAY_URL)
  const bot = useChessBot()
  const local = useBotGame(bot)

  const [mode, setMode] = useState<Mode>('menu')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [opponentKind, setOpponentKind] = useState<LocalOpponent>('bot')
  const [level, setLevel] = useState<BotLevelId>(DEFAULT_BOT_LEVEL)
  const [side, setSide] = useState<'w' | 'b'>('w')
  const [timeControl, setTimeControl] = useState('300+2')
  const [themeIndex, setThemeIndex] = useState(0)
  const [soundOn, setSoundOn] = useState(true)
  const [selected, setSelected] = useState<Square | null>(null)
  const [boardWidth, setBoardWidth] = useState(() => boardWidthFor(window.innerWidth, window.innerHeight))

  const playSound = useMoveSound(soundOn)
  const theme = BOARD_THEMES[themeIndex] ?? BOARD_THEMES[0]

  useEffect(() => {
    const onResize = () => setBoardWidth(boardWidthFor(window.innerWidth, window.innerHeight))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const isLocal = mode === 'local'
  const game = isLocal ? local.game : online.game
  const board = isLocal ? local.board : online.board
  const playMove = isLocal ? local.playMove : online.playMove

  // Âm thanh phát theo nước đi cuối, ở cả hai chế độ.
  const lastSan = game?.moves.at(-1)
  useEffect(() => {
    if (!lastSan) return
    playSound(moveSoundFor({ flags: '', san: lastSan, isGameOver: Boolean(game?.over) }))
  }, [lastSan, game?.over, playSound])

  const legalTargets = useMemo<Square[]>(() => {
    if (!selected || !game) return []
    return board.moves({ square: selected, verbose: true }).map(move => move.to as Square)
  }, [selected, game, board])

  const clockState = useMemo(() => {
    if (!game) return null
    const control = parseTimeControl(game.timeControl)
    return clockStateFromServer(control, game.clockWhiteMs, game.clockBlackMs, game.over ? null : game.turn)
  }, [game])

  const material = useMemo(() => {
    if (!game) return null
    const balance = materialBalance(START_FEN, game.fen)
    return materialAdvantageLabel(balance.delta, game.color)
  }, [game])

  const myTurn = isLocal ? local.canMove : Boolean(game && !game.over && game.turn === game.color)

  const tryMove = useCallback((from: string, to: string) => {
    const piece = board.get(from as Square)
    const promoting = piece?.type === 'p' && (to[1] === '8' || to[1] === '1')
    const ok = playMove(from, to, promoting ? 'q' : undefined)
    setSelected(null)
    return ok
  }, [board, playMove])

  const onPieceDrop = useCallback(({ sourceSquare, targetSquare }: PieceDropHandlerArgs) => {
    if (!myTurn || !targetSquare) return false
    return tryMove(sourceSquare, targetSquare)
  }, [myTurn, tryMove])

  const onSquareClick = useCallback((square: Square) => {
    if (!myTurn) return
    if (selected && legalTargets.includes(square)) { tryMove(selected, square); return }
    const piece = board.get(square)
    const movable = isLocal ? piece?.color === board.turn() : piece?.color === game?.color
    setSelected(movable ? square : null)
  }, [myTurn, selected, legalTargets, board, game, isLocal, tryMove])

  // ---------------------------------------------------------------- MENU
  if (mode === 'menu') {
    return (
      <Shell status="Chưa kết nối" rtt={null}>
        <section className="dcgs-card dcgs-login">
          <h1>Distributed Chess Game Server</h1>
          <p className="dcgs-sub">Chọn chế độ chơi.</p>

          <h2 className="dcgs-h2">Chơi online</h2>
          <p className="dcgs-sub">Ghép cặp qua Game Server. Gateway: <code>{GATEWAY_URL}</code></p>
          <form onSubmit={event => { event.preventDefault(); setMode('online'); online.login(username, password) }}>
            <label>Tài khoản
              <input value={username} onChange={event => setUsername(event.target.value)} required minLength={3} maxLength={32} />
            </label>
            <label>Mật khẩu
              <input type="password" value={password} onChange={event => setPassword(event.target.value)} required />
            </label>
            <button type="submit" className="dcgs-primary">Kết nối &amp; đăng nhập</button>
          </form>
          {online.error && <p className="dcgs-error">{online.error}</p>}

          <hr className="dcgs-sep" />

          <h2 className="dcgs-h2">Chơi ngoại tuyến</h2>
          <div className="dcgs-field">
            <span>Đối thủ</span>
            <div className="dcgs-chips">
              <button className={chipClass(opponentKind === 'bot')} onClick={() => setOpponentKind('bot')}>Máy (Stockfish)</button>
              <button className={chipClass(opponentKind === 'human')} onClick={() => setOpponentKind('human')}>Hai người cùng máy</button>
            </div>
          </div>

          {opponentKind === 'bot' && (
            <div className="dcgs-field">
              <span>Độ khó</span>
              <div className="dcgs-chips">
                {BOT_LEVELS.map(item => (
                  <button key={item.id} className={chipClass(level === item.id)} onClick={() => setLevel(item.id)}
                    title={`${item.blurb} · Skill ${item.skill} · ${item.movetimeMs} ms`}>
                    {item.label} <small>~{item.approxElo}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="dcgs-field">
            <span>Bạn cầm</span>
            <div className="dcgs-chips">
              <button className={chipClass(side === 'w')} onClick={() => setSide('w')}>Trắng</button>
              <button className={chipClass(side === 'b')} onClick={() => setSide('b')}>Đen</button>
            </div>
          </div>

          <div className="dcgs-field">
            <span>Thể thức</span>
            <div className="dcgs-chips">
              {PLAYABLE_PRESETS.map(preset => {
                const value = formatTimeControl(preset.control!)
                return (
                  <button key={preset.id} className={chipClass(timeControl === value)} onClick={() => setTimeControl(value)}>
                    {preset.label}
                  </button>
                )
              })}
            </div>
          </div>

          <button className="dcgs-primary" onClick={() => { setMode('local'); void local.start(timeControl, side, opponentKind, level) }}>
            Bắt đầu ván ngoại tuyến
          </button>
          {bot.status === 'failed' && <p className="dcgs-error">Không khởi động được engine: {bot.error}</p>}
        </section>
      </Shell>
    )
  }

  // ---------------------------------------------------------------- LOBBY
  if (mode === 'online' && !game) {
    const queued = online.status === 'queued'
    return (
      <Shell status={statusLabel(online.status)} rtt={online.rttMs}>
        <section className="dcgs-card">
          <h2>Chọn thể thức</h2>
          <div className="dcgs-presets">
            {PLAYABLE_PRESETS.map(preset => {
              const value = formatTimeControl(preset.control!)
              return (
                <button key={preset.id} className="dcgs-preset" disabled={queued} onClick={() => online.joinQueue(value)}>
                  <strong>{preset.label}</strong>
                  <span>{preset.blurb}</span>
                </button>
              )
            })}
          </div>
          {queued && (
            <div className="dcgs-queued">
              <span className="dcgs-spinner" /> Đang tìm đối thủ…
              <button className="dcgs-ghost" onClick={online.leaveQueue}>Huỷ</button>
            </div>
          )}
          {online.profile && <p className="dcgs-sub">{online.profile.username} · Elo {online.profile.elo}</p>}
          {online.error && <p className="dcgs-error">{online.error}</p>}
          <button className="dcgs-ghost" onClick={() => { online.disconnect(); setMode('menu') }}>Về menu</button>
        </section>
        <EventLog lines={online.log} />
      </Shell>
    )
  }

  // ---------------------------------------------------------------- BÀN CỜ
  const orientation = game?.color === 'b' ? 'black' : 'white'
  return (
    <Shell status={isLocal ? localStatus(bot.status, local.thinking) : statusLabel(online.status)}
           rtt={isLocal ? null : online.rttMs}>
      <div className="dcgs-game">
        <div className="dcgs-board">
          <BoardCanvas
            position={game?.fen ?? 'start'}
            orientation={orientation}
            width={boardWidth}
            notationFontSize={`${Math.max(10, Math.round(boardWidth / 32))}px`}
            theme={theme}
            previewMove={undefined}
            lastMove={null}
            premove={null}
            markedSquares={{}}
            selectedSquare={selected}
            legalTargets={legalTargets}
            arrows={[]}
            allowDrawingArrows={false}
            allowDragging={myTurn}
            reduceMotion={false}
            onPieceDrop={onPieceDrop}
            onSquareClick={onSquareClick}
            onSquareMouseDown={undefined}
            onSquareMouseUp={undefined}
          />
          <div className="dcgs-boardbar">
            <button className="dcgs-ghost" onClick={() => setThemeIndex((themeIndex + 1) % BOARD_THEMES.length)}>
              Màu bàn: {theme.label}
            </button>
            <button className="dcgs-ghost" onClick={() => setSoundOn(!soundOn)}>
              Âm thanh: {soundOn ? 'bật' : 'tắt'}
            </button>
          </div>
        </div>

        <aside className="dcgs-side">
          {clockState && <ChessClock state={clockState} paused={Boolean(game?.over)} orientation={orientation} />}

          <div className="dcgs-card dcgs-meta">
            <div className="dcgs-row"><span>Chế độ</span><strong>{isLocal ? 'Ngoại tuyến' : 'Online'}</strong></div>
            {!isLocal && <div className="dcgs-row"><span>Ván</span><strong>#{game?.gameId}</strong></div>}
            <div className="dcgs-row"><span>Đối thủ</span><strong>{game?.opponent}</strong></div>
            <div className="dcgs-row"><span>Bạn cầm</span><strong>{game?.color === 'w' ? 'Trắng' : 'Đen'}</strong></div>
            <div className="dcgs-row"><span>Nước thứ</span><strong>{game?.ply}</strong></div>
            {material && <div className="dcgs-row"><span>Quân</span><strong>{material}</strong></div>}
            {isLocal && bot.lastThinkMs !== null && (
              <div className="dcgs-row"><span>Engine nghĩ</span><strong>{bot.lastThinkMs} ms</strong></div>
            )}
            {local.thinking && <p className="dcgs-sub"><span className="dcgs-spinner" /> Máy đang tính…</p>}
            {!isLocal && game && !game.peerOnline && <p className="dcgs-warn">Đối thủ mất kết nối — đang chờ nối lại…</p>}
            {game?.over && (
              <p className="dcgs-result">
                {game.over.result} — {reasonLabel(game.over.reason)}
                {game.over.eloDelta ? ` (Elo ${game.over.eloDelta > 0 ? '+' : ''}${game.over.eloDelta})` : ''}
              </p>
            )}
          </div>

          <MoveList moves={game?.moves ?? []} />

          <div className="dcgs-actions">
            {!game?.over && !isLocal && <button className="dcgs-ghost" onClick={online.offerDraw}>Xin hoà</button>}
            {!game?.over && (
              <button className="dcgs-danger" onClick={() => (isLocal ? local.resign() : online.resign())}>Đầu hàng</button>
            )}
          </div>
          <button className="dcgs-ghost" onClick={() => {
            if (isLocal) local.stop(); else online.disconnect()
            setMode('menu')
          }}>Về menu</button>

          {!isLocal && online.error && <p className="dcgs-error" onClick={online.clearError}>{online.error}</p>}
          {isLocal && bot.error && <p className="dcgs-error">Engine: {bot.error}</p>}
        </aside>
      </div>
      {!isLocal && <EventLog lines={online.log} />}
    </Shell>
  )
}

function Shell({ status, rtt, children }: { status: string; rtt: number | null; children: React.ReactNode }) {
  return (
    <div className="dcgs-shell">
      <header className="dcgs-header">
        <span className="dcgs-brand">DCGS</span>
        <span className="dcgs-status">{status}</span>
        {rtt !== null && <span className="dcgs-rtt" title="Khứ hồi tới server, đo bằng CLOCK_PING">RTT {rtt} ms</span>}
      </header>
      <main>{children}</main>
    </div>
  )
}

function MoveList({ moves }: { moves: string[] }) {
  const pairs: Array<[string, string | undefined]> = []
  for (let index = 0; index < moves.length; index += 2) pairs.push([moves[index], moves[index + 1]])
  return (
    <div className="dcgs-card dcgs-moves">
      <h3>Biên bản</h3>
      <ol>
        {pairs.map(([white, black], index) => (
          <li key={index}><span className="dcgs-no">{index + 1}.</span> <b>{white}</b> {black && <b>{black}</b>}</li>
        ))}
        {!pairs.length && <li className="dcgs-sub">Chưa có nước đi</li>}
      </ol>
    </div>
  )
}

/** Nhật ký message CGP — dùng khi demo để chỉ ra luồng giao tiếp thật. */
function EventLog({ lines }: { lines: string[] }) {
  if (!lines.length) return null
  return (
    <details className="dcgs-card dcgs-log" open>
      <summary>Nhật ký giao thức ({lines.length})</summary>
      <ul>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
    </details>
  )
}

const chipClass = (active: boolean) => (active ? 'dcgs-chip dcgs-chip-on' : 'dcgs-chip')

function boardWidthFor(width: number, height: number): number {
  const available = Math.min(width - 380, height - 160)
  return Math.max(280, Math.min(640, available > 0 ? available : width - 40))
}

function statusLabel(status: string): string {
  switch (status) {
    case 'connecting': return 'Đang kết nối…'
    case 'connected': return 'Đã kết nối'
    case 'authenticated': return 'Đã đăng nhập'
    case 'queued': return 'Đang chờ ghép cặp'
    case 'playing': return 'Đang thi đấu'
    case 'finished': return 'Ván đã kết thúc'
    default: return 'Chưa kết nối'
  }
}

function localStatus(botStatus: string, thinking: boolean): string {
  if (thinking) return 'Máy đang tính…'
  switch (botStatus) {
    case 'booting': return 'Đang nạp engine…'
    case 'ready': return 'Ngoại tuyến — engine sẵn sàng'
    case 'failed': return 'Ngoại tuyến — engine lỗi'
    default: return 'Ngoại tuyến'
  }
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    checkmate: 'chiếu hết', timeout: 'hết giờ', resign: 'đầu hàng',
    stalemate: 'hết nước đi', draw_fifty: 'luật 50 nước', draw_threefold: 'lặp 3 lần',
    insufficient_material: 'không đủ quân chiếu hết', draw: 'hoà', abort: 'huỷ ván',
  }
  return labels[reason] ?? reason
}
