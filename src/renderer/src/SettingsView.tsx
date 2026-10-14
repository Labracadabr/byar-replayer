import { useState } from 'react'
import type { Settings, SettingsProblemField, SettingsState } from '@shared/types'

interface Props {
  state: SettingsState
  /** First-run / broken-config mode: can't close until the problems are fixed */
  setup: boolean
  onSaved(state: SettingsState): void
  onClose?(): void
}

function FolderField(props: {
  label: string
  hint?: string
  value: string
  error?: string
  onChange(v: string): void
}): React.JSX.Element {
  const browse = async (): Promise<void> => {
    const p = await window.api.pickFolder(props.label, props.value || undefined)
    if (p) props.onChange(p)
  }
  return (
    <label className={'field' + (props.error ? ' has-error' : '')}>
      <span className="field-label">{props.label}</span>
      <div className="field-row">
        <input value={props.value} onChange={(e) => props.onChange(e.target.value)} spellCheck={false} />
        <button type="button" onClick={browse}>
          Browse…
        </button>
      </div>
      {props.hint && <span className="field-hint">{props.hint}</span>}
      {props.error && <span className="field-error">{props.error}</span>}
    </label>
  )
}

function FolderList(props: {
  label: string
  values: string[]
  error?: string
  onChange(v: string[]): void
}): React.JSX.Element {
  const add = async (): Promise<void> => {
    const p = await window.api.pickFolder(props.label)
    if (p && !props.values.includes(p)) props.onChange([...props.values, p])
  }
  return (
    <div className={'field' + (props.error ? ' has-error' : '')}>
      <span className="field-label">{props.label}</span>
      {props.values.map((v, i) => (
        <div className="field-row" key={i}>
          <input
            value={v}
            spellCheck={false}
            onChange={(e) => props.onChange(props.values.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button type="button" onClick={() => props.onChange(props.values.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <div>
        <button type="button" onClick={add}>
          Add folder…
        </button>
      </div>
      {props.error && <span className="field-error">{props.error}</span>}
    </div>
  )
}

export function SettingsView({ state, setup, onSaved, onClose }: Props): React.JSX.Element {
  const [s, setS] = useState<Settings>(state.settings)
  const [problems, setProblems] = useState(state.problems)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]): void => setS((prev) => ({ ...prev, [k]: v }))
  const err = (f: SettingsProblemField): string | undefined =>
    problems
      .filter((p) => p.field === f)
      .map((p) => p.message)
      .join(' ') || undefined

  const save = async (): Promise<void> => {
    setSaving(true)
    const next = await window.api.saveSettings(s)
    setSaving(false)
    setProblems(next.problems)
    onSaved(next)
  }

  /** Picking a new BAR data dir fills in the dependent folders. */
  const setBarDir = (v: string): void => {
    setS((prev) => ({
      ...prev,
      barDataDir: v,
      demoDirs: prev.demoDirs.length ? prev.demoDirs : [v + '\\demos'],
      mapDirs: prev.mapDirs.length ? prev.mapDirs : [v + '\\maps']
    }))
  }

  return (
    <div className="settings">
      <header className="settings-header">
        <h1>{setup ? 'Set up BAR Replay Viewer' : 'Settings'}</h1>
        {onClose && (
          <button type="button" onClick={onClose}>
            Close
          </button>
        )}
      </header>
      {setup && (
        <p className="settings-intro">
          Some folders couldn't be detected automatically. Pick them below. Your BAR install is only read, except
          that missing maps are downloaded into the maps folder.
        </p>
      )}
      <FolderField
        label="BAR data folder"
        hint="Contains engine\, maps\, packages\ and demos\"
        value={s.barDataDir}
        error={err('barDataDir')}
        onChange={setBarDir}
      />
      <FolderList label="Replay folders" values={s.demoDirs} error={err('demoDirs')} onChange={(v) => set('demoDirs', v)} />
      <FolderList label="Map folders" values={s.mapDirs} error={err('mapDirs')} onChange={(v) => set('mapDirs', v)} />
      <FolderField
        label="Work folder"
        hint="Library database, simulation jobs, recorded games and caches. ASCII-only path."
        value={s.workDir}
        error={err('workDir')}
        onChange={(v) => set('workDir', v)}
      />
      <FolderField
        label="Engine cache folder"
        hint="Downloaded engine builds"
        value={s.engineCacheDir}
        onChange={(v) => set('engineCacheDir', v)}
      />
      <div className="field-grid">
        <label className="field">
          <span className="field-label">Parallel simulations</span>
          <input
            type="number"
            min={0}
            max={64}
            value={s.concurrency}
            onChange={(e) => set('concurrency', Math.max(0, Number(e.target.value) || 0))}
          />
          <span className="field-hint">0 = automatic (CPU cores − 1)</span>
        </label>
        <label className="field">
          <span className="field-label">Sample interval (sim frames)</span>
          <input
            type="number"
            min={1}
            max={300}
            value={s.sampleInterval}
            onChange={(e) => set('sampleInterval', Math.max(1, Number(e.target.value) || 15))}
          />
          <span className="field-hint">30 frames = 1 second. Default 15 (2 samples/s)</span>
        </label>
      </div>
      <label className="field">
        <span className="field-label">Google API key (optional)</span>
        <input type="password" value={s.googleApiKey} onChange={(e) => set('googleApiKey', e.target.value)} />
        <span className="field-hint">Used only to download missing maps from BAR's public Google Drive folder</span>
      </label>
      <div className="settings-actions">
        <button type="button" className="primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
