import { inc } from './rtdb';
import { ReviewRating } from './types';

export const dayKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}${month}${day}`;
};

const ratingField = (rating: ReviewRating) => {
  if (rating === 'error') return 'error';
  if (rating === 'bad') return 'bad';
  if (rating === 'good') return 'good';
  return 'easy';
};

export const buildStatsUpdates = (params: {
  usernamePath: string;
  folderId: string;
  tags: string[];
  rating: ReviewRating;
  minutes: number;
  isNew: boolean;
  dateKey: string;
  incrementUnique: boolean;
}) => {
  const { usernamePath, folderId, tags, rating, minutes, isNew, dateKey, incrementUnique } = params;
  const updates: Record<string, unknown> = {};
  const fields = ['reviews', ratingField(rating), 'minutes'];
  if (isNew) fields.push('new');
  if (incrementUnique) fields.push('uniqueCards');

  const build = (base: string) => {
    for (const field of fields) {
      if (field === 'minutes') {
        updates[`${base}/${dateKey}/minutes`] = inc(minutes);
      } else {
        updates[`${base}/${dateKey}/${field}`] = inc(1);
      }
    }
  };

  build(`${usernamePath}/stats/daily`);
  build(`${usernamePath}/stats/byFolder/${folderId}`);
  for (const tag of tags) {
    build(`${usernamePath}/stats/byTag/${tag}`);
  }

  return updates;
};
