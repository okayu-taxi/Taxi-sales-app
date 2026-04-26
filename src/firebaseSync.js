import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged, signOut } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDP7i5Tjwv8WiDiFpqRV-7CMrGc4RmXelU",
  authDomain: "taxi-sales-management.firebaseapp.com",
  projectId: "taxi-sales-management",
  storageBucket: "taxi-sales-management.firebasestorage.app",
  messagingSenderId: "654715705854",
  appId: "1:654715705854:web:bb14e51c34953703bf08af",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const subscribeAuth = (cb) => onAuthStateChanged(auth, cb);
export const signInAnon = () => signInAnonymously(auth);
export const signOutUser = () => signOut(auth);

export async function pushToFirestore(uid, data) {
  await setDoc(doc(db, "users", uid), { data, updatedAt: Date.now() });
}

export async function pullFromFirestore(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}
