import { app, BrowserWindow } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, markInterruptedMeetings } from './db'
import { abortActiveRecording, registerIpcHandlers } from './ipc'
import { dataDir } from './paths'

const dirname = import.meta.dirname

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    title: 'AI Meeting Notes',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f6f4ee',
    webPreferences: {
      preload: join(dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  mkdirSync(dataDir, { recursive: true })
  initDb(join(dataDir, 'db.sqlite'))
  markInterruptedMeetings()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

// Quit is deferred once so the audio helper can finalize the WAVs; a crash or
// force-kill skips this path and is handled by markInterruptedMeetings().
let stoppingBeforeQuit = false
app.on('before-quit', (event) => {
  if (stoppingBeforeQuit) return
  const pending = abortActiveRecording()
  if (pending) {
    event.preventDefault()
    stoppingBeforeQuit = true
    void pending.finally(() => app.quit())
  }
})
