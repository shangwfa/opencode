import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'

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

export async function snapshot(page: Page): Promise<string> {
  return page.evaluate(INTERACTIVE_COLLECTOR) as Promise<string>
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
