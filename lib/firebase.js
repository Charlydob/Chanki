import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

export const firebaseConfig = {
  apiKey: "AIzaSyDoBhQOUTw4kD9FmTe5m_6lUIqKvuRCTBs",
  authDomain: "anki-d6b3b.firebaseapp.com",
  projectId: "anki-d6b3b",
  storageBucket: "anki-d6b3b.firebasestorage.app",
  messagingSenderId: "16943240198",
  appId: "1:16943240198:web:042621abeb7322434b1f87",
  databaseURL: "https://anki-d6b3b-default-rtdb.europe-west1.firebasedatabase.app",
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);

export function getDb() {
  return db;
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
