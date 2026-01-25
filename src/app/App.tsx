import { useEffect, useMemo, useState } from 'react';
import FoldersPage from '../pages/FoldersPage';
import ReviewPage from '../pages/ReviewPage';
import ImportPage from '../pages/ImportPage';
import StatsPage from '../pages/StatsPage';
import SettingsPage from '../pages/SettingsPage';
import { v4 as uuidv4 } from 'uuid';

export type TabKey = 'folders' | 'review' | 'import' | 'stats' | 'settings';

export interface AppSettings {
  maxNew: number;
  maxReviews: number;
}

const defaultSettings: AppSettings = {
  maxNew: 20,
  maxReviews: 60,
};

const readSettings = (): AppSettings => {
  const raw = localStorage.getItem('chanki_settings');
  if (!raw) return defaultSettings;
  try {
    return { ...defaultSettings, ...(JSON.parse(raw) as AppSettings) };
  } catch {
    return defaultSettings;
  }
};

const persistSettings = (settings: AppSettings) => {
  localStorage.setItem('chanki_settings', JSON.stringify(settings));
};

const App = () => {
  const [tab, setTab] = useState<TabKey>('folders');
  const [username, setUsername] = useState<string | null>(
    localStorage.getItem('chanki_username'),
  );
  const [deviceId, setDeviceId] = useState<string | null>(
    localStorage.getItem('chanki_deviceId'),
  );
  const [settings, setSettings] = useState<AppSettings>(readSettings());

  useEffect(() => {
    if (!deviceId) {
      const next = uuidv4();
      localStorage.setItem('chanki_deviceId', next);
      setDeviceId(next);
    }
  }, [deviceId]);

  useEffect(() => {
    persistSettings(settings);
  }, [settings]);

  const userPath = useMemo(() => (username ? `/u/${username}` : null), [username]);

  if (!username) {
    return (
      <div className="app">
        <header>
          <h1>CHANKI</h1>
          <p>Tu Anki móvil para iOS. Guarda tu nombre de usuario para empezar.</p>
        </header>
        <div className="card">
          <label>
            Nombre de usuario
            <input
              placeholder="Tu nombre"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  const value = (event.target as HTMLInputElement).value.trim();
                  if (value) {
                    localStorage.setItem('chanki_username', value);
                    setUsername(value);
                  }
                }
              }}
            />
          </label>
          <button
            style={{ marginTop: 12 }}
            onClick={() => {
              const input = document.querySelector<HTMLInputElement>('input');
              const value = input?.value.trim();
              if (value) {
                localStorage.setItem('chanki_username', value);
                setUsername(value);
              }
            }}
          >
            Guardar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {tab === 'folders' && userPath && <FoldersPage userPath={userPath} />}
      {tab === 'review' && userPath && <ReviewPage userPath={userPath} settings={settings} />}
      {tab === 'import' && userPath && <ImportPage userPath={userPath} />}
      {tab === 'stats' && userPath && <StatsPage userPath={userPath} />}
      {tab === 'settings' && userPath && (
        <SettingsPage
          username={username}
          onChangeUsername={setUsername}
          settings={settings}
          onUpdateSettings={setSettings}
        />
      )}
      <nav className="nav">
        <button className={tab === 'folders' ? 'active' : ''} onClick={() => setTab('folders')}>
          Carpetas
        </button>
        <button className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}>
          Repasar
        </button>
        <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>
          Importar
        </button>
        <button className={tab === 'stats' ? 'active' : ''} onClick={() => setTab('stats')}>
          Estadísticas
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          Ajustes
        </button>
      </nav>
    </div>
  );
};

export default App;
