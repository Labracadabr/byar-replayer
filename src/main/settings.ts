// Settings persisted as JSON in Electron's userData dir (the work dir itself is a setting, so it can't live there).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings, SettingsState } from '@shared/types'
import { defaultSettings, validateSettings } from './paths'

export class SettingsStore {
  private settings: Settings
  private readonly file: string

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'settings.json')
    const defaults = defaultSettings()
    let saved: Partial<Settings> = {}
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      // first run: use detected defaults
    }
    this.settings = { ...defaults, ...saved }
    this.persist()
  }

  get(): Settings {
    return this.settings
  }

  state(): SettingsState {
    return { settings: this.settings, problems: validateSettings(this.settings) }
  }

  update(patch: Partial<Settings>): SettingsState {
    this.settings = { ...this.settings, ...patch }
    this.persist()
    return this.state()
  }

  private persist(): void {
    mkdirSync(join(this.file, '..'), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.settings, null, 2))
  }
}
