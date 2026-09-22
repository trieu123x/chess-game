/**
 * Kiem tra engine co cho tach khoi giao dien React.
 * Chay:  npm run dev   (terminal khac)
 *        npm run check:engine
 *
 * CODE CUA NHOM. Mo trang /bot-test.html bang trinh duyet that (Chromium cua
 * Playwright), doi engine choi 6 nuoc roi in ket qua. Dung khi nghi ngo loi
 * nam o engine hay o UI.
 */
import { chromium } from 'playwright'

const url = process.env.APP_URL ?? 'http://localhost:5173'
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', message => console.log(`  [${message.type()}] ${message.text()}`))
page.on('pageerror', error => console.log(`  [pageerror] ${error.message}`))

await page.goto(`${url}/bot-test.html`, { waitUntil: 'domcontentloaded' })
let timedOut = false
try {
  await page.waitForFunction(
    () => window.__diagnose && (window.__diagnose.moves.length >= 6 || window.__diagnose.errors.length > 0),
    null, { timeout: 90_000 })
} catch {
  timedOut = true
}

const result = await page.evaluate(() => window.__diagnose ?? null)
await browser.close()

console.log('\n' + (await Promise.resolve(JSON.stringify(result, null, 2))))
const ok = !timedOut && result && result.booted && result.errors.length === 0 && result.moves.length >= 6
console.log(ok ? '\nKET QUA: engine hoat dong' : '\nKET QUA: THAT BAI')
process.exit(ok ? 0 : 1)
