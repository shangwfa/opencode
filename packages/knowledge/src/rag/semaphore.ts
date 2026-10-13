export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await operation()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }

    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.active += 1
  }

  private release(): void {
    this.active -= 1
    this.waiters.shift()?.()
  }
}

