import {
  child,
  equalTo,
  get,
  increment,
  limitToFirst,
  orderByChild,
  orderByKey,
  push,
  query,
  ref,
  remove,
  set,
  update,
} from 'firebase/database';
import { database } from './firebase';

export const dbRef = (path: string) => ref(database(), path);

export const getData = async <T>(path: string) => {
  const snapshot = await get(dbRef(path));
  return snapshot.exists() ? (snapshot.val() as T) : null;
};

export const setData = async (path: string, value: unknown) => set(dbRef(path), value);

export const updateData = async (updates: Record<string, unknown>) => update(dbRef('/'), updates);

export const removeData = async (path: string) => remove(dbRef(path));

export const pushKey = (path: string) => push(dbRef(path)).key as string;

export const childRef = child;
export const queryRef = query;
export const orderByKeyRef = orderByKey;
export const orderByChildRef = orderByChild;
export const equalToRef = equalTo;
export const limitToFirstRef = limitToFirst;
export const inc = increment;
