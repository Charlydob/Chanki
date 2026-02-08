const FIREBASE_DB_URL = "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

let dbSdk = null;
let dbSdkPromise = null;

export async function initFirebaseDbSdk() {
  if (dbSdk) return dbSdk;
  if (dbSdkPromise) return dbSdkPromise;
  dbSdkPromise = import(FIREBASE_DB_URL)
    .then((sdk) => {
      dbSdk = sdk;
      return sdk;
    })
    .catch((error) => {
      dbSdkPromise = null;
      throw new Error(`No se pudo cargar Firebase Database SDK: ${error.message || error}`);
    });
  return dbSdkPromise;
}

function requireDbSdkFn(name) {
  if (!dbSdk || typeof dbSdk[name] !== "function") {
    throw new Error(`Firebase Database SDK no inicializado (${name}).`);
  }
  return dbSdk[name];
}

export function getDatabase(...args) { return requireDbSdkFn("getDatabase")(...args); }
export function ref(...args) { return requireDbSdkFn("ref")(...args); }
export function child(...args) { return requireDbSdkFn("child")(...args); }
export function get(...args) { return requireDbSdkFn("get")(...args); }
export function set(...args) { return requireDbSdkFn("set")(...args); }
export function update(...args) { return requireDbSdkFn("update")(...args); }
export function remove(...args) { return requireDbSdkFn("remove")(...args); }
export function onValue(...args) { return requireDbSdkFn("onValue")(...args); }
export function increment(...args) { return requireDbSdkFn("increment")(...args); }
export function query(...args) { return requireDbSdkFn("query")(...args); }
export function orderByChild(...args) { return requireDbSdkFn("orderByChild")(...args); }
export function orderByKey(...args) { return requireDbSdkFn("orderByKey")(...args); }
export function equalTo(...args) { return requireDbSdkFn("equalTo")(...args); }
export function limitToFirst(...args) { return requireDbSdkFn("limitToFirst")(...args); }
export function startAt(...args) { return requireDbSdkFn("startAt")(...args); }
