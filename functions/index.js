// ============================================================
//  Lôwe — Cloud Functions
//  Amac: Firestore'daki users/{uid} dokumani degistiginde
//  (rol veya active), kullanicinin kimlik jetonuna custom claim
//  olarak yaz. Boylece Storage kurallari Firestore'a gitmeden
//  jetondaki role/active'i okuyup hizli ve guvenli yetki saglar.
// ============================================================
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

initializeApp();

export const syncRoleClaim = onDocumentWritten(
  { document: "users/{uid}", region: "europe-west3" },
  async (event) => {
    const uid = event.params.uid;
    const after = event.data?.after?.data();

    // Dokuman silindiyse claim'leri temizle
    if (!after) {
      try { await getAuth().setCustomUserClaims(uid, null); } catch (e) { /* kullanici yoksa gec */ }
      return;
    }

    const role = after.role || "viewer";
    const active = after.active === true;

    // Auth hesabi var mi? (profil once, hesap sonra olusabilir)
    try {
      await getAuth().getUser(uid);
    } catch {
      return; // hesap yoksa sessizce cik
    }

    await getAuth().setCustomUserClaims(uid, { role, active });
    console.log(`Claim guncellendi: ${uid} -> role=${role}, active=${active}`);
  }
);
