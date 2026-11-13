export interface Runtime {
  now(): number
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
  setInterval(cb: () => void, ms: number): ReturnType<typeof setInterval>
  clearInterval(timer: ReturnType<typeof setInterval>): void
}

export const runtime: Runtime = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (timer) => clearInterval(timer),
}

export function delay(ms: number, clock: Runtime = runtime): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => clock.setTimeout(resolve, ms))
}
