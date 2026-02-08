import { getDatabase, initFirebaseDbSdk } from "./firebase-db.js";

export const firebaseConfig = {
  apiKey: "AIzaSyDoBhQOUTw4kD9FmTe5m_6lUIqKvuRCTBs",
  authDomain: "anki-d6b3b.firebaseapp.com",
  projectId: "anki-d6b3b",
  storageBucket: "anki-d6b3b.firebasestorage.app",
  messagingSenderId: "16943240198",
  appId: "1:16943240198:web:042621abeb7322434b1f87",
  databaseURL: "https://anki-d6b3b-default-rtdb.europe-west1.firebasedatabase.app",
};

let appInstance = null;
let dbInstance = null;
let initPromise = null;

function validateFirebaseConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Falta la configuración de Firebase.");
  }
  if (!config.apiKey || !config.projectId || !config.databaseURL) {
    throw new Error("Configuración de Firebase incompleta.");
  }
}

export async function initFirebase() {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    validateFirebaseConfig(firebaseConfig);
    const [{ initializeApp }] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
      initFirebaseDbSdk(),
    ]);
    appInstance = initializeApp(firebaseConfig);
    dbInstance = getDatabase(appInstance);
    return dbInstance;
  })().catch((error) => {
    initPromise = null;
    throw new Error(`No se pudo inicializar Firebase: ${error.message || error}`);
  });

  return initPromise;
}

export function getDb() {
  if (!dbInstance) {
    throw new Error("Firebase no está inicializado.");
  }
  return dbInstance;
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
