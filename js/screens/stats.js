import { getDb } from "../../lib/firebase.js";
import { userRoot } from "../../lib/rtdb.js";
import { calcStreak, fetchBucketCounts, fetchDailyStats, fetchTotalsStats } from "../../lib/stats.js";
import { BUCKET_LABELS, BUCKET_ORDER, elements, state } from "../shared.js";

function renderWeekChart(daily) {
  const canvas = elements.statsWeekChart;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const values = daily.map((day) => (day.reviews || 0) + (day.new || 0));
  const maxVal = Math.max(1, ...values);
  const padding = 16;
  const chartHeight = height - padding * 2;
  const barWidth = width / values.length;

  values.forEach((value, index) => {
    const barHeight = Math.max(6, (value / maxVal) * chartHeight);
    const x = index * barWidth + barWidth * 0.2;
    const y = height - padding - barHeight;
    const w = barWidth * 0.6;
    const radius = 6;
    ctx.fillStyle = "rgba(139, 92, 246, 0.8)";
    ctx.beginPath();
    ctx.moveTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + barHeight);
    ctx.lineTo(x, y + barHeight);
    ctx.closePath();
    ctx.fill();
  });

  ctx.fillStyle = "rgba(154, 167, 189, 0.8)";
  ctx.font = "10px SF Pro Text, system-ui, sans-serif";
  values.forEach((_, index) => {
    const label = daily[index].key.slice(6);
    const x = index * barWidth + barWidth / 2;
    ctx.fillText(label, x - 6, height - 4);
  });
}

function renderBucketCounts(bucketCounts) {
  const container = elements.statsBucketCounts;
  if (!container) return;
  container.innerHTML = "";
  const maxVal = Math.max(1, ...Object.values(bucketCounts));
  BUCKET_ORDER.forEach((bucket) => {
    const count = bucketCounts[bucket] || 0;
    const row = document.createElement("div");
    row.className = "bucket-count";
    row.innerHTML = `
      <strong>${BUCKET_LABELS[bucket]}</strong>
      <div class="bar"><span style="width: ${Math.max(8, (count / maxVal) * 100)}%"></span></div>
      <small>${count} tarjetas</small>
    `;
    container.appendChild(row);
  });
}

function keyToDateLocal(key) {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(4, 6)) - 1;
  const day = Number(key.slice(6, 8));
  return new Date(year, month, day);
}

function formatDateLabel(date) {
  return date.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
}

function formatDateFull(date) {
  return date.toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" });
}

function renderMonthLineChart(daily) {
  const canvas = elements.statsMonthChart;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const values = daily.map((day) => (day.reviews || 0) + (day.new || 0));
  const maxVal = Math.max(1, ...values);
  const padding = 16;
  const chartHeight = height - padding * 2;
  const step = values.length > 1 ? (width - padding * 2) / (values.length - 1) : 0;
  ctx.strokeStyle = "rgba(139, 92, 246, 0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = padding + index * step;
    const y = height - padding - (value / maxVal) * chartHeight;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  ctx.fillStyle = "rgba(139, 92, 246, 0.8)";
  values.forEach((value, index) => {
    const x = padding + index * step;
    const y = height - padding - (value / maxVal) * chartHeight;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });
}

function renderMonthDonut(stats) {
  const canvas = elements.statsMonthDonut;
  const legend = elements.statsMonthLegend;
  if (!canvas || !legend) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) / 2 - 8;
  const entries = [
    { key: "error", label: "Error", value: stats.error || 0, color: "#fb7185" },
    { key: "bad", label: "Malo", value: stats.bad || 0, color: "#fbbf24" },
    { key: "good", label: "Bueno", value: stats.good || 0, color: "#60a5fa" },
    { key: "easy", label: "Fácil", value: stats.easy || 0, color: "#34d399" },
  ];
  const total = entries.reduce((sum, entry) => sum + entry.value, 0) || 1;
  let startAngle = -Math.PI / 2;
  ctx.clearRect(0, 0, width, height);
  entries.forEach((entry) => {
    const angle = (entry.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.arc(centerX, centerY, radius, startAngle, startAngle + angle);
    ctx.closePath();
    ctx.fillStyle = entry.color;
    ctx.fill();
    startAngle += angle;
  });
  ctx.beginPath();
  ctx.fillStyle = "rgba(12, 16, 28, 0.9)";
  ctx.arc(centerX, centerY, radius * 0.6, 0, Math.PI * 2);
  ctx.fill();

  legend.innerHTML = "";
  entries.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "stats-donut__legend-item";
    item.innerHTML = `
      <span class="stats-donut__swatch" style="background:${entry.color}"></span>
      <span>${entry.label}: ${entry.value}</span>
    `;
    legend.appendChild(item);
  });
}

