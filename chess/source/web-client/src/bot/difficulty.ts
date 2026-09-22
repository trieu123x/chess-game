/**
 * Các mức độ khó của bot cờ.
 *
 * CODE CỦA NHÓM. Upstream chỉ có 3 mức gắn với chế độ phân tích của nó; ở đây
 * nhóm định nghĩa lại theo hướng "đối thủ luyện tập" cho hệ thống online:
 * mỗi mức là một bộ ba (Skill Level của UCI, thời gian suy nghĩ, độ sâu tối đa)
 * đã cân để ván không bị kéo dài khi demo.
 *
 * Skill Level của Stockfish chạy 0..20; dưới 10 engine cố tình đi sai để mô
 * phỏng người chơi yếu, nên dùng nó thay vì chỉ giảm độ sâu — giảm độ sâu
 * không làm engine "yếu" mà chỉ làm nó "nhanh".
 */

export type BotLevelId = 'beginner' | 'casual' | 'club' | 'strong'

export type BotLevel = {
  id: BotLevelId
  label: string
  blurb: string
  /** UCI "Skill Level", 0..20. */
  skill: number
  /** Thời gian tối đa cho một nước, ms. */
  movetimeMs: number
  /** Trần độ sâu, để mức yếu không vô tình đánh quá hay khi thế cờ đơn giản. */
  depth: number
  /** Elo ước lượng, chỉ để hiển thị. */
  approxElo: number
}

export const BOT_LEVELS: BotLevel[] = [
  { id: 'beginner', label: 'Tập sự', blurb: 'Đi nhanh, hay bỏ sót', skill: 1, movetimeMs: 200, depth: 4, approxElo: 800 },
  { id: 'casual', label: 'Thường', blurb: 'Đủ để luyện khai cuộc', skill: 6, movetimeMs: 400, depth: 8, approxElo: 1200 },
  { id: 'club', label: 'Câu lạc bộ', blurb: 'Trừng phạt nước đi ẩu', skill: 13, movetimeMs: 800, depth: 14, approxElo: 1800 },
  { id: 'strong', label: 'Mạnh', blurb: 'Gần hết sức của bản lite', skill: 20, movetimeMs: 1500, depth: 20, approxElo: 2400 },
]

export const DEFAULT_BOT_LEVEL: BotLevelId = 'casual'

export function botLevelById(id: BotLevelId): BotLevel {
  return BOT_LEVELS.find(level => level.id === id) ?? BOT_LEVELS[1]
}
