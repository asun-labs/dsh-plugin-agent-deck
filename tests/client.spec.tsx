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

const TAB_ID = '@asun-labs/dsh-plugin-agent-deck'
const PANEL_ID = '@asun-labs/dsh-plugin-agent-deck/panel'

interface GuideEntry { id: string; order: number; title: () => string; description?: () => string }
interface TabDefinition { id: string; kind: string; title: () => string; guide?: GuideEntry[] }
interface SlotOptions { name: string; key?: string }

function harness() {
  const panes = new Map<string, React.ComponentType>()
  const components = new Map<string, React.ComponentType<any>>()
  const definitions: TabDefinition[] = []
  const openTab = vi.fn()
  const ctx = { effect: (register: () => () => void) => register(),
    sidebarRightTabs: { register: (definition: TabDefinition) => { definitions.push(definition); return () => {} } },
    sidebarRight: { openTab },
    slots: { inject: (_name: string, register: () => void) => { register(); return () => {} },
      register: (options: SlotOptions, component: React.ComponentType<any>) => {
        if (options.name === 'sidebar.right.pane.tab' && options.key) panes.set(options.key, component)
        else if (components.size < 2 || !options.key) components.set(options.name, component)
        return () => {}
      } } } as unknown as Context
  apply(ctx)
  return { panes, components, definitions, openTab }
}

it('opens the runtime panel, starts a runtime, and switches between tabs and grid', async () => {
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
  const { panes, definitions } = harness()
  expect(definitions.map(definition => definition.kind)).toEqual(['agent-deck', 'agent-deck-panel'])
  expect(definitions.map(definition => definition.title())).toEqual(['Agent Deck', 'Agent Deck Panel'])
  expect(definitions.map(definition => definition.guide?.[0]?.id)).toEqual(['agent-deck', 'agent-deck-panel'])
  const Panel = panes.get(PANEL_ID)
  expect(Panel).toBeDefined()
  const mount = document.createElement('div')
  document.body.append(mount)
  const root = createRoot(mount)
  await act(async () => { root.render(React.createElement(Panel!)) })
  await act(async () => { await Promise.resolve() })
  expect(mount.querySelector('.agent-deck-panel')).toBeTruthy()
  expect(mount.querySelector('.agent-deck-launch')).toBeNull()
  expect(mount.querySelector('.agent-deck-drawer')).toBeNull()
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
  const { panes, components, openTab } = harness()
  expect(components.has('settings.section')).toBe(true)
  expect(panes.has(TAB_ID)).toBe(true)
  expect(panes.has(PANEL_ID)).toBe(true)
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