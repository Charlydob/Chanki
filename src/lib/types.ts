export type Bucket = 'new' | 'immediate' | 'lt24h' | 'tomorrow' | 'week' | 'future';

export type ReviewRating = 'error' | 'bad' | 'good' | 'easy';

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export interface CardSrs {
  bucket: Bucket;
  dueAt: number;
  reps: number;
  lapses: number;
  ease: number;
  lastReviewedAt: number | null;
}

export interface Card {
  id: string;
  folderId: string;
  front: string;
  back: string;
  tags: Record<string, true>;
  createdAt: number;
  updatedAt: number;
  srs: CardSrs;
}

export interface DailyStats {
  reviews: number;
  minutes: number;
  streak: number;
  error: number;
  bad: number;
  good: number;
  easy: number;
  new: number;
  uniqueCards: number;
}
