// @vitest-environment jsdom
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100
    rows = 30
    loadAddon() {}
    open() {}
    writeln() {}
    write() {}
    onData() { return { dispose() {} } }
    refresh() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

import { apply } from '../src/client.tsx'

it('opens the right panel, starts a runtime, and switches between tabs and grid', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('EventSource', class { static CLOSED = 2; readyState = 1; onmessage = null; onerror = null; close() {} })
  let created = 0
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/status')) return Response.json({ agentSwitchAvailable: true, workspace: 'C:\\work', maxSessions: 9,
      providers: [{ provider: 'codex', label: 'Codex', available: true, status: 'ready', targetCommand: 'codex' }] })
    if (url.endsWith('/sessions') && options?.method === 'POST') return Response.json({ id: `session-${++created}`, provider: 'codex', cwd: 'C:\\work', command: 'agent-switch codex', exited: false, exitCode: null })
    return Response.json({ closed: true })
  })
  vi.stubGlobal('fetch', fetcher)
  let Overlay: React.ComponentType | undefined
  const ctx = { slots: { inject: (_name: string, register: () => void) => { register(); return () => {} },
    register: (_options: unknown, component: React.ComponentType) => { Overlay = component; return () => {} } } } as unknown as Context
  apply(ctx)
  expect(Overlay).toBeDefined()
  const mount = document.createElement('div')
  document.body.append(mount)
  const root = createRoot(mount)
  await act(async () => { root.render(React.createElement(Overlay!)) })
  await act(async () => { await Promise.resolve() })
  expect(mount.querySelector('.agent-deck-launch')).toBeTruthy()
  await act(async () => { (mount.querySelector('.agent-deck-launch') as HTMLButtonElement).click() })
  expect(mount.querySelector('.agent-deck-drawer.is-open')).toBeTruthy()
  await act(async () => { (mount.querySelector('.agent-deck-providers button') as HTMLButtonElement).click() })
  await act(async () => { (mount.querySelector('.agent-deck-providers button') as HTMLButtonElement).click() })
  await act(async () => { await Promise.resolve() })
  expect(created).toBe(2)
  expect(mount.querySelector('.agent-deck-tabs')).toBeTruthy()
  expect(mount.querySelectorAll('.agent-deck-tabs>div')).toHaveLength(2)
  await act(async () => { (mount.querySelector('[title="Switch layout"]') as HTMLButtonElement).click() })
  expect(mount.querySelector('.agent-deck-stack.grid')).toBeTruthy()
  expect(mount.querySelectorAll('.agent-deck-card header')).toHaveLength(2)
  await act(async () => { (mount.querySelector('[title="Switch layout"]') as HTMLButtonElement).click() })
  expect(mount.querySelector('.agent-deck-stack.tabs')).toBeTruthy()
  await act(async () => { (mount.querySelector('[aria-label="Close codex terminal"]') as HTMLButtonElement).click() })
  await act(async () => { (mount.querySelector('[aria-label="Close codex terminal"]') as HTMLButtonElement).click() })
  expect(mount.querySelector('.agent-deck-tabs')).toBeNull()
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/close'))).toBe(true)
  await act(async () => { root.unmount() })
  mount.remove()
})

afterEach(() => vi.unstubAllGlobals())
