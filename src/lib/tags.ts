export const normalizeTag = (tag: string) => tag.trim().toLowerCase();

export const parseTags = (raw: string) =>
  raw
    .split(',')
    .map((tag) => normalizeTag(tag))
    .filter(Boolean);
