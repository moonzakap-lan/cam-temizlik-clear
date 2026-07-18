# Deployment Rehberi — Supabase (DB) + Render.com (Backend)

## 1) Supabase'de Veritabanı Kurulumu

### 1.1 Proje oluştur
1. [supabase.com](https://supabase.com) → **New Project**.
2. Bölge olarak backend'i deploy edeceğin Render bölgesine en yakın olanı seç
   (gecikmeyi azaltır — ör. ikisi de Frankfurt/EU ise iyi).
3. Güçlü bir DB şifresi belirle, bir yere not al.

### 1.2 PostGIS eklentisini aç
Şema `GEOGRAPHY` tipini ve `ST_DWithin`/`<->` operatörlerini kullanıyor —
bunlar PostGIS gerektirir:

- Supabase Dashboard → **Database** → **Extensions** → `postgis` ara → **Enable**.

### 1.3 Şemayı uygula
İki yoldan biriyle `schema.sql`'i çalıştır:

**A) Supabase SQL Editor (en hızlısı, önerilen ilk kurulum için)**
- Dashboard → **SQL Editor** → **New query**
- `schema.sql` içeriğini yapıştır → **Run**

**B) Yerelden migration scripti ile**
```bash
# .env dosyanda DATABASE_URL'i Supabase connection string'i ile doldur, sonra:
npm run db:migrate
```

### 1.4 Doğru connection string'i seç (önemli)
Supabase → **Project Settings** → **Database** → **Connection string** altında
3 seçenek var:

| Tip | Port | Ne zaman kullanılır |
|---|---|---|
| Direct connection | 5432 | Tek sunucu, düşük trafik; IPv6 gerektirir |
| **Session pooler** | 5432 | **Render gibi kalıcı/uzun ömürlü sunucular için önerilen** — IPv4 uyumlu, `pg.Pool` ile sorunsuz çalışır |
| Transaction pooler | 6543 | Serverless/edge fonksiyonları (Vercel, Lambda) için — kısa ömürlü, çok sayıda eşzamanlı bağlantı |

Render bir konteynerde 7/24 çalışan tek bir Node process'i olduğu için
**Session pooler**'ı kullan. `.env.example` dosyasındaki format:

