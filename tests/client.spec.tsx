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
  const ctx = { effect: (register: () => () => void) => register(),
    sidebarRightTabs: { register: () => () => {} }, sidebarRight: { openTab() {} },
    slots: { inject: (_name: string, register: () => void) => { register(); return () => {} },
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

it('renders a conversation child card that opens the native right sidebar tab', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const group = { callId: 'call-1', sessionId: 'session-1', createdAt: Date.now(), state: 'running', children: [
    { id: 'child-1', label: 'Explore files', provider: 'codex', model: 'gpt-6.1-sol', state: 'running', startedAt: Date.now(), endedAt: null, exitCode: null },
  ] }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(group)))
  const components = new Map<string, React.ComponentType<any>>()
  const openTab = vi.fn()
  const ctx = { effect: (register: () => () => void) => register(), sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab }, slots: { inject: (_name: string, register: () => void) => { register(); return () => {} },
      register: (options: { name: string }, component: React.ComponentType<any>) => { components.set(options.name, component); return () => {} } } } as unknown as Context
  apply(ctx)
  expect(components.has('settings.section')).toBe(true)
  expect(components.has('sidebar.right.pane.tab')).toBe(true)
  const ToolCard = components.get('tool.call.toolview')!
  const mount = document.createElement('div')
  document.body.append(mount)
  const root = createRoot(mount)
  await act(async () => { root.render(<ToolCard callId="call-1" block={{}} />) })
  await act(async () => { await Promise.resolve() })
  expect(mount.textContent).toContain('Explore files')
  await act(async () => { (mount.querySelector('.ad-card-children button') as HTMLButtonElement).click() })
  expect(openTab).toHaveBeenCalledWith('agent-deck')
  await act(async () => { root.unmount() })
  mount.remove()
})