function renderHeatmap(daily) {
  const container = elements.statsHeatmap;
  const tooltip = elements.statsHeatmapTooltip;
  if (!container) return;
  container.innerHTML = "";
  const firstDate = daily.length ? keyToDateLocal(daily[0].key) : new Date();
  const startOffset = (firstDate.getDay() + 6) % 7;
  for (let i = 0; i < startOffset; i += 1) {
    const empty = document.createElement("div");
    empty.className = "stats-heatmap__cell is-empty";
    container.appendChild(empty);
  }
  const totals = daily.map((day) => (day.reviews || 0) + (day.new || 0));
  const maxVal = Math.max(1, ...totals);
  daily.forEach((day) => {
    const total = (day.reviews || 0) + (day.new || 0);
    const intensity = total === 0 ? 0.08 : 0.15 + (total / maxVal) * 0.7;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "stats-heatmap__cell";
    cell.style.background = `rgba(139, 92, 246, ${intensity.toFixed(2)})`;
    cell.dataset.key = day.key;
    cell.dataset.total = String(total);
    cell.dataset.minutes = String(day.minutes || 0);
    cell.dataset.error = String(day.error || 0);
    cell.dataset.bad = String(day.bad || 0);
    cell.dataset.good = String(day.good || 0);
    cell.dataset.easy = String(day.easy || 0);
    cell.innerHTML = `<span>${total}</span>`;
    container.appendChild(cell);
  });
  if (tooltip && !container.dataset.tooltipBound) {
    container.addEventListener("click", (event) => {
      const cell = event.target.closest(".stats-heatmap__cell");
      if (!cell || cell.classList.contains("is-empty")) return;
      const date = formatDateFull(keyToDateLocal(cell.dataset.key));
      tooltip.innerHTML = `
        <strong>${date}</strong><br />
        ${cell.dataset.total} repasos · ${cell.dataset.minutes} min<br />
        error ${cell.dataset.error} · malo ${cell.dataset.bad} · bueno ${cell.dataset.good} · fácil ${cell.dataset.easy}
      `;
      tooltip.classList.remove("hidden");
    });
    container.dataset.tooltipBound = "true";
  }
}

