// ============================================================
//  TOPLU KULLANICI OLUSTURMA (Firebase Admin SDK)
//
//  Bu script, "users.json" icindeki kullanicilari:
//    1) Firebase Authentication'da giris hesabi olarak olusturur
//    2) Firestore "users/{uid}" altinda rolleriyle kaydeder
//
//  Calistirma (scripts/ klasoru icinde):
//    npm install
//    npm run bootstrap
//
//  Gerekli dosyalar (ayni klasorde):
//    - serviceAccountKey.json   (Firebase Console > Proje Ayarlari >
//                                 Hizmet hesaplari > Yeni ozel anahtar olustur)
//    - users.json               (users.example.json'u kopyalayip duzenle)
// ============================================================
import { readFile } from "node:fs/promises";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const VALID_ROLES = ["admin", "manager", "staff", "viewer"];

async function loadJSON(path) {
  try {
    return JSON.parse(await readFile(new URL(path, import.meta.url)));
  } catch (e) {
    console.error(`\n  HATA: ${path} okunamadi.\n  ${e.message}\n`);
    process.exit(1);
  }
}

const serviceAccount = await loadJSON("./serviceAccountKey.json");
const users = await loadJSON("./users.json");

initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth();
const db = getFirestore();

console.log(`\n  ${users.length} kullanici isleniyor...\n`);
let created = 0, updated = 0, failed = 0;

for (const u of users) {
  const { email, password, displayName, role } = u;

  if (!email || !VALID_ROLES.includes(role)) {
    console.error(`  ✗ Atlandi (eksik/yanlis veri): ${email || "?"}  rol="${role}"`);
    failed++; continue;
  }

  try {
    let userRecord;
    try {
      userRecord = await auth.createUser({ email, password, displayName });
      console.log(`  ✓ Hesap olusturuldu: ${email}`);
      created++;
    } catch (e) {
      if (e.code === "auth/email-already-exists") {
        userRecord = await auth.getUserByEmail(email);
        console.log(`  • Hesap zaten var, profil guncelleniyor: ${email}`);
        updated++;
      } else { throw e; }
    }

    await db.collection("users").doc(userRecord.uid).set({
      email,
      displayName: displayName || email,
      role,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });

  } catch (e) {
    console.error(`  ✗ Basarisiz: ${email}  ->  ${e.code || e.message}`);
    failed++;
  }
}

console.log(`\n  Bitti.  Yeni: ${created}  Guncellenen: ${updated}  Hatali: ${failed}\n`);
process.exit(0);
