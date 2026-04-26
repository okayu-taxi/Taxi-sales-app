import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
} from "firebase/auth";
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

const googleProvider = new GoogleAuthProvider();

export const subscribeAuth = (cb) => onAuthStateChanged(auth, cb);
export const signOutUser = () => signOut(auth);

export async function signInWithGoogle() {
  await signInWithPopup(auth, googleProvider);
}

export async function signUpWithEmail(email, password) {
  await createUserWithEmailAndPassword(auth, email, password);
}

export async function signInWithEmail(email, password) {
  await signInWithEmailAndPassword(auth, email, password);
}

export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

export async function pushToFirestore(uid, data) {
  await setDoc(doc(db, "users", uid), { data, updatedAt: Date.now() });
}

export async function pullFromFirestore(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}
