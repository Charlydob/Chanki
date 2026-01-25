import { useMemo, useState } from 'react';
import { parseImportText, ParsedCard } from '../lib/parser';
import { normalizeTag } from '../lib/tags';
import { initSrs } from '../lib/srs';
import { makeQueueKey } from '../lib/keys';
import { Folder } from '../lib/types';
import { getData, pushKey, updateData } from '../lib/rtdb';

interface Props {
  userPath: string;
}

const ImportPage = ({ userPath }: Props) => {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ParsedCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const previewInfo = useMemo(() => {
    const count = preview.length;
    const folder = preview[0]?.folderPath || 'Inbox';
    return { count, folder };
  }, [preview]);

  const generatePreview = () => {
    setError(null);
    const parsed = parseImportText(text);
    setPreview(parsed);
  };

  const ensureFolders = async (paths: string[]) => {
    const existing = (await getData<Record<string, Folder>>(`${userPath}/folders`)) || {};
    const byPath = new Map<string, string>();
    Object.values(existing).forEach((folder) => byPath.set(folder.path, folder.id));

    const updates: Record<string, unknown> = {};
    const now = Date.now();

    for (const path of paths) {
      const segments = path.split('/').map((part) => part.trim()).filter(Boolean);
      let currentPath = '';
      let parentId: string | null = null;
      for (const segment of segments) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        if (byPath.has(currentPath)) {
          parentId = byPath.get(currentPath) ?? null;
          continue;
        }
        const id = pushKey(`${userPath}/folders`);
        const folder: Folder = {
          id,
          name: segment,
          parentId,
          path: currentPath,
          createdAt: now,
          updatedAt: now,
        };
        updates[`${userPath}/folders/${id}`] = folder;
        byPath.set(currentPath, id);
        parentId = id;
      }
    }

    if (Object.keys(updates).length > 0) {
      await updateData(updates);
    }

    return byPath;
  };

  const handleSave = async () => {
    if (preview.length === 0) {
      setError('No hay tarjetas válidas para importar.');
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const folderPaths = preview.map((card) => card.folderPath || 'Inbox');
      const folderMap = await ensureFolders([...new Set(folderPaths)]);
      const now = Date.now();
      const updates: Record<string, unknown> = {};

      for (const card of preview) {
        const folderPath = card.folderPath || 'Inbox';
        const folderId = folderMap.get(folderPath);
        if (!folderId) continue;
        const id = pushKey(`${userPath}/cards`);
        const tags = card.tags.reduce<Record<string, true>>((acc, tag) => {
          const normalized = normalizeTag(tag);
          if (normalized) acc[normalized] = true;
          return acc;
        }, {});
        const srs = initSrs(now);
        const newCard = {
          id,
          folderId,
          front: card.front,
          back: card.back,
          tags,
          createdAt: now,
          updatedAt: now,
          srs,
        };
        const queueKey = makeQueueKey(srs.dueAt, id);
        updates[`${userPath}/cards/${id}`] = newCard;
        updates[`${userPath}/queue/${srs.bucket}/${queueKey}`] = true;
        updates[`${userPath}/folderQueue/${folderId}/${srs.bucket}/${queueKey}`] = true;
      }

      await updateData(updates);
      setSuccess(`Importadas ${preview.length} tarjetas.`);
      setText('');
      setPreview([]);
    } catch (err) {
      setError('Error al importar tarjetas.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <header>
        <h2>Importar</h2>
        <p>Pega tarjetas en formato rápido o con encabezados.</p>
      </header>
      {error && <div className="notice error">{error}</div>}
      {success && <div className="notice">{success}</div>}
      <div className="card">
        <textarea
          placeholder="front :: back\nFOLDER: Alemán/Verbos\nTAGS: a1, daily\nFRONT: ...\nBACK: ..."
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="secondary" onClick={generatePreview}>
            Previsualizar
          </button>
          <button onClick={handleSave} disabled={loading}>
            {loading ? 'Guardando...' : 'Guardar tarjetas'}
          </button>
        </div>
      </div>
      <div className="card">
        <h3>Preview</h3>
        <p>
          Tarjetas: {previewInfo.count} | Carpeta destino: {previewInfo.folder}
        </p>
        {preview.slice(0, 5).map((card, index) => (
          <div key={`${card.front}-${index}`} className="notice">
            <strong>{card.front}</strong>
            <div>{card.back}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ImportPage;
