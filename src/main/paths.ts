import { app } from 'electron'
import { join } from 'node:path'

/**
 * All runtime data lives in ./data inside the project folder (gitignored).
 * app.getAppPath() is the project root under electron-vite dev.
 */
export const projectRoot = app.getAppPath()
export const dataDir = join(projectRoot, 'data')
export const recordingsDir = join(dataDir, 'recordings')
export const modelPath = join(dataDir, 'models', 'ggml-large-v3-turbo.bin')
export const audioCaptureBin = join(projectRoot, 'resources', 'bin', 'audio-capture')
