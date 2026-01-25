import { useEffect, useMemo, useState } from 'react';
import {
  dbRef,
  equalToRef,
  getData,
  limitToFirstRef,
  orderByChildRef,
  pushKey,
  queryRef,
  updateData,
} from '../lib/rtdb';
import { get } from 'firebase/database';
import { Folder } from '../lib/types';

interface Props {
  userPath: string;
}

const FoldersPage = ({ userPath }: Props) => {
  const [folders, setFolders] = useState<Record<string, Folder>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const folderList = useMemo(
    () => Object.values(folders).sort((a, b) => a.path.localeCompare(b.path)),
    [folders],
  );

  const loadFolders = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getData<Record<string, Folder>>(`${userPath}/folders`);
      setFolders(data ?? {});
    } catch (err) {
      setError('No se pudo cargar carpetas. Verifica tu databaseURL.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFolders();
  }, [userPath]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const now = Date.now();
    const id = pushKey(`${userPath}/folders`);
    const parent = parentId ? folders[parentId] : null;
    const path = parent ? `${parent.path}/${newName.trim()}` : newName.trim();
    const folder: Folder = {
      id,
      name: newName.trim(),
      parentId: parentId ?? null,
      path,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await updateData({ [`${userPath}/folders/${id}`]: folder });
      setNewName('');
      setParentId(null);
      await loadFolders();
    } catch (err) {
      setError('No se pudo crear la carpeta.');
    }
  };

  const handleDelete = async (folderId: string) => {
    const hasChild = folderList.some((folder) => folder.parentId === folderId);
    if (hasChild) {
      alert('No puedes borrar una carpeta que tiene subcarpetas.');
      return;
    }
    const cardQuery = queryRef(
      dbRef(`${userPath}/cards`),
      orderByChildRef('folderId'),
      equalToRef(folderId),
      limitToFirstRef(1),
    );
    const cardSnapshot = await get(cardQuery);
    if (cardSnapshot.exists()) {
      alert('No puedes borrar una carpeta que contiene tarjetas.');
      return;
    }
    if (!confirm('¿Seguro que quieres borrar esta carpeta?')) return;
    try {
      await updateData({ [`${userPath}/folders/${folderId}`]: null });
      await loadFolders();
    } catch (err) {
      setError('No se pudo borrar la carpeta.');
    }
  };

  const handleRename = async (folderId: string) => {
    const folder = folders[folderId];
    if (!folder || !editingName.trim()) return;
    const now = Date.now();
    const parent = folder.parentId ? folders[folder.parentId] : null;
    const path = parent ? `${parent.path}/${editingName.trim()}` : editingName.trim();

    try {
      await updateData({
        [`${userPath}/folders/${folderId}/name`]: editingName.trim(),
        [`${userPath}/folders/${folderId}/path`]: path,
        [`${userPath}/folders/${folderId}/updatedAt`]: now,
      });
      setEditingId(null);
      setEditingName('');
      await loadFolders();
    } catch (err) {
      setError('No se pudo renombrar la carpeta.');
    }
  };

  return (
    <div>
      <header>
        <h2>Carpetas</h2>
        <p>Organiza tus tarjetas en rutas anidadas.</p>
      </header>
      {error && (
        <div className="notice error">
          {error} Usa Ajustes &gt; DatabaseURL si hace falta.
        </div>
      )}
      <div className="card">
        <h3>Nueva carpeta</h3>
        <div className="grid">
          <input
            placeholder="Nombre"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <select
            value={parentId ?? ''}
            onChange={(event) => setParentId(event.target.value || null)}
          >
            <option value="">Sin carpeta padre</option>
            {folderList.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.path}
              </option>
            ))}
          </select>
          <button onClick={handleCreate}>Crear carpeta</button>
        </div>
      </div>
      <div className="card">
        <h3>Listado</h3>
        {loading ? (
          <p>Cargando...</p>
        ) : (
          <div className="list">
            {folderList.length === 0 && <p>No hay carpetas todavía.</p>}
            {folderList.map((folder) => (
              <div key={folder.id} className="list-item">
                <div>
                  <div>{folder.path}</div>
                  <small>{folder.id}</small>
                </div>
                <div className="row">
                  {editingId === folder.id ? (
                    <>
                      <input
                        value={editingName}
                        onChange={(event) => setEditingName(event.target.value)}
                      />
                      <button onClick={() => handleRename(folder.id)}>Guardar</button>
                    </>
                  ) : (
                    <>
                      <button
                        className="secondary"
                        onClick={() => {
                          setEditingId(folder.id);
                          setEditingName(folder.name);
                        }}
                      >
                        Renombrar
                      </button>
                      <button className="danger" onClick={() => handleDelete(folder.id)}>
                        Borrar
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default FoldersPage;
