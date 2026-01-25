import { useState } from 'react';
import { AppSettings } from '../app/App';
import { getData } from '../lib/rtdb';
import { resolveDatabaseUrl } from '../lib/firebase';

interface Props {
  username: string;
  onChangeUsername: (value: string | null) => void;
  settings: AppSettings;
  onUpdateSettings: (settings: AppSettings) => void;
}

const SettingsPage = ({ username, onChangeUsername, settings, onUpdateSettings }: Props) => {
  const [nextName, setNextName] = useState('');
  const [databaseUrl, setDatabaseUrl] = useState(resolveDatabaseUrl());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleExport = async () => {
    setError(null);
    setSuccess(null);
    try {
      const data = await getData<Record<string, unknown>>(`/u/${username}`);
      const blob = new Blob([JSON.stringify(data ?? {}, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `chanki-backup-${username}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setSuccess('Backup descargado.');
    } catch (err) {
      setError('No se pudo exportar tu backup.');
    }
  };

  return (
    <div>
      <header>
        <h2>Ajustes</h2>
        <p>Gestiona tu identidad local y preferencias.</p>
      </header>
      {error && <div className="notice error">{error}</div>}
      {success && <div className="notice">{success}</div>}
      <div className="card">
        <h3>Usuario</h3>
        <p>Usuario actual: {username}</p>
        <input
          placeholder="Cambiar usuario"
          value={nextName}
          onChange={(event) => setNextName(event.target.value)}
        />
        <button
          style={{ marginTop: 12 }}
          className="danger"
          onClick={() => {
            if (!nextName.trim()) return;
            if (!confirm('Cambiar de usuario no borra datos, pero cambia tu espacio.')) return;
            localStorage.setItem('chanki_username', nextName.trim());
            onChangeUsername(nextName.trim());
            setNextName('');
          }}
        >
          Cambiar usuario
        </button>
      </div>
      <div className="card">
        <h3>Preferencias de sesión</h3>
        <label>
          Máximo nuevas
          <input
            type="number"
            value={settings.maxNew}
            onChange={(event) =>
              onUpdateSettings({ ...settings, maxNew: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Máximo repaso
          <input
            type="number"
            value={settings.maxReviews}
            onChange={(event) =>
              onUpdateSettings({ ...settings, maxReviews: Number(event.target.value) })
            }
          />
        </label>
      </div>
      <div className="card">
        <h3>Database URL</h3>
        <input value={databaseUrl} onChange={(event) => setDatabaseUrl(event.target.value)} />
        <button
          className="secondary"
          style={{ marginTop: 12 }}
          onClick={() => {
            localStorage.setItem('chanki_databaseUrl', databaseUrl.trim());
            setSuccess('DatabaseURL guardada. Recarga la app.');
          }}
        >
          Guardar DatabaseURL
        </button>
      </div>
      <div className="card">
        <h3>Backups</h3>
        <button onClick={handleExport}>Exportar todo (JSON)</button>
      </div>
    </div>
  );
};

export default SettingsPage;
