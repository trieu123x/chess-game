/**
 * Kiem tra luong choi that trong giao dien React: nguoi di mot nuoc, bot phai
 * tra loi. Kiem tra ca ba duong: cam Trang, cam Den (bot di truoc), hot-seat.
 *
 * Chay:  npm run dev   (terminal khac)
 *        npm run check:app
 *
 * CODE CUA NHOM. Ket qua dung lam bang chung kiem thu trong phu luc bao cao.
 */
import { chromium } from 'playwright'

const url = process.env.APP_URL ?? 'http://localhost:5173'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', error => console.log(`  [pageerror] ${error.message}`))

const moveCount = () => page.evaluate(() => document.querySelectorAll('.dcgs-moves li b').length)
const record = () => page.locator('.dcgs-moves').textContent()
const failures = []

async function expectMoves(atLeast, label) {
  try {
    await page.waitForFunction(
      expected => document.querySelectorAll('.dcgs-moves li b').length >= expected,
      atLeast, { timeout: 40_000 })
    console.log(`[OK]  ${label}: ${(await record())?.trim()}`)
  } catch {
    failures.push(label)
    console.log(`[LOI] ${label}: moi co ${await moveCount()} nuoc — ${(await record())?.trim()}`)
  }
}

async function move(from, to) {
  await page.locator(`[data-square="${from}"]`).click()
  await page.waitForTimeout(150)
  await page.locator(`[data-square="${to}"]`).click()
  await page.waitForTimeout(200)
}

await page.goto(url, { waitUntil: 'networkidle' })

// 1. Cam Trang: nguoi di truoc, bot tra loi
await page.getByRole('button', { name: /Bắt đầu ván ngoại tuyến/ }).click()
await page.waitForTimeout(2_000)
await move('e2', 'e4')
await expectMoves(2, 'cam Trang, bot tra loi')

// 2. Cam Den: bot phai di truoc
await page.getByRole('button', { name: /Về menu/ }).click()
await page.getByRole('button', { name: 'Đen', exact: true }).click()
await page.getByRole('button', { name: /Bắt đầu ván ngoại tuyến/ }).click()
await expectMoves(1, 'cam Den, bot di truoc')
await move('e7', 'e5')
await expectMoves(3, 'cam Den, van tiep dien')

// 3. Hai nguoi cung may
await page.getByRole('button', { name: /Về menu/ }).click()
await page.getByRole('button', { name: /Hai người cùng máy/ }).click()
await page.getByRole('button', { name: 'Trắng', exact: true }).click()
await page.getByRole('button', { name: /Bắt đầu ván ngoại tuyến/ }).click()
await page.waitForTimeout(500)
await move('e2', 'e4')
await move('e7', 'e5')
await move('g1', 'f3')
await expectMoves(3, 'hot-seat')

await page.screenshot({ path: 'tools/last-run.png' })
await browser.close()

console.log(failures.length ? `\nKET QUA: THAT BAI (${failures.join(', ')})` : '\nKET QUA: ca 3 che do hoat dong')
process.exit(failures.length ? 1 : 0)
