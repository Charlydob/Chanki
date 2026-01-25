import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
  get,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDoBhQOUTw4kD9FmTe5m_6lUIqKvuRCTBs",
  authDomain: "anki-d6b3b.firebaseapp.com",
  projectId: "anki-d6b3b",
  storageBucket: "anki-d6b3b.firebasestorage.app",
  messagingSenderId: "16943240198",
  appId: "1:16943240198:web:042621abeb7322434b1f87",
};

const DEFAULT_DB_URL = "https://anki-d6b3b-default-rtdb.firebaseio.com";

let app = null;
let db = null;

export function getDatabaseUrl() {
  return localStorage.getItem("chanki_database_url") || DEFAULT_DB_URL;
}

export function initFirebase() {
  const databaseURL = getDatabaseUrl();
  if (!app) {
    app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  }
  db = getDatabase(app, databaseURL);
  return db;
}

export function getDb() {
  if (!db) {
    initFirebase();
  }
  return db;
}

export async function testConnection() {
  try {
    const databaseURL = getDatabaseUrl();
    if (!app) {
      app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    }
    const tempDb = getDatabase(app, databaseURL);
    await get(ref(tempDb, ".info/connected"));
    return true;
  } catch (error) {
    return false;
  }
}

export function setDatabaseUrl(url) {
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