```
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

`src/db.js` zaten `localhost` içermeyen her `DATABASE_URL` için otomatik
`ssl: { rejectUnauthorized: false }` uyguluyor — Supabase SSL zorunlu kıldığı
için bu ayar olmadan bağlantı reddedilir.

### 1.5 Doğrulama
SQL Editor'da hızlı bir kontrol:
```sql
select postgis_version();
select count(*) from cleaners;  -- 0 dönmeli, hata vermemeli
```

---

## 2) `package.json` Düzenlemeleri (Render için)

Render, Node sürümünü `package.json`'daki `engines` alanından veya
`.node-version` dosyasından okur; build/start komutlarını da doğrudan
`scripts`'ten çalıştırır. Zaten şu şekilde güncellendi:

```json
{
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "start": "node src/app.js",
    "dev": "nodemon src/app.js",
    "db:migrate": "node scripts/migrate.js"
  },
  "devDependencies": {
    "nodemon": "^3.1.4"
  }
}
```

Dikkat edilmesi gerekenler:
- `nodemon`'ı `dependencies`'den `devDependencies`'e taşıdım — Render production
  build'inde gereksiz paket indirmemek için (`npm install --omit=dev` gibi bir
  şey Render'da zorunlu değil ama iyi pratik).
- `start` komutu doğrudan `node` ile çalışıyor; Render bu komutu `npm start`
  olarak çağıracak, ekstra bir process manager (pm2 vb.) gerekmiyor çünkü
  Render zaten süreci kendi container'ında yönetiyor.
- `engines.node` belirtmek, Render'ın hangi Node sürümünü kullanacağını net
  şekilde sabitler (belirtilmezse Render'ın o anki varsayılan sürümünü kullanır,
  bu da zamanla değişip beklenmedik uyumsuzluk yaratabilir).

`src/app.js`'te ekstra bir değişiklik gerekmiyor: Express'in `app.listen(PORT)`
çağrısı zaten tüm arayüzlere (`0.0.0.0`) bind ediyor ve `PORT` ortam
değişkenini okuyor — Render `PORT`'u otomatik enjekte eder, sen ekstra bir şey
yapmana gerek yok.

---

## 3) Render.com'da Web Service Oluşturma

### 3.1 Kodun GitHub'da olması gerekiyor
```bash
cd glass-marketplace
git init
git add .
git commit -m "Initial commit"
git remote add origin <senin-repo-url'in>
git push -u origin main
```
> `.env` dosyasını **asla** commit'leme — `.gitignore`'a `.env` ekli olduğundan emin ol.

### 3.2 Servisi oluştur
1. Render Dashboard → **New +** → **Web Service**
2. GitHub reponu bağla, ilgili repoyu seç
3. Ayarlar:
   - **Language/Environment**: `Node`
   - **Region**: Supabase projenle aynı/yakın bölge
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: aşağıdaki nota bak

### 3.3 Ortam değişkenleri
**Advanced** → **Add Environment Variable** (veya "Add from .env" ile
`.env.example`'ı referans alarak tek tek doldur):

```
DATABASE_URL       = (Supabase Session pooler string'in)
NODE_ENV            = production
IYZICO_API_KEY      = (sandbox veya prod key)
IYZICO_SECRET_KEY   = (sandbox veya prod key)
IYZICO_BASE_URL     = https://sandbox-api.iyzipay.com   (prod: https://api.iyzipay.com)
ANTHROPIC_API_KEY   = (sk-ant-...)
```
`PORT`'u kendin eklemene gerek yok — Render otomatik sağlıyor.

### 3.4 Health check
**Advanced** → **Health Check Path** → `/health`
(bu endpoint zaten `src/app.js`'te tanımlı; Render bunu deploy sonrası ve
periyodik canlılık kontrolü için kullanır, servis "unhealthy" görünürse
otomatik restart eder).

### 3.5 Deploy
**Create Web Service** → Render ilk build+deploy'u başlatır. **Events**
sekmesinden logları izleyebilirsin. Başarılı olursa
`https://<servis-adın>.onrender.com` altında yayında olur.

### 3.6 Free tier hakkında önemli not
Render'ın Free instance tipi **15 dakika trafik almazsa container'ı
uyutuyor**; bir sonraki istekte 30-60 saniyelik "cold start" gecikmesi
oluyor. Senin sistemin işletme aboneliği tahsilatı ve AI onay webhook'larını
gerçek zamanlı işlediği için, bu gecikme özellikle **Iyzico callback'lerinde
timeout riski** yaratabilir. Production'a geçerken en azından **Starter**
plana (aylık ücretli, spin-down yok) geçmeni öneririm; sandbox/test
aşamasında Free tier sorun değil.

---

## 4) Deploy Sonrası Doğrulama

```bash
curl https://<servis-adın>.onrender.com/health
# {"status":"ok"} dönmeli

# Uçtan uca test (sandbox iyzico key'leriyle):
curl -X POST https://<servis-adın>.onrender.com/subscriptions \
  -H "Content-Type: application/json" \
  -d '{"businessId":"...", "planId":"...", "iyzicoSubscriptionReferenceCode":"..."}'
```

Şema/tablo eksikliği gibi hatalar burada 500 olarak dönerse önce Supabase
SQL Editor'dan `select * from information_schema.tables where table_schema='public';`
ile tabloların gerçekten oluştuğunu doğrula.

## 5) Sıradaki adım
Her push'ta Render otomatik yeniden deploy ediyor (auto-deploy açık gelir).
İstersen bir sonraki adımda GitHub Actions ile deploy öncesi test/migration
adımını CI'a bağlayabiliriz, ya da temizlikçi onboarding akışını (KYC formu →
`onboarding/submerchant`) tamamlayabiliriz.
