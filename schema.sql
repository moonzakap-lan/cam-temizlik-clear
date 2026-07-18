-- =====================================================================
-- CAM TEMİZLİK HİZMETİ PAZAR YERİ — VERİTABANI ŞEMASI (PostgreSQL 15+)
-- Coğrafi sorgular (en yakın temizlikçi) için PostGIS zorunludur.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- ENUM TİPLERİ
-- ---------------------------------------------------------------------
CREATE TYPE subscription_status AS ENUM ('trialing','active','past_due','cancelled','expired');
CREATE TYPE cleaner_onboarding_status AS ENUM ('pending','submitted','approved','rejected');
CREATE TYPE job_status AS ENUM (
  'pending_assignment',   -- oluşturuldu, temizlikçi aranıyor
  'assigned',              -- temizlikçiye atandı
  'en_route',              -- yolda
  'in_progress',           -- işe başladı
  'submitted_for_review',  -- fotoğraf yüklendi, AI onayı bekleniyor
  'ai_rejected',           -- AI onaylamadı -> manuel inceleme / yeniden çekim
  'approved',              -- AI onayladı, ödeme tetiklenecek
  'paid',                  -- iyzico onay (escrow release) tamamlandı
  'disputed',              -- işletme itiraz etti
  'cancelled'
);
CREATE TYPE photo_type AS ENUM ('before','after');
CREATE TYPE payment_type AS ENUM ('subscription_charge','cleaner_payout');
CREATE TYPE payment_status AS ENUM ('pending','success','failure','refunded');

