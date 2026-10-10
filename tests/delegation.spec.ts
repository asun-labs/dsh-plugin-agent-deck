import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(() => ({ status: 0 })),
  spawn: vi.fn(),
}))

import { spawn } from 'node:child_process'
import { RunGroupStore, validateSettings } from '../src/delegation.ts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

it('runs parallel Codex children and replays their saved terminal output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-deck-groups-'))
  directories.push(directory)
  const prompts: string[] = []
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; stdin: { end(value: string): void }; pid: number; kill(): void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { end(value) { prompts.push(value); queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(`finished ${value}\n`))
      child.emit('close', 0)
    }) } }
    child.pid = 123
    child.kill = () => {}
    return child as unknown as ReturnType<typeof spawn>
  })
  const settings = { workspace: process.cwd(), maxSessions: 3, defaultModel: 'gpt-6.1-sol', codexProfile: 'work', codexAccountId: 'saved-account', historyDays: 30 }
  const store = new RunGroupStore(directory, settings)
  await store.initialize()
  const result = await store.execute('call-1', 'session-1', [
    { label: 'English greeting', prompt: 'Say hello' },
    { label: 'Chinese greeting', prompt: '说你好' },
  ], new AbortController().signal, directory)
  expect(result.state).toBe('completed')
  expect(result.children.map(child => child.state)).toEqual(['completed', 'completed'])
  expect(prompts.sort()).toEqual(['Say hello', '说你好'].sort())
  // Windows wraps the call in `cmd.exe /d /c "agent-switch codex ..."`, so prepend the
  // executable to the arguments to rebuild the same command line on either platform.
  const spawnCall = vi.mocked(spawn).mock.calls[0]
  expect(`${spawnCall?.[0]} ${(spawnCall?.[1] ?? []).join(' ')}`).toContain('agent-switch codex --profile work exec --skip-git-repo-check --color always --model gpt-6.1-sol -')
  expect(vi.mocked(spawn).mock.calls[0]?.[2]?.cwd).toBe(directory)
  expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env?.AGENT_SWITCH_CODEX_AUTH_CHOICE).toBe('saved-account')
  const restored = new RunGroupStore(directory, settings)
  await restored.initialize()
  expect((await restored.get('call-1'))?.children).toHaveLength(2)
  expect(await restored.output('call-1', result.children[1]!.id)).toContain('finished 说你好')
  expect(await restored.list('session-1')).toHaveLength(1)
  expect(await restored.listAll()).toHaveLength(1)
})

it('lists only saved-account metadata and rejects unsafe model options', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-deck-accounts-'))
  directories.push(directory)
  const previous = process.env.AGENT_SWITCH_PROFILE_HOME
  const base = join(directory, 'profiles')
  process.env.AGENT_SWITCH_PROFILE_HOME = base
  try {
    const accountDirectory = join(base, 'codex', '.accounts')
    await mkdir(accountDirectory, { recursive: true })
    await mkdir(join(base, 'codex', 'work'), { recursive: true })
    await writeFile(join(accountDirectory, 'index.json'), JSON.stringify({ accounts: [
      { id: 'saved-account', label: 'Work', email: 'work@example.test', authMode: 'chatgpt', authJson: { secret: 'must-stay-private' } },
    ] }))
    const settings = { workspace: process.cwd(), maxSessions: 2, defaultModel: '', codexProfile: 'work', codexAccountId: 'saved-account', historyDays: 30 }
    const store = new RunGroupStore(join(directory, 'data'), settings)
    await store.initialize()
    expect(await store.codexProfiles()).toContain('work')
    expect(await store.codexAccounts()).toEqual([{ id: 'saved-account', label: 'Work', email: 'work@example.test', authMode: 'chatgpt' }])
    expect(await store.setSettings(settings)).toMatchObject({ codexAccountId: 'saved-account' })
    expect(() => validateSettings({ ...settings, defaultModel: 'safe; echo unsafe' })).toThrow('defaultModel')
  } finally {
    if (previous === undefined) delete process.env.AGENT_SWITCH_PROFILE_HOME
    else process.env.AGENT_SWITCH_PROFILE_HOME = previous
  }
})