export async function loadStats() {
  if (!state.username) {
    return;
  }
  const db = getDb();
  const root = userRoot(state.username);
  const now = new Date();
  const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const daysToFetch = Math.max(
    7,
    Math.ceil((now - startOfPrevMonth) / 86400000) + 1
  );
  const [dailyAll, totals, bucketCounts] = await Promise.all([
    fetchDailyStats(db, root, daysToFetch),
    fetchTotalsStats(db, root),
    fetchBucketCounts(db, root),
  ]);
  const daily = dailyAll.slice(-7);
  const today = dailyAll[dailyAll.length - 1] || {};
  const todayTotal = (today.reviews || 0) + (today.new || 0);
  const todayMinutes = today.minutes || 0;
  const weekTotal = daily.reduce((sum, day) => sum + (day.reviews || 0) + (day.new || 0), 0);
  const weekMinutes = daily.reduce((sum, day) => sum + (day.minutes || 0), 0);
  const accuracyBase = todayTotal || 1;
  const accuracy = Math.round((((today.good || 0) + (today.easy || 0)) / accuracyBase) * 100);

  elements.statsTodayCount.textContent = `${todayTotal} repasos`;
  elements.statsTodayMinutes.textContent = `${todayMinutes} min`;
  elements.statsTodayAccuracy.textContent = `${accuracy}%`;

  elements.statsTodayDistribution.innerHTML = "";
  ["error", "bad", "good", "easy"].forEach((rating) => {
    const chip = document.createElement("div");
    chip.className = "stats-chip";
    chip.textContent = `${rating}: ${today[rating] || 0}`;
    elements.statsTodayDistribution.appendChild(chip);
  });

  elements.statsWeekTotal.textContent = `${weekTotal} repasos`;
  elements.statsWeekMinutes.textContent = `${weekMinutes} min`;
  elements.statsWeekAverage.textContent = `${Math.round(weekTotal / 7)} /día`;

  const currentStreak = totals.currentStreak ?? calcStreak(dailyAll);
  const bestStreak = totals.bestStreak ?? currentStreak;
  elements.statsStreakCurrent.textContent = `${currentStreak} días`;
  elements.statsStreakBest.textContent = `${bestStreak} días`;

  const totalCards = totals.totalCards || 0;
  const newCards = totals.newCards || 0;
  const learnedCards = totals.learnedCards || Math.max(0, totalCards - newCards);
  elements.statsTotalCards.textContent = totalCards;
  elements.statsTotalNew.textContent = newCards;
  elements.statsTotalLearned.textContent = learnedCards;

  state.bucketCounts = BUCKET_ORDER.reduce((acc, bucket) => {
    acc[bucket] = bucketCounts?.[bucket] || 0;
    return acc;
  }, {});
  renderBucketCounts(state.bucketCounts);
  renderWeekChart(daily);

  const monthDaily = dailyAll.filter((day) => {
    const date = keyToDateLocal(day.key);
    return date >= startOfCurrentMonth;
  });
  const previousMonthDaily = dailyAll.filter((day) => {
    const date = keyToDateLocal(day.key);
    return date >= startOfPrevMonth && date < startOfCurrentMonth;
  });
  const monthTotal = monthDaily.reduce((sum, day) => sum + (day.reviews || 0) + (day.new || 0), 0);
  const monthDaysCount = monthDaily.length || 1;
  const monthAverage = Math.round(monthTotal / monthDaysCount);
  const bestDay = monthDaily.reduce(
    (best, day) => {
      const total = (day.reviews || 0) + (day.new || 0);
      if (!best || total > best.total) {
        return { key: day.key, total };
      }
      return best;
    },
    null
  );
  if (elements.statsMonthTotal) {
    elements.statsMonthTotal.textContent = `${monthTotal} repasos`;
  }
  if (elements.statsMonthAverage) {
    elements.statsMonthAverage.textContent = `${monthAverage} /día`;
  }
  if (elements.statsMonthBest) {
    elements.statsMonthBest.textContent = bestDay
      ? `${formatDateLabel(keyToDateLocal(bestDay.key))} · ${bestDay.total}`
      : "-";
  }
  if (elements.statsMonthCompare) {
    const prevTotal = previousMonthDaily.reduce(
      (sum, day) => sum + (day.reviews || 0) + (day.new || 0),
      0
    );
    if (prevTotal > 0) {
      const diff = monthTotal - prevTotal;
      const sign = diff >= 0 ? "+" : "-";
      elements.statsMonthCompare.textContent = `${sign}${Math.abs(diff)} vs mes anterior`;
    } else {
      elements.statsMonthCompare.textContent = "Sin datos del mes anterior";
    }
  }

  const last30 = dailyAll.slice(-30);
  renderHeatmap(last30);
  renderMonthLineChart(last30);
  const monthRatings = monthDaily.reduce(
    (acc, day) => {
      acc.error += day.error || 0;
      acc.bad += day.bad || 0;
      acc.good += day.good || 0;
      acc.easy += day.easy || 0;
      return acc;
    },
    { error: 0, bad: 0, good: 0, easy: 0 }
  );
  renderMonthDonut(monthRatings);
}
