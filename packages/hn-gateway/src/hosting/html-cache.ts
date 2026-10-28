/**
 * HTML LRU 缓存（原 HtmlCacheService 语义：50 项 / 50MB，按字节计重）。
 */
export class HtmlCacheService {
  private readonly items = new Map<string, { html: string; bytes: number }>()
  private currentBytes = 0

  constructor(
    private readonly maxItems = 50,
    private readonly maxBytes = 50 * 1024 * 1024,
  ) {}

  get(key: string): string | undefined {
    const item = this.items.get(key)
    if (!item) return undefined
    // LRU：命中即移到最新
    this.items.delete(key)
    this.items.set(key, item)
    return item.html
  }

  set(key: string, html: string): void {
    const bytes = Buffer.byteLength(html, "utf8")
    const existing = this.items.get(key)
    if (existing) {
      this.currentBytes -= existing.bytes
      this.items.delete(key)
    }
    this.items.set(key, { html, bytes })
    this.currentBytes += bytes
    this.evict()
  }

  private evict(): void {
    while (this.items.size > this.maxItems || (this.currentBytes > this.maxBytes && this.items.size > 1)) {
      const oldest = this.items.keys().next().value
      if (oldest === undefined) break
      const removed = this.items.get(oldest)!
      this.currentBytes -= removed.bytes
      this.items.delete(oldest)
    }
  }

  clear(): void {
    this.items.clear()
    this.currentBytes = 0
  }

  stats(): { items: number; bytes: number } {
    return { items: this.items.size, bytes: this.currentBytes }
  }
}

export const htmlCache = new HtmlCacheService()
