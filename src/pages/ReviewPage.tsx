import { useMemo, useState } from 'react';
import { get } from 'firebase/database';
import { AppSettings } from '../app/App';
import { buildStatsUpdates, dayKey } from '../lib/stats';
import { makeQueueKey } from '../lib/keys';
import {
  dbRef,
  equalToRef,
  getData,
  limitToFirstRef,
  orderByKeyRef,
  queryRef,
  updateData,
} from '../lib/rtdb';
import { nextBucketAndDue } from '../lib/srs';
import { Card, Folder, ReviewRating } from '../lib/types';
import { parseTags } from '../lib/tags';

const bucketPriority = ['immediate', 'lt24h', 'tomorrow', 'week', 'future', 'new'] as const;

interface Props {
  userPath: string;
  settings: AppSettings;
}

interface SessionCard {
  card: Card;
  queueKey: string;
}

const ReviewPage = ({ userPath, settings }: Props) => {
  const [folders, setFolders] = useState<Record<string, Folder>>({});
  const [selectedFolder, setSelectedFolder] = useState<string>('all');
  const [bucketFilters, setBucketFilters] = useState<Record<string, boolean>>({
    new: true,
    immediate: true,
    lt24h: true,
    tomorrow: true,
    week: true,
    future: true,
  });
  const [tags, setTags] = useState('');
  const [session, setSession] = useState<SessionCard[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [reveal, setReveal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastReviewTime, setLastReviewTime] = useState(() => Date.now());

  const folderList = useMemo(
    () => Object.values(folders).sort((a, b) => a.path.localeCompare(b.path)),
    [folders],
  );

  const loadFolders = async () => {
    const data = await getData<Record<string, Folder>>(`${userPath}/folders`);
    setFolders(data ?? {});
  };

  const loadQueueIds = async (bucket: string, limit: number) => {
    const folderPath =
      selectedFolder === 'all'
        ? `${userPath}/queue/${bucket}`
        : `${userPath}/folderQueue/${selectedFolder}/${bucket}`;
    const queueSnapshot = await get(
      queryRef(dbRef(folderPath), orderByKeyRef(), limitToFirstRef(limit)),
    );
    if (!queueSnapshot.exists()) return [] as string[];
    const value = queueSnapshot.val() as Record<string, true>;
    return Object.keys(value).map((key) => key.split('_')[1]);
  };

  const loadCards = async (cardIds: string[]) => {
    const entries = await Promise.all(
      cardIds.map(async (id) => {
        const card = await getData<Card>(`${userPath}/cards/${id}`);
        return card ? { card, queueKey: makeQueueKey(card.srs.dueAt, card.id) } : null;
      }),
    );
    return entries.filter(Boolean) as SessionCard[];
  };

  const startSession = async () => {
    setLoading(true);
    setError(null);
    setReveal(false);
    try {
      await loadFolders();
      const tagFilters = parseTags(tags);
      const queueCards: SessionCard[] = [];
      for (const bucket of bucketPriority) {
        if (!bucketFilters[bucket]) continue;
        const limit = bucket === 'new' ? settings.maxNew : settings.maxReviews;
        const ids = await loadQueueIds(bucket, limit);
        if (ids.length === 0) continue;
        const cards = await loadCards(ids);
        const filtered = cards.filter((entry) => {
          if (tagFilters.length === 0) return true;
          const cardTags = Object.keys(entry.card.tags || {});
          return tagFilters.every((tag) => cardTags.includes(tag));
        });
        queueCards.push(...filtered);
      }
      setSession(queueCards);
      setCurrentIndex(0);
      setReveal(false);
      const now = Date.now();
      setLastReviewTime(now);
    } catch (err) {
      setError('No se pudo cargar la sesión. Verifica tu databaseURL.');
    } finally {
      setLoading(false);
    }
  };

  const current = session[currentIndex];

  const handleRating = async (rating: ReviewRating) => {
    if (!current) return;
    const now = Date.now();
    const { card } = current;
    const next = nextBucketAndDue(card.srs, rating, now);
    const newSrs = {
      ...card.srs,
      bucket: next.bucket,
      dueAt: next.dueAt,
      reps: next.reps,
      lapses: next.lapses,
      ease: next.ease,
      lastReviewedAt: now,
    };
    const oldKey = makeQueueKey(card.srs.dueAt, card.id);
    const newKey = makeQueueKey(next.dueAt, card.id);
    const updates: Record<string, unknown> = {
      [`${userPath}/cards/${card.id}/srs`]: newSrs,
      [`${userPath}/cards/${card.id}/updatedAt`]: now,
      [`${userPath}/queue/${card.srs.bucket}/${oldKey}`]: null,
      [`${userPath}/queue/${next.bucket}/${newKey}`]: true,
      [`${userPath}/folderQueue/${card.folderId}/${card.srs.bucket}/${oldKey}`]: null,
      [`${userPath}/folderQueue/${card.folderId}/${next.bucket}/${newKey}`]: true,
    };

    const dateKey = dayKey(new Date());
    const tags = Object.keys(card.tags || {});
    const seenPath = `${userPath}/stats/unique/${dateKey}/${card.id}`;
    const seen = await getData<boolean>(seenPath);
    const incrementUnique = !seen;
    if (incrementUnique) {
      updates[seenPath] = true;
    }

    const minutes = Math.max(0.25, (now - lastReviewTime) / 60000);
    Object.assign(
      updates,
      buildStatsUpdates({
        usernamePath: userPath,
        folderId: card.folderId,
        tags,
        rating,
        minutes,
        isNew: card.srs.bucket === 'new',
        dateKey,
        incrementUnique,
      }),
    );

    try {
      await updateData(updates);
      setReveal(false);
      setCurrentIndex((prev) => prev + 1);
      setLastReviewTime(now);
    } catch (err) {
      setError('No se pudo guardar la respuesta.');
    }
  };

  return (
    <div>
      <header>
        <h2>Repasar</h2>
        <p>Selecciona filtros y lanza una sesión de estudio.</p>
      </header>
      {error && <div className="notice error">{error}</div>}
      <div className="card">
        <div className="grid">
          <select value={selectedFolder} onChange={(e) => setSelectedFolder(e.target.value)}>
            <option value="all">Todas las carpetas</option>
            {folderList.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.path}
              </option>
            ))}
          </select>
          <label>
            Tags (comma)
            <input value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <div className="grid">
            {bucketPriority.map((bucket) => (
              <label key={bucket} className="row" style={{ alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={bucketFilters[bucket]}
                  onChange={(event) =>
                    setBucketFilters((prev) => ({ ...prev, [bucket]: event.target.checked }))
                  }
                />
                <span>{bucket}</span>
              </label>
            ))}
          </div>
          <button onClick={startSession} disabled={loading}>
            {loading ? 'Cargando...' : 'Iniciar sesión'}
          </button>
        </div>
      </div>

      <div className="card">
        {current ? (
          <div className="grid">
            <div>
              <strong>Frente</strong>
              <p>{current.card.front}</p>
            </div>
            {reveal && (
              <div>
                <strong>Reverso</strong>
                <p>{current.card.back}</p>
              </div>
            )}
            {!reveal ? (
              <button onClick={() => setReveal(true)}>Mostrar respuesta</button>
            ) : (
              <div className="grid">
                <button className="danger" onClick={() => handleRating('error')}>
                  Error
                </button>
                <button className="secondary" onClick={() => handleRating('bad')}>
                  Malo
                </button>
                <button onClick={() => handleRating('good')}>Bueno</button>
                <button onClick={() => handleRating('easy')}>Fácil</button>
              </div>
            )}
            <small>
              {currentIndex + 1} / {session.length}
            </small>
          </div>
        ) : (
          <p>Sin tarjetas en sesión. Ajusta filtros e inicia.</p>
        )}
      </div>
    </div>
  );
};

export default ReviewPage;
