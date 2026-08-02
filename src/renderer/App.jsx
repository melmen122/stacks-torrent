import { useCallback, useState } from 'react';
import { HAS_API } from './api.js';
import { ToastProvider } from './context/ToastContext.jsx';
import { LibraryProvider } from './context/LibraryContext.jsx';
import { TorrentsProvider } from './context/TorrentsContext.jsx';
import { PlayerProvider } from './context/PlayerContext.jsx';
import Sidebar from './components/Sidebar.jsx';
import LibraryView from './components/LibraryView.jsx';
import DownloadsView from './components/DownloadsView.jsx';
import SettingsView from './components/SettingsView.jsx';
import PlayerBar from './components/PlayerBar.jsx';
import ToastStack from './components/ToastStack.jsx';
import NoElectronNotice from './components/NoElectronNotice.jsx';
import DropImportOverlay from './components/DropImportOverlay.jsx';
import MagnetNavigator from './components/MagnetNavigator.jsx';

export default function App() {
  const [view, setView] = useState('library'); // 'library' | 'downloads' | 'settings'
  const [selectedGenre, setSelectedGenre] = useState('all'); // 'all' | 'uncategorized' | genreId

  // Stable identity (setView from useState never changes) so MagnetNavigator's
  // effect — which pulls any pending cold-start magnet on mount — doesn't
  // needlessly re-subscribe/re-pull on every unrelated App re-render.
  const navigateToDownloads = useCallback(() => setView('downloads'), []);

  if (!HAS_API) {
    return <NoElectronNotice />;
  }

  return (
    <ToastProvider>
      <LibraryProvider>
        <TorrentsProvider>
          <PlayerProvider>
            <div className="app-shell">
              <div className="app-body">
                <Sidebar
                  view={view}
                  onChangeView={setView}
                  selectedGenre={selectedGenre}
                  onSelectGenre={(g) => { setSelectedGenre(g); setView('library'); }}
                />
                <main className="app-main">
                  {view === 'library' ? (
                    <LibraryView
                      selectedGenre={selectedGenre}
                      onNavigateDownloads={() => setView('downloads')}
                    />
                  ) : view === 'downloads' ? (
                    <DownloadsView />
                  ) : (
                    <SettingsView />
                  )}
                </main>
              </div>
              <PlayerBar />
              <ToastStack />
              <DropImportOverlay />
              <MagnetNavigator onMagnet={navigateToDownloads} />
            </div>
          </PlayerProvider>
        </TorrentsProvider>
      </LibraryProvider>
    </ToastProvider>
  );
}
