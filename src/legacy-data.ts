import { cp, lstat, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { previousIdentity } from './compatibility.ts'

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Copy earlier settings and logs once; keep the source intact and never replace current data. */
export async function importPreviousData(root: string): Promise<boolean> {
  if (basename(root) !== 'agent-switch') return false
  try { await lstat(root); return false } catch (error) { if (!missing(error)) throw error }
  const source = join(dirname(root), previousIdentity.directory)
  try {
    const info = await lstat(source)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
  } catch (error) { if (missing(error)) return false; throw error }
  const temporary = join(dirname(root), `.agent-switch-migration-${randomUUID()}`)
  try {
    await cp(source, temporary, { recursive: true, force: false, errorOnExist: true })
    await rename(temporary, root)
    return true
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
