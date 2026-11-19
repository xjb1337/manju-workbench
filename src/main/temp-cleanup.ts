import { lstat, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

export const staleTempPrefixes = ['manju-preview-', 'manju-sample-', 'manju-render-work-', 'manju-shot-cache-'] as const
export const staleTempAgeMs = 24 * 60 * 60 * 1000

/** Removes stale temporary directories matching any allowed prefix without touching unrelated directories. */
export async function cleanupStaleTempDirs(
  baseDir: string,
  prefixes: readonly string[],
  maxAgeMs: number,
  now = Date.now(),
): Promise<string[]> {
  const removed: string[] = []
  const validPrefixes = prefixes.filter(prefix => prefix.length > 0)
  if (!validPrefixes.length) return removed
  try {
    const cutoff = now - maxAgeMs
    const entries = await readdir(baseDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !validPrefixes.some(prefix => entry.name.startsWith(prefix))) continue
      const target = path.join(baseDir, entry.name)
      const stats = await lstat(target).catch(() => undefined)
      if (stats?.isDirectory() && stats.mtimeMs < cutoff) {
        const deleted = await rm(target, { recursive: true, force: true }).then(() => true, () => false)
        if (deleted) removed.push(target)
      }
    }
  } catch {
    // Best-effort cleanup of stale temp directories.
  }
  return removed
}
