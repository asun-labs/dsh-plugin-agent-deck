import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(() => ({ status: 0 })),
}))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import * as pty from 'node-pty'
import { SessionManager, isProvider, providerStatuses } from '../src/sessions.ts'

interface FakeTerminal {
  terminal: IPty
  output(data: string): void
  exit(code: number): void
  writes: string[]
  resizes: Array<[number, number]>
  killed(): boolean
}

function fakeTerminal(): FakeTerminal {
  let onData: (data: string) => void = () => {}
  let onExit: (value: { exitCode: number }) => void = () => {}
  let killed = false
  const writes: string[] = []
  const resizes: Array<[number, number]> = []
  return {
    terminal: {
      onData: (callback: (data: string) => void) => { onData = callback; return { dispose() {} } },
      onExit: (callback: (value: { exitCode: number }) => void) => { onExit = callback; return { dispose() {} } },
      write: (value: string) => writes.push(value),
      resize: (cols: number, rows: number) => resizes.push([cols, rows]),
      kill: () => { killed = true },
    } as unknown as IPty,
    output: data => onData(data), exit: code => onExit({ exitCode: code }), writes, resizes, killed: () => killed,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('Agent Deck sessions', () => {
  it('accepts only fixed providers and reports CLI availability', () => {
    expect(isProvider('codex')).toBe(true)
    expect(isProvider('codex && del C:\\')).toBe(false)
    expect(providerStatuses(true).find(item => item.provider === 'kimi')).toMatchObject({ available: true, targetCommand: 'claude' })
  })

  it('streams output with ordered cursors, accepts input and resize, and kills on close', () => {
    const fake = fakeTerminal()
    vi.mocked(pty.spawn).mockReturnValue(fake.terminal)
    const manager = new SessionManager('C:\\work', 2)
    const session = manager.create('codex', 100, 30)
    expect(pty.spawn).toHaveBeenCalledOnce()
    fake.output('first')
    const frames: Array<{ id: number; event: unknown }> = []
    const unsubscribe = manager.subscribe(session.id, 0, frame => frames.push(frame))
    fake.output('second')
    expect(frames.map(frame => frame.id)).toEqual([1, 2])
    expect(frames.map(frame => frame.event)).toEqual([{ type: 'output', data: 'first' }, { type: 'output', data: 'second' }])
    unsubscribe?.()
    const resumed: number[] = []
    manager.subscribe(session.id, 1, frame => resumed.push(frame.id))
    expect(resumed).toEqual([2])
    expect(manager.input(session.id, 'hi')).toBe(true)
    expect(manager.resize(session.id, 120, 40)).toBe(true)
    expect(fake.writes).toEqual(['hi'])
    expect(fake.resizes).toEqual([[120, 40]])
    expect(manager.close(session.id)).toBe(true)
    expect(fake.killed()).toBe(true)
    expect(manager.size).toBe(0)
  })

  it('enforces session limit and records exits', () => {
    const fake = fakeTerminal()
    vi.mocked(pty.spawn).mockReturnValue(fake.terminal)
    const manager = new SessionManager('C:\\work', 1)
    const session = manager.create('claude', 100, 30)
    expect(() => manager.create('codex', 100, 30)).toThrow('Session limit reached')
    fake.exit(3)
    expect(manager.get(session.id)).toMatchObject({ exited: true, exitCode: 3 })
    expect(manager.input(session.id, 'ignored')).toBe(false)
    manager.dispose()
    expect(fake.killed()).toBe(true)
  })
})
