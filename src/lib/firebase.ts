import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: 'AIzaSyDoBhQOUTw4kD9FmTe5m_6lUIqKvuRCTBs',
  authDomain: 'anki-d6b3b.firebaseapp.com',
  projectId: 'anki-d6b3b',
  storageBucket: 'anki-d6b3b.firebasestorage.app',
  messagingSenderId: '16943240198',
  appId: '1:16943240198:web:042621abeb7322434b1f87',
};

const defaultDatabaseUrl = 'https://anki-d6b3b-default-rtdb.firebaseio.com';

const app = initializeApp(firebaseConfig);

export const resolveDatabaseUrl = () => {
  const fromEnv = import.meta.env.VITE_FIREBASE_DATABASE_URL as string | undefined;
  const fromStorage = localStorage.getItem('chanki_databaseUrl') || undefined;
  return fromEnv || fromStorage || defaultDatabaseUrl;
};

export const database = () => getDatabase(app, resolveDatabaseUrl());
