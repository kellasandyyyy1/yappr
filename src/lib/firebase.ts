/// <reference types="vite/client" />
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { 
  initializeFirestore,
  doc, 
  getDocFromServer, 
  serverTimestamp,
  Timestamp,
  type Firestore
} from "firebase/firestore";
import { getStorage } from "firebase/storage";

// Configuration comes from the environment only.
//
// This previously imported firebase-applet-config.json as a fallback, which
// (a) committed an API key to the repo and (b) made the build fail outright
// once that file was removed. Every value below is already present in
// .env.local; VITE_-prefixed vars are the supported source.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
  throw new Error(
    "Firebase config missing. Set VITE_FIREBASE_API_KEY and VITE_FIREBASE_PROJECT_ID " +
    "(and the other VITE_FIREBASE_* vars) in .env.local."
  );
}

const databaseId = import.meta.env.VITE_FIREBASE_DATABASE_ID;

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Use initializeFirestore instead of getFirestore to enable long polling
// this helps with connection issues in some environments
export const db: Firestore = initializeFirestore(app, {
  experimentalForceLongPolling: true,
}, (databaseId as string) || '(default)');

export const storage = getStorage(app);

export { serverTimestamp, Timestamp };

// Test connection silently
async function testConnection() {
  try {
    await getDocFromServer(doc(db, "test", "connection"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("unavailable")) {
      console.warn("Firestore backend is currently unavailable. This may be a transient network issue.");
    }
  }
}
testConnection();
