import { vi } from 'vitest'

/** Electron mock with a reversible fake safeStorage. Use inside vi.mock('electron', ...). */
export const electronMock = {
  app: { getPath: () => '' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}