-- ---------------------------------------------------------------------
-- BUSINESSES (Müşteri işletmeler)
-- ---------------------------------------------------------------------
CREATE TABLE businesses (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_name        VARCHAR(255) NOT NULL,
  contact_name        VARCHAR(255) NOT NULL,
  email               VARCHAR(255) UNIQUE NOT NULL,
  phone               VARCHAR(32) NOT NULL,
  address             TEXT NOT NULL,
  location            GEOGRAPHY(POINT, 4326) NOT NULL,   -- lat/lng
  iyzico_buyer_id     VARCHAR(64),                        -- iyzico "buyer" referansı
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_businesses_location ON businesses USING GIST (location);

-- ---------------------------------------------------------------------
-- PLANS (abonelik paketleri)
-- ---------------------------------------------------------------------
CREATE TABLE plans (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                VARCHAR(100) NOT NULL,             -- ör: "Aylık 2x Cam Temizliği"
  billing_period      VARCHAR(20) NOT NULL,               -- MONTHLY, WEEKLY
  cleanings_per_cycle SMALLINT NOT NULL,
  price               NUMERIC(10,2) NOT NULL,
  currency            CHAR(3) NOT NULL DEFAULT 'TRY',
  iyzico_pricing_plan_reference_code VARCHAR(64),          -- iyzico Abonelik ürünündeki plan kodu
  is_active           BOOLEAN NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------
-- SUBSCRIPTIONS
-- ---------------------------------------------------------------------
CREATE TABLE subscriptions (
  id                              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id                     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan_id                         UUID NOT NULL REFERENCES plans(id),
  status                          subscription_status NOT NULL DEFAULT 'trialing',
  iyzico_subscription_reference_code VARCHAR(64),          -- iyzico tarafındaki abonelik ID
  current_period_start            TIMESTAMPTZ NOT NULL,
  current_period_end              TIMESTAMPTZ NOT NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at                    TIMESTAMPTZ
);
CREATE INDEX idx_subscriptions_business ON subscriptions(business_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);

-- ---------------------------------------------------------------------
-- CLEANERS (temizlikçiler — iyzico Alt Üye İşyeri / sub-merchant)
-- ---------------------------------------------------------------------
CREATE TABLE cleaners (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name                   VARCHAR(255) NOT NULL,
  email                       VARCHAR(255) UNIQUE NOT NULL,
  phone                       VARCHAR(32) NOT NULL,
  tc_identity_number          VARCHAR(11),                 -- bireysel alt üye için zorunlu
  iban                        VARCHAR(34) NOT NULL,
  location                    GEOGRAPHY(POINT, 4326),      -- son bilinen konum
  location_updated_at         TIMESTAMPTZ,
  is_available                BOOLEAN NOT NULL DEFAULT false,
  rating_avg                  NUMERIC(3,2) DEFAULT 5.00,
  active_job_count             SMALLINT NOT NULL DEFAULT 0,
  -- Iyzico Pazaryeri alt üye işyeri alanları
  iyzico_submerchant_key      VARCHAR(64) UNIQUE,           -- onboarding/submerchant yanıtından döner
  iyzico_submerchant_type     VARCHAR(20) NOT NULL DEFAULT 'PERSONAL', -- PERSONAL | PRIVATE_COMPANY | LIMITED_OR_JOINT_STOCK_COMPANY
  onboarding_status           cleaner_onboarding_status NOT NULL DEFAULT 'pending',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cleaners_location ON cleaners USING GIST (location);
CREATE INDEX idx_cleaners_availability ON cleaners(is_available) WHERE is_available = true;

-- ---------------------------------------------------------------------
-- JOBS (iş atamaları)
-- ---------------------------------------------------------------------
CREATE TABLE jobs (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id         UUID NOT NULL REFERENCES subscriptions(id),
  business_id             UUID NOT NULL REFERENCES businesses(id),
  cleaner_id              UUID REFERENCES cleaners(id),
  status                  job_status NOT NULL DEFAULT 'pending_assignment',
  service_address         TEXT NOT NULL,
  location                GEOGRAPHY(POINT, 4326) NOT NULL,
  scheduled_at             TIMESTAMPTZ NOT NULL,
  price                   NUMERIC(10,2) NOT NULL,          -- işletmeden tahsil edilen toplam tutar
  cleaner_payout_amount   NUMERIC(10,2) NOT NULL,          -- temizlikçiye gidecek pay (subMerchantPrice)
  platform_commission     NUMERIC(10,2) NOT NULL,          -- price - cleaner_payout_amount
  -- İşlemin bağlı olduğu iyzico ödeme kaydı (tahsilat anında oluşur, escrow'da bekler)
  payment_id              UUID,                             -- FK payments(id), aşağıda tanımlı
  assigned_at             TIMESTAMPTZ,
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  ai_reviewed_at           TIMESTAMPTZ,
  approved_at             TIMESTAMPTZ,
  paid_at                 TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_cleaner ON jobs(cleaner_id);
CREATE INDEX idx_jobs_location ON jobs USING GIST (location);

-- ---------------------------------------------------------------------
-- JOB PHOTOS
-- ---------------------------------------------------------------------
CREATE TABLE job_photos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  photo_type    photo_type NOT NULL,
  storage_url   TEXT NOT NULL,          -- S3 / Cloudflare R2 vb. URL
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_job_photos_job ON job_photos(job_id);

-- ---------------------------------------------------------------------
-- AI VERIFICATIONS (temizlik kalite kontrolü sonuçları)
-- ---------------------------------------------------------------------
CREATE TABLE ai_verifications (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id            UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  before_photo_id   UUID REFERENCES job_photos(id),
  after_photo_id    UUID REFERENCES job_photos(id),
  ai_provider       VARCHAR(50) NOT NULL,          -- ör: "claude-vision", "gpt-4o-vision"
  cleanliness_score NUMERIC(4,3) NOT NULL,          -- 0.000 - 1.000
  decision_threshold NUMERIC(4,3) NOT NULL DEFAULT 0.750,
  is_approved       BOOLEAN NOT NULL,
  raw_response      JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_verifications_job ON ai_verifications(job_id);

-- ---------------------------------------------------------------------
-- PAYMENTS (hem işletme tahsilatı hem temizlikçi hakediş onayı)
-- ---------------------------------------------------------------------
CREATE TABLE payments (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id                      UUID REFERENCES jobs(id),
  subscription_id             UUID REFERENCES subscriptions(id),
  type                        payment_type NOT NULL,
  status                      payment_status NOT NULL DEFAULT 'pending',
  amount                      NUMERIC(10,2) NOT NULL,
  currency                    CHAR(3) NOT NULL DEFAULT 'TRY',
  iyzico_payment_id           VARCHAR(64),           -- iyzico "paymentId"
  iyzico_payment_transaction_id VARCHAR(64),         -- Onay (approve) çağrısında kullanılan itemTransactionId
  iyzico_conversation_id      VARCHAR(64),
  raw_response                JSONB,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_job ON payments(job_id);

ALTER TABLE jobs ADD CONSTRAINT fk_jobs_payment FOREIGN KEY (payment_id) REFERENCES payments(id);

-- ---------------------------------------------------------------------
-- EN YAKIN MÜSAİT TEMİZLİKÇİYİ BULMA (KNN — PostGIS <-> operatörü index kullanır)
-- ---------------------------------------------------------------------
-- Örnek kullanım: jobs.location'a göre en yakın 5 müsait temizlikçi
-- SELECT id, full_name, location <-> $1::geography AS distance_m
-- FROM cleaners
-- WHERE is_available = true AND onboarding_status = 'approved'
-- ORDER BY location <-> $1::geography
-- LIMIT 5;
