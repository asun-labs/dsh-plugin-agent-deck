import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { previousIdentity } from '../src/compatibility.ts'
import { importPreviousData } from '../src/legacy-data.ts'

it('imports prior settings and history once without changing the source or overwriting current data', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-switch-migration-'))
  try {
    const source = join(home, previousIdentity.directory)
    const target = join(home, 'agent-switch')
    await mkdir(join(source, 'saved-group'), { recursive: true })
    await writeFile(join(source, 'settings.json'), '{"defaultModel":"saved-model"}')
    await writeFile(join(source, 'saved-group', 'child.log'), 'saved terminal output')
    expect(await importPreviousData(target)).toBe(true)
    expect(await readFile(join(target, 'saved-group', 'child.log'), 'utf8')).toBe('saved terminal output')
    expect(await readFile(join(source, 'settings.json'), 'utf8')).toContain('saved-model')
    await writeFile(join(target, 'settings.json'), '{"defaultModel":"current-model"}')
    expect(await importPreviousData(target)).toBe(false)
    expect(await readFile(join(target, 'settings.json'), 'utf8')).toContain('current-model')
  } finally { await rm(home, { recursive: true, force: true }) }
})
