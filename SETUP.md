# Kurumsal Panel — Kurulum Rehberi

Bu rehber, web panelini **Google Cloud (Firebase)** üzerinde ücretsiz olarak ayağa
kaldırmak içindir. Adımlar kısa; takıldığın her yerde bana yazarsın, beraber yaparız.

> **Güvenlik:** Bana asla şifre/parola gönderme. Sadece **firebaseConfig** (aşağıda)
> paylaşılabilir — o herkese açık olacak şekilde tasarlanmıştır, güvenliği sunucudaki
> kurallar sağlar.

---

## 0) Roller ve yetkiler (kurduğumuz sistem)

| Rol | Etiket | Görüntüle | Ekle/Düzenle | Sil | Kullanıcı yönetimi |
|-----|--------|:--------:|:-----------:|:---:|:------------------:|
| `admin`   | Yönetici (2 kişi)  | ✅ | ✅ | ✅ | ✅ |
| `manager` | Müdür (5 kişi)     | ✅ | ✅ | ✅ | ❌ |
| `staff`   | Personel (5 kişi)  | ✅ | ✅ | ❌ | ❌ |
| `viewer`  | İzleyici (6 kişi)  | ✅ | ❌ | ❌ | ❌ |

Toplam **18 kullanıcı**. Bu kurallar tarayıcıda değil **sunucuda** zorlanır → kimse
geliştirici aracıyla bile yetkisini aşamaz.

---

## A) Firebase (Google Cloud) projesini oluştur

1. https://console.firebase.google.com adresine **Google hesabınla** gir.
2. **“Proje ekle”** → bir isim ver (örn. `kurumsal-panel`) → Google Analytics’i
   **kapatabilirsin** (sade kurulum) → **Oluştur**.
   *(Bu işlem arka planda bir Google Cloud projesi de oluşturur — ikisi aynı şeydir.)*

### A.1 Girişi aç (Authentication)
3. Sol menü → **Build > Authentication > Get started**.
4. **Sign-in method** sekmesi → **Email/Password** → **Enable** → Kaydet.

### A.2 Veritabanını oluştur (Firestore)
5. Sol menü → **Build > Firestore Database > Create database**.
6. **Konum (location):** Avrupa seç → **`eur3 (Europe)`** veya **`europe-west3 (Frankfurt)`**.
   ⚠️ **Bu seçim kalıcıdır, sonradan değişmez.** (KVKK/GDPR + Türkiye’ye düşük gecikme)
7. **Production mode** ile başlat → **Enable**. *(Kuralları biz zaten yazdık, deploy edeceğiz.)*

### A.3 (İsteğe bağlı, ileride) Dosya saklama (Storage)
8. **Build > Storage > Get started.** Bu adım faturalandırmayı (Blaze) etkinleştirmeni
   isteyebilir — $300 hediye kredin olduğu için **bir süre yine $0** ödersin.
   **Şimdilik atlayabilirsin**, dosya özelliğine geçince beraber açarız.

### A.4 Web uygulaması anahtarlarını al (firebaseConfig)
9. Sol üstte **dişli ⚙️ > Project settings > General**.
10. Aşağıda **“Your apps”** → **Web simgesi `</>`** → bir takma ad yaz (örn. `panel-web`)
    → **Register app**.
11. Ekranda çıkan **`firebaseConfig = { ... }`** bloğunu kopyala.

➡️ **Bu bloğu bana gönder** (ya da `public/config.js` içine yapıştır). Örnek:
```js
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "kurumsal-panel.firebaseapp.com",
  projectId: "kurumsal-panel",
  storageBucket: "kurumsal-panel.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef..."
};
```

---

## B) Yayına al (deploy)

Bu komutları Terminal’de proje klasöründe çalıştır (`/Users/aslangokcen/kurumsal-panel`).
İstersen bu adımı **ben senin için yapayım** — sadece A.4’teki config’i ver yeter.

```bash
# 1) Firebase komut satırı aracını kur (tek seferlik)
npm install -g firebase-tools

# 2) Google hesabınla giriş yap (tarayıcı açılır)
firebase login

# 3) Bu projeyi seç (projenin ID'sini listeden seçeceksin)
firebase use --add

# 4) Güvenlik kurallarını + web sitesini yayınla
firebase deploy --only firestore:rules,hosting
```

Bitince site adresin şöyle olur: **`https://PROJE-ID.web.app`**
(Kendi alan adını da sonra buraya bağlayabiliriz — ücretsiz SSL ile.)

---

## C) 18 kullanıcıyı tek seferde oluştur

1. **Hizmet hesabı anahtarı indir:** Console → ⚙️ **Project settings > Service accounts**
   → **Generate new private key** → inen dosyayı `scripts/serviceAccountKey.json`
   olarak kaydet.
   ⚠️ Bu dosya **gizlidir** (yöneticinin tam yetkisi). Kimseyle paylaşma, git’e ekleme
   (zaten `.gitignore`’da). İstersen kullanım sonrası Console’dan iptal edebilirsin.
2. `scripts/users.example.json` dosyasını **`scripts/users.json`** adıyla kopyala ve
   e-posta / şifre / isimleri **kendi kişilerinle** düzenle. (Dağılım hazır: 2 yönetici,
   5 müdür, 5 personel, 6 izleyici.)
3. Terminal’de:
```bash
cd scripts
npm install
npm run bootstrap
```
   → Tüm hesaplar oluşur ve rolleri atanır. İlk yöneticiler artık panelden **diğer
   herkesin rolünü/durumunu** yönetebilir.

> Not: Bu scripti de **ben çalıştırabilirim** ya da ekranını paylaşarak beraber yaparız.
> Anahtar dosyasını paylaşmak istemezsen, adım adım senin yapmanı sağlarım.

---

## D) Maliyet özeti

| Aşama | Ne kullanıyoruz | Aylık |
|-------|------------------|-------|
| Şimdi → uzun süre | Firebase ücretsiz katman + $300 kredi | **$0** |
| Trafik/dosya artınca | Blaze (kullandıkça öde) | Sadece limiti aşınca, çok düşük |
| Gerçek ölçek / ağır doküman işleme | Cloud SQL / Cloud Run / Document AI | ~$80–100 (sen onaylayınca) |

Ücretsiz katman: e-posta/şifre girişinde **50.000 kullanıcı**, Firestore **1 GB +
günde 50K okuma/20K yazma**, **1 GB dosya**, ücretsiz barındırma (SSL + alan adı).

---

## E) Bana ne verirsen ben yaparım?

- **En azından:** A.4’teki `firebaseConfig` → ben deploy dahil her şeyi hallederim.
- **İstersen:** Ekranını Chrome eklentisiyle paylaş, A adımlarını beraber tıklayalım.
- **Şifre/anahtar paylaşmak istemezsen:** Her adımı tek tek anlatırım, sen yaparsın.

Hazır olduğunda config’i gönder; gerisini ilerletelim. 🚀
