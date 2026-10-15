import { useCallback, useEffect, useState } from 'react'
import type { SettingsState } from '@shared/types'
import { LibraryView } from './LibraryView'
import { PlayerView } from './player/PlayerView'
import { SettingsView } from './SettingsView'

export function App(): React.JSX.Element {
  const [state, setState] = useState<SettingsState | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [player, setPlayer] = useState<{ id: number; title: string } | null>(null)

  const reload = useCallback(() => void window.api.getSettings().then(setState), [])
  useEffect(reload, [reload])

  if (!state) return <div className="splash">Loading…</div>

  const needsSetup = state.problems.length > 0
  if (needsSetup || showSettings) {
    return (
      <SettingsView
        state={state}
        setup={needsSetup}
        onSaved={(s) => {
          setState(s)
          if (s.problems.length === 0) setShowSettings(false)
        }}
        onClose={needsSetup ? undefined : () => setShowSettings(false)}
      />
    )
  }
  return (
    <>
      {/* the library stays mounted underneath so its filters and selection survive the player */}
      <div style={{ display: player ? 'none' : 'contents' }}>
        <LibraryView onOpenSettings={() => setShowSettings(true)} onOpenPlayer={(id, title) => setPlayer({ id, title })} />
      </div>
      {player && <PlayerView replayId={player.id} title={player.title} onClose={() => setPlayer(null)} />}
    </>
  )
}
