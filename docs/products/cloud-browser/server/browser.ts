import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import path from 'node:path'
import fs from 'node:fs'

interface BrowserConnection {
  browser: Browser
  page: Page
}

const connections = new Map<string, BrowserConnection>()
const pending = new Map<string, Promise<Page>>()

export async function getPage(sandboxId: string, cdpEndpoint: string): Promise<Page> {
  const existing = connections.get(sandboxId)
  if (existing && existing.browser.isConnected() && !existing.page.isClosed()) {
    return existing.page
  }

  const inflight = pending.get(sandboxId)
  if (inflight) return inflight

  const task = (async () => {
    const browser = await chromium.connectOverCDP(`http://${cdpEndpoint}`, {
      headers: { 'OPEN-SANDBOX-API-KEY': '' },
    })
    const context = browser.contexts()[0]
    const page = context.pages()[0] ?? (await context.newPage())
    connections.set(sandboxId, { browser, page })
    return page
  })()

  pending.set(sandboxId, task)
  try {
    return await task
  } finally {
    pending.delete(sandboxId)
  }
}

export async function closeBrowser(sandboxId: string): Promise<void> {
  const conn = connections.get(sandboxId)
  if (!conn) return
  connections.delete(sandboxId)
  await conn.browser.close().catch(() => {})
}

const INTERACTIVE_COLLECTOR = `(() => {
  const results = []
  const seen = new Set()
  let ref = 1
  document.querySelectorAll('[data-cb-ref]').forEach((el) => el.removeAttribute('data-cb-ref'))

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return false
    const style = window.getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
  }

  const describe = (el) => {
    const tag = el.tagName.toLowerCase()
    const type = el.getAttribute('type') || ''
    const role = el.getAttribute('role') || ''
    const label =
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      (el.innerText || el.value || '').trim().slice(0, 60)
    const parts = [tag]
    if (type) parts.push('type=' + type)
    if (role) parts.push('role=' + role)
    if (label) parts.push(JSON.stringify(label))
    if (el.href) parts.push('-> ' + el.href.slice(0, 80))
    return parts.join(' ')
  }

  const candidates = document.querySelectorAll(
    'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="tab"], [role="menuitem"], [onclick], [contenteditable="true"], summary'
  )
  for (const el of candidates) {
    if (seen.has(el) || !isVisible(el)) continue
    seen.add(el)
    const id = 'e' + ref++
    el.setAttribute('data-cb-ref', id)
    results.push('[' + id + '] ' + describe(el))
    if (results.length >= 200) break
  }
  return results.join('\\n')
})()`

const PAGE_SUMMARY = `(() => {
  const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim()
  return text.slice(0, 800)
})()`

export async function snapshot(page: Page): Promise<string> {
  return page.evaluate(INTERACTIVE_COLLECTOR) as Promise<string>
}

export async function pageSummary(page: Page): Promise<string> {
  return page.evaluate(PAGE_SUMMARY) as Promise<string>
}

export async function clickRef(page: Page, ref: string): Promise<void> {
  const locator = page.locator(`[data-cb-ref="${ref}"]`)
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 })
  await locator.click({ timeout: 5000 })
}

export async function typeRef(page: Page, ref: string, text: string): Promise<void> {
  const locator = page.locator(`[data-cb-ref="${ref}"]`)
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 })
  await locator.click({ timeout: 5000 })
  await locator.fill(text, { timeout: 5000 })
}

export async function selectRef(page: Page, ref: string, values: string[]): Promise<string[]> {
  const locator = page.locator(`[data-cb-ref="${ref}"]`)
  return locator.selectOption(values, { timeout: 5000 })
}

export async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key)
}

export async function scrollPage(page: Page, direction: string, amount = 600): Promise<void> {
  const delta = direction === 'up' ? -amount : amount
  if (direction === 'left' || direction === 'right') {
    const dx = direction === 'left' ? -amount : amount
    await page.evaluate(`window.scrollBy(${dx}, 0)`)
  } else {
    await page.evaluate(`window.scrollBy(0, ${delta})`)
  }
}

export async function pageText(page: Page, maxLength = 4000): Promise<string> {
  const text = (await page.evaluate(
    `document.body?.innerText ?? ''`,
  )) as string
  return text.length > maxLength ? text.slice(0, maxLength) + '\\n…(truncated)' : text
}

export async function pageState(page: Page): Promise<{ url: string; title: string }> {
  return { url: page.url(), title: await page.title() }
}

export async function screenshotBase64(page: Page): Promise<string> {
  const buffer = await page.screenshot({ type: 'jpeg', quality: 60 })
  return buffer.toString('base64')
}

export async function evaluateJs(page: Page, script: string): Promise<unknown> {
  return page.evaluate(script)
}

export async function waitFor(page: Page, opts: { selector?: string; text?: string; timeoutMs?: number }): Promise<void> {
  const timeout = opts.timeoutMs ?? 10000
  if (opts.selector) {
    await page.waitForSelector(opts.selector, { timeout })
    return
  }
  if (opts.text) {
    await page.waitForSelector(`text=${opts.text}`, { timeout })
    return
  }
  await page.waitForTimeout(timeout)
}

export async function goBack(page: Page): Promise<void> {
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
}

export async function listTabs(page: Page): Promise<Array<{ index: number; url: string; title: string; active: boolean }>> {
  const pages = page.context().pages()
  return Promise.all(
    pages.map(async (p, index) => ({
      index,
      url: p.url(),
      title: await p.title(),
      active: p === page,
    })),
  )
}

export async function switchTab(sandboxId: string, index: number): Promise<boolean> {
  const conn = connections.get(sandboxId)
  if (!conn) return false
  const pages = conn.page.context().pages()
  const target = pages[index]
  if (!target) return false
  await target.bringToFront()
  connections.set(sandboxId, { browser: conn.browser, page: target })
  return true
}

const downloadsDir = path.resolve(import.meta.dirname, 'data/downloads')

export async function clickAndDownload(page: Page, sandboxId: string, ref: string, timeoutMs = 30000): Promise<{ filename: string; size: number }> {
  const locator = page.locator(`[data-cb-ref="${ref}"]`)
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: timeoutMs }),
    locator.click({ timeout: 5000 }),
  ])
  const filename = download.suggestedFilename()
  const dir = path.join(downloadsDir, sandboxId)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, filename)
  await download.saveAs(target)
  return { filename, size: fs.statSync(target).size }
}

export function getDownloadedFile(sandboxId: string, filename: string): string | undefined {
  const safe = path.basename(filename)
  const target = path.join(downloadsDir, sandboxId, safe)
  return fs.existsSync(target) ? target : undefined
}

export async function uploadToRef(page: Page, sandboxId: string, ref: string, filename: string, contentBase64?: string): Promise<void> {
  let filePath: string
  if (contentBase64) {
    const dir = path.join(downloadsDir, sandboxId)
    fs.mkdirSync(dir, { recursive: true })
    filePath = path.join(dir, path.basename(filename))
    fs.writeFileSync(filePath, Buffer.from(contentBase64, 'base64'))
  } else {
    const existing = getDownloadedFile(sandboxId, filename)
    if (!existing) throw new Error(`file not found: ${filename}（先 download 或传 contentBase64）`)
    filePath = existing
  }
  const locator = page.locator(`[data-cb-ref="${ref}"]`)
  await locator.setInputFiles(filePath, { timeout: 5000 })
}
