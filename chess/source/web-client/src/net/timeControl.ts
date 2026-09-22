/**
 * Quy đổi chuỗi time control của protocol ("300+2") sang kiểu TimeControl mà
 * component đồng hồ kế thừa từ upstream đang dùng.
 *
 * CODE CỦA NHÓM.
 */
import type { ClockSide, ClockState, TimeControl } from '../engine/chessClock'

/** "300+2" = 300 giây + 2 giây cộng thêm mỗi nước. */
export function parseTimeControl(value: string): TimeControl {
  const [base, increment] = value.split('+')
  const initialMs = (Number(base) || 300) * 1000
  const incrementMs = (Number(increment) || 0) * 1000
  return { initialMs, incrementMs }
}

export function formatTimeControl(control: TimeControl): string {
  return `${Math.round(control.initialMs / 1000)}+${Math.round(control.incrementMs / 1000)}`
}

/**
 * Dựng ClockState từ số liệu server gửi về.
 *
 * Server là nguồn chân lý: `whiteMs`/`blackMs` là giá trị server đã trừ xong,
 * còn `since` chỉ để component đếm tiếp trên màn hình giữa hai nước đi. Không
 * có phép trừ giờ nào xảy ra ở client (đóng góp N2).
 */
export function clockStateFromServer(
  control: TimeControl,
  whiteMs: number,
  blackMs: number,
  running: ClockSide | null,
  receivedAt = Date.now(),
): ClockState {
  return { control, whiteMs, blackMs, running, since: running ? receivedAt : null, flagged: null }
}
