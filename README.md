# Cam Temizlik Pazar Yeri — Mimari Özet

## Uçtan uca akış

1. **Abonelik & tahsilat** — İşletme `/subscriptions` ile plan seçer. Iyzico'nun
   Abonelik (recurring) ürünü ile periyodik tahsilat yapılır.
2. **İş oluşturma & atama** — Her temizlik döngüsünde (cron/queue tetikler)
   `POST /jobs` çağrılır:
   - `geoService.assignJobToNearestCleaner` PostGIS `<->` KNN operatörü ile
     iş konumuna en yakın, müsait ve `onboarding_status = 'approved'`
     temizlikçiyi bulur; `FOR UPDATE SKIP LOCKED` ile race condition önlenir.
   - `iyzicoService.chargeJobWithSplit` işletmenin kartından tahsilat yapar;
     `subMerchantKey` + `subMerchantPrice` ile temizlikçi payı **escrow'da**
     tutulur (henüz IBAN'a geçmez).
3. **Fotoğraf yükleme** — Temizlikçi `POST /jobs/:id/photos` ile before/after
   fotoğraf yükler.
4. **AI onayı** — "after" fotoğrafı geldiğinde `POST /jobs/:id/review`
   tetiklenir: `aiVerificationService` vision-capable bir modelle temizlik
   kalitesini 0–1 arası puanlar.
   - **Onay ≥ 0.75** → `iyzicoService.approvePayoutToCleaner` çağrılır; iyzico
     escrow tutarını temizlikçinin sub-merchant hesabına serbest bırakır
     (fiili IBAN transferi iyzico'nun settlement takvimine göre gerçekleşir).
   - **Onay < 0.75** → `disapprovePayout` ile escrow reddedilir, iş
     `ai_rejected` durumuna düşer, manuel inceleme kuyruğuna gider.

## Iyzico Pazaryeri kurulum ön koşulu

- Iyzico hesabınızın **Pazaryeri (Marketplace)** ürünü için işaretlenmiş
  olması gerekir (entegrasyon@iyzico.com üzerinden talep edilir).
- Her temizlikçi, ilk kayıtta **bir kez** `onboarding/submerchant` ile
  alt üye işyeri olarak kaydedilmeli (`iyzicoService.onboardCleanerAsSubmerchant`);
  dönen `subMerchantKey` `cleaners` tablosuna yazılmalı ve
  `onboarding_status = 'approved'` olmadan o temizlikçiye iş atanmamalı.

## Kurulum

```bash
npm install
createdb glass_marketplace
psql glass_marketplace < schema.sql
cp .env.example .env   # DATABASE_URL, IYZICO_API_KEY, IYZICO_SECRET_KEY, ANTHROPIC_API_KEY
npm run dev
```

## Sonraki adımlar (önerilen)

- Abonelik döngüsüne göre otomatik iş oluşturma cron/worker'ı
- Temizlikçi tarafı için gerçek zamanlı konum güncelleme endpoint'i
  (`PATCH /cleaners/:id/location`)
- İyzico webhook'ları ile ödeme durum senkronizasyonu (3D Secure, iade vb.)
- `ai_rejected` durumundaki işler için manuel moderasyon paneli
