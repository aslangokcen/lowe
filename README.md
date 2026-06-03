<div align="center">
  <img src="public/logo.png" alt="Lôwe" width="96" />
  <h1>Lôwe</h1>
  <p><strong>Kurumsal yönetim paneli + BIST borsa karar-destek platformu</strong></p>
  <p>Rol bazlı kullanıcı yönetimi · içerik/rapor/belge yönetimi · çok katmanlı hisse skorlama</p>
</div>

---

## Genel Bakış

Lôwe, tek bir uygulamada iki şeyi birleştirir:

1. **Kurumsal yönetim** — içerik, rapor (sürüm geçmişiyle) ve belge (dosya yükleme + önizleme) yönetimi; 4 seviyeli rol sistemi.
2. **Borsa karar-destek** — BIST hisselerini teknik + temel + makro + haber + risk olarak puanlayan, ağırlıklı genel skor ve sınıflandırma üreten; canlı grafik, haber akışı ve strateji/kod üretici içeren bir analiz platformu.

> Yatırım tavsiyesi değildir. Skorlar, açık verilerden üretilen tahmini karar-destek göstergeleridir.

## Özellikler

### Yönetim
- **Rol bazlı erişim** (sunucuda zorlanır): Yönetici · Müdür · Personel · İzleyici
- **İçerik & Raporlar** — kategori, filtre, otomatik sürüm geçmişi
- **Belgeler** — sürükle-bırak dosya yükleme (PDF/Excel/resim), tarayıcı içi önizleme
- **Kullanıcı yönetimi**, site ayarları, kullanıcı şifre değişimi

### Borsa
- **Hisse arama** (otomatik tamamlama) + **otomatik veri** (ad, sektör, fiyat, değişim)
- **Otomatik skorlama** — Teknik (EMA/RSI/MACD/hacim) + Temel (FK/PD-DD/ROE/marj); elle düzeltme seçeneğiyle
- **Genel skor** = ağırlıklı 5 skor → 6 sınıf (Güçlü Alım Adayı → Uzak Dur)
- **Hisse detayı** — TradingView grafiği + haber akışı + KAP bildirimleri + makro duyarlılık profili
- **Tüm Hisseler** (BIST tarayıcı), **Alarmlar** (4 seviye), **Haberler** (canlı Türkçe akış)
- **Strateji ağırlıkları** (hazır presetler) ve **kod üretici** (Pine Script · Python · MatriksIQ C# · JSON)

## Mimari

| Katman | Teknoloji |
|--------|-----------|
| Önyüz | Saf HTML/CSS/JS (derleme gerektirmez), Firebase Web SDK v12 |
| Kimlik & Yetki | Firebase Authentication + custom claims (rol/aktiflik) |
| Veritabanı | Cloud Firestore (Avrupa bölgesi, KVKK uyumlu) |
| Dosya | Cloud Storage (rol bazlı kurallar) |
| Sunucu | Cloud Functions (veri köprüsü: hisse/haber/makro + rol senkronu) |
| Barındırma | Firebase Hosting |

```
public/        → önyüz (index.html, app.js, styles.css, logo)
functions/     → Cloud Functions (index.js, lib.js)
scripts/       → toplu kullanıcı oluşturma aracı
firestore.rules, storage.rules → güvenlik kuralları
SETUP.md       → adım adım kurulum rehberi
```

## Kurulum

Ayrıntılı, adım adım rehber için **[SETUP.md](SETUP.md)**. Özetle:

```bash
npm install -g firebase-tools
firebase login
firebase use --add            # kendi Firebase projeniz
cp public/config.example.js public/config.js   # kendi Firebase web config'iniz
firebase deploy
```

## Güvenlik

- Tüm yetkiler **Firestore/Storage güvenlik kurallarında sunucu tarafında** zorlanır (tarayıcıdan aşılamaz).
- `public/config.js` (gerçek Firebase config) depoya **dahil değildir** — `config.example.js` şablonu kullanılır.
- Firebase Web API anahtarı **HTTP-referrer kısıtlıdır** (yalnızca yetkili alan adlarından çalışır).
- Kullanıcı metinleri XSS'e karşı kaçışlanır; varsayılan-yasak Firestore kuralı vardır.

## Lisans

[MIT](LICENSE)
