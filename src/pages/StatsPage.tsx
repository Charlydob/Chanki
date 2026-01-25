import { useEffect, useMemo, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Tooltip,
  Legend,
} from 'chart.js';
import { Bar, Doughnut, Line } from 'react-chartjs-2';
import { getData } from '../lib/rtdb';
import { DailyStats, Folder } from '../lib/types';

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Tooltip,
  Legend,
);

interface Props {
  userPath: string;
}

const StatsPage = ({ userPath }: Props) => {
  const [daily, setDaily] = useState<Record<string, DailyStats>>({});
  const [folders, setFolders] = useState<Record<string, Folder>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [folderFilter, setFolderFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    try {
      const [folderData, tagsData] = await Promise.all([
        getData<Record<string, Folder>>(`${userPath}/folders`),
        getData<Record<string, Record<string, DailyStats>>>(`${userPath}/stats/byTag`),
      ]);
      setFolders(folderData ?? {});
      setTags(Object.keys(tagsData ?? {}));
    } catch {
      setError('No se pudieron cargar filtros de estadísticas.');
    }
  };

  const loadStats = async () => {
    setError(null);
    try {
      if (folderFilter !== 'all') {
        const data = await getData<Record<string, DailyStats>>(
          `${userPath}/stats/byFolder/${folderFilter}`,
        );
        setDaily(data ?? {});
        return;
      }
      if (tagFilter !== 'all') {
        const data = await getData<Record<string, DailyStats>>(
          `${userPath}/stats/byTag/${tagFilter}`,
        );
        setDaily(data ?? {});
        return;
      }
      const data = await getData<Record<string, DailyStats>>(`${userPath}/stats/daily`);
      setDaily(data ?? {});
    } catch {
      setError('No se pudieron cargar estadísticas.');
    }
  };

  useEffect(() => {
    loadData();
  }, [userPath]);

  useEffect(() => {
    loadStats();
  }, [folderFilter, tagFilter, userPath]);

  const sortedDays = useMemo(() => Object.keys(daily).sort(), [daily]);
  const dailyValues = sortedDays.map((day) => daily[day]);

  const totals = dailyValues.reduce(
    (acc, entry) => {
      acc.reviews += entry.reviews || 0;
      acc.minutes += entry.minutes || 0;
      acc.error += entry.error || 0;
      acc.bad += entry.bad || 0;
      acc.good += entry.good || 0;
      acc.easy += entry.easy || 0;
      return acc;
    },
    { reviews: 0, minutes: 0, error: 0, bad: 0, good: 0, easy: 0 },
  );

  const accuracy = totals.reviews
    ? Math.round(((totals.good + totals.easy) / totals.reviews) * 100)
    : 0;

  const streakInfo = useMemo(() => {
    let current = 0;
    let best = 0;
    let temp = 0;
    for (const day of sortedDays) {
      const entry = daily[day];
      if (entry?.reviews && entry.reviews > 0) {
        temp += 1;
        best = Math.max(best, temp);
      } else {
        temp = 0;
      }
    }
    current = temp;
    return { current, best };
  }, [daily, sortedDays]);

  return (
    <div>
      <header>
        <h2>Estadísticas</h2>
        <p>Revisa tu progreso y consistencia diaria.</p>
      </header>
      {error && <div className="notice error">{error}</div>}
      <div className="card">
        <div className="grid">
          <select
            value={folderFilter}
            onChange={(event) => {
              setFolderFilter(event.target.value);
              setTagFilter('all');
            }}
          >
            <option value="all">Todas las carpetas</option>
            {Object.values(folders)
              .sort((a, b) => a.path.localeCompare(b.path))
              .map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.path}
                </option>
              ))}
          </select>
          <select
            value={tagFilter}
            onChange={(event) => {
              setTagFilter(event.target.value);
              setFolderFilter('all');
            }}
          >
            <option value="all">Todos los tags</option>
            {tags.sort().map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="card">
        <div className="row wrap">
          <span className="badge">Reviews: {totals.reviews}</span>
          <span className="badge">Minutos: {totals.minutes.toFixed(1)}</span>
          <span className="badge">% Acierto: {accuracy}%</span>
          <span className="badge">Racha actual: {streakInfo.current}</span>
          <span className="badge">Mejor racha: {streakInfo.best}</span>
        </div>
      </div>
      <div className="card chart-card">
        <h3>Reviews por día</h3>
        <Bar
          data={{
            labels: sortedDays,
            datasets: [
              {
                label: 'Reviews',
                data: dailyValues.map((entry) => entry.reviews || 0),
                backgroundColor: '#38bdf8',
              },
            ],
          }}
          options={{ responsive: true, plugins: { legend: { display: false } } }}
        />
      </div>
      <div className="card chart-card">
        <h3>Minutos por día</h3>
        <Line
          data={{
            labels: sortedDays,
            datasets: [
              {
                label: 'Minutos',
                data: dailyValues.map((entry) => entry.minutes || 0),
                borderColor: '#facc15',
                backgroundColor: 'rgba(250, 204, 21, 0.2)',
              },
            ],
          }}
          options={{ responsive: true }}
        />
      </div>
      <div className="card chart-card">
        <h3>Distribución de botones</h3>
        <Doughnut
          data={{
            labels: ['Error', 'Malo', 'Bueno', 'Fácil'],
            datasets: [
              {
                data: [totals.error, totals.bad, totals.good, totals.easy],
                backgroundColor: ['#f87171', '#fbbf24', '#38bdf8', '#4ade80'],
              },
            ],
          }}
          options={{ responsive: true }}
        />
      </div>
    </div>
  );
};

export default StatsPage;
