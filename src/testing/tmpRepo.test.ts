import { rm, stat } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpDir } from './tmpRepo.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('temp directory cleanup', () => {
  it('removes the directory when KEEP_TMP is not set', async () => {
    vi.stubEnv('KEEP_TMP', undefined)
    const tmp = await tmpDir()

    await tmp.cleanup()

    await expect(stat(tmp.dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the directory and prints its path to stderr when KEEP_TMP=1', async () => {
    vi.stubEnv('KEEP_TMP', '1')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const tmp = await tmpDir()

    try {
      await tmp.cleanup()

      expect((await stat(tmp.dir)).isDirectory()).toBe(true)
      expect(stderr).toHaveBeenCalledWith(`KEEP_TMP: kept ${tmp.dir}\n`)
    } finally {
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })
})
