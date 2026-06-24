import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:5173'
const OUT = '/tmp/vms-shots'
import { mkdirSync } from 'fs'
mkdirSync(OUT, { recursive: true })

const b = await chromium.launch()
const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// desktop
let ctx = await b.newContext({ viewport: { width: 1280, height: 850 }, deviceScaleFactor: 1 })
let p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'networkidle' })
await sleep(600); await shot(p, '01-portal-desktop')
await p.getByText('Citizen', { exact: false }).first().click()
await sleep(800); await shot(p, '02-citizen-home-desktop')
// booking wizard
await p.getByRole('button', { name: /Book/ }).first().click().catch(() => {})
await sleep(700); await shot(p, '03-citizen-book-zone')
await p.locator('button:has-text("Indore Road")').first().click().catch(() => {})
await sleep(700); await shot(p, '04-citizen-book-time')
await p.locator('button:has-text("06:00")').first().click().catch(() => {})
await sleep(800); await shot(p, '05-citizen-parking-map')
// operator
await p.goto(URL, { waitUntil: 'networkidle' }); await sleep(400)
await p.getByText('Gate Operator', { exact: false }).first().click()
await sleep(900); await shot(p, '06-operator')
// command
await p.goto(URL, { waitUntil: 'networkidle' }); await sleep(400)
await p.getByText('Command Centre', { exact: false }).first().click()
await sleep(1000); await shot(p, '07-command')
await ctx.close()

// mobile
ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true })
p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'networkidle' }); await sleep(500)
await p.getByText('Citizen', { exact: false }).first().click()
await sleep(800); await shot(p, '08-citizen-home-mobile')
await ctx.close()

await b.close()
console.log('done ->', OUT)
