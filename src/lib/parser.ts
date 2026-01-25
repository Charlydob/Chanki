import { normalizeTag } from './tags';

export interface ParsedCard {
  front: string;
  back: string;
  folderPath: string | null;
  tags: string[];
}

const unescapeDelimiter = (value: string) => value.replace(/\\::/g, '::');

const parseFormatA = (lines: string[]): ParsedCard[] => {
  const cards: ParsedCard[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let separatorIndex = -1;
    for (let i = 0; i < raw.length - 1; i += 1) {
      if (raw[i] === '\\\\') {
        i += 1;
        continue;
      }
      if (raw[i] === ':' && raw[i + 1] === ':') {
        separatorIndex = i;
        break;
      }
    }
    if (separatorIndex === -1) continue;
    const frontRaw = raw.slice(0, separatorIndex).trim();
    const backRaw = raw.slice(separatorIndex + 2).trim();
    const front = unescapeDelimiter(frontRaw);
    const back = unescapeDelimiter(backRaw);
    if (!front || !back) continue;
    cards.push({ front, back, folderPath: null, tags: [] });
  }
  return cards;
};

const parseFormatB = (text: string): ParsedCard[] => {
  const blocks = text.split(/\n---\n/);
  const cards: ParsedCard[] = [];
  let headerFolder: string | null = null;
  let headerTags: string[] = [];

  for (const block of blocks) {
    const lines = block.split(/\n/);
    for (const line of lines) {
      if (line.startsWith('FOLDER:')) {
        headerFolder = line.replace('FOLDER:', '').trim();
      }
      if (line.startsWith('TAGS:')) {
        const rawTags = line.replace('TAGS:', '').split(',');
        headerTags = rawTags.map((tag) => normalizeTag(tag)).filter(Boolean);
      }
    }

    const frontLine = lines.find((line) => line.startsWith('FRONT:'));
    const backLine = lines.find((line) => line.startsWith('BACK:'));
    if (!frontLine || !backLine) continue;
    const front = frontLine.replace('FRONT:', '').trim();
    const back = backLine.replace('BACK:', '').trim();
    if (!front || !back) continue;

    cards.push({
      front,
      back,
      folderPath: headerFolder,
      tags: headerTags,
    });
  }

  return cards;
};

export const parseImportText = (text: string): ParsedCard[] => {
  const hasHeader = /FOLDER:|FRONT:|BACK:/m.test(text);
  if (hasHeader) {
    return parseFormatB(text);
  }
  return parseFormatA(text.split(/\n/));
};
