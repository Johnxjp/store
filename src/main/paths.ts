import { join } from 'node:path'

/**
 * All runtime data lives in ./data inside the project folder (gitignored).
 * The main bundle is always at <projectRoot>/out/main, so the root is derived
 * from the bundle location — stable across `electron-vite dev` and direct
 * `electron out/main/index.js` launches.
 */
export const projectRoot = join(import.meta.dirname, '..', '..')
export const dataDir = join(projectRoot, 'data')
export const recordingsDir = join(dataDir, 'recordings')
export const modelPath = join(dataDir, 'models', 'ggml-large-v3-turbo.bin')
export const audioCaptureBin = join(projectRoot, 'resources', 'bin', 'audio-capture')
