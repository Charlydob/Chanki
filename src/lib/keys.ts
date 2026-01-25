export const dueAtPad13 = (dueAt: number) => dueAt.toString().padStart(13, '0');

export const makeQueueKey = (dueAt: number, cardId: string) => `${dueAtPad13(dueAt)}_${cardId}`;
