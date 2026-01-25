import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getDatabase, ref, get } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDoBhQOUTw4kD9FmTe5m_6lUIqKvuRCTBs",
  authDomain: "anki-d6b3b.firebaseapp.com",
  projectId: "anki-d6b3b",
  storageBucket: "anki-d6b3b.firebasestorage.app",
  messagingSenderId: "16943240198",
  appId: "1:16943240198:web:042621abeb7322434b1f87",
};

const DEFAULT_DB_URL = "https://anki-d6b3b-default-rtdb.europe-west1.firebasedatabase.app";

export const databaseURL = localStorage.getItem("chanki_database_url") || DEFAULT_DB_URL;

export const app = initializeApp(firebaseConfig);

export function getDatabaseUrl() {
  return localStorage.getItem("chanki_database_url") || DEFAULT_DB_URL;
}

export function getDb(url = getDatabaseUrl()) {
  return getDatabase(app, url);
}

export async function testConnection(url = getDatabaseUrl()) {
  try {
    const tempDb = getDatabase(app, url);
    await get(ref(tempDb, ".info/connected"));
    return true;
  } catch (error) {
    return false;
  }
}

export function setDatabaseUrl(url) {
  if (!url) {
    localStorage.removeItem("chanki_database_url");
    return;
  }
  localStorage.setItem("chanki_database_url", url);
}

export function ensureDeviceId() {
  let id = localStorage.getItem("chanki_deviceId");
  if (!id) {
    id = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `device_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("chanki_deviceId", id);
  }
  return id;
}
