/**
 * Iyzico Pazaryeri (Marketplace) entegrasyonu.
 *
 * Akış 3 adımdan oluşur (iyzico'nun resmi modeli):
 *   1) Alt Üye Oluşturma  -> POST /onboarding/submerchant   (temizlikçi kaydı, bir kere)
 *   2) Ödeme               -> POST /payment/auth             (subMerchantKey + subMerchantPrice ile bölüştürme, tutar escrow'da tutulur)
 *   3) Onay (Onay)          -> POST /payment/iyzipos/item/approve  (AI onayından sonra escrow tutarı alt üyeye serbest bırakılır)
 *
 * MOCK MOD: IYZICO_API_KEY ortam değişkeni tanımlı değilse (ya da
 * MOCK_PAYMENTS=true ise), gerçek iyzico çağrısı yapılmaz — sahte ama
 * gerçekçi şekilde biçimlendirilmiş bir başarı sonucu döner. Bu sayede
 * abonelik/iş/fotoğraf/AI onay akışının tamamı, gerçek Iyzico hesabı
 * kurulmadan uçtan uca test edilebilir. Iyzico entegre edilmeye hazır
 * olduğunda IYZICO_API_KEY + IYZICO_SECRET_KEY Render'a eklenince mock
 * mod otomatik olarak devre dışı kalır — kodda değişiklik gerekmez.
 */

const Iyzipay = require('iyzipay');

const MOCK_MODE = !process.env.IYZICO_API_KEY || process.env.MOCK_PAYMENTS === 'true';

const iyzipay = MOCK_MODE
  ? null
  : new Iyzipay({
      apiKey: process.env.IYZICO_API_KEY,
      secretKey: process.env.IYZICO_SECRET_KEY,
      uri: process.env.IYZICO_BASE_URL || 'https://sandbox-api.iyzipay.com',
    });

if (MOCK_MODE) {
  console.warn('[iyzicoService] MOCK_MODE aktif — gerçek Iyzico çağrısı yapılmıyor, sahte başarı dönülüyor.');
}

function toPromise(method, request) {
  return new Promise((resolve, reject) => {
    method.call(iyzipay, request, (err, result) => {
      if (err) return reject(err);
      if (result.status !== 'success') return reject(new Error(result.errorMessage || 'iyzico error'));
      resolve(result);
    });
  });
}

function mockId(prefix) {
  return `${prefix}-mock-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

/**
 * ADIM 1 — Temizlikçiyi bireysel (PERSONAL) alt üye işyeri olarak kaydeder.
 * Dönen subMerchantKey, cleaners.iyzico_submerchant_key kolonuna yazılmalıdır.
 */
async function onboardCleanerAsSubmerchant(cleaner) {
  if (MOCK_MODE) return mockId('submerchant');

  const request = {
    locale: Iyzipay.LOCALE.TR,
    conversationId: `onboard-${cleaner.id}`,
    subMerchantExternalId: cleaner.id,
    subMerchantType: Iyzipay.SUB_MERCHANT_TYPE.PERSONAL,
    address: cleaner.address || 'Adres bilgisi girilmedi',
    contactName: cleaner.full_name.split(' ')[0],
    contactSurname: cleaner.full_name.split(' ').slice(1).join(' ') || '-',
    email: cleaner.email,
    gsmNumber: cleaner.phone,
    name: `${cleaner.full_name} - Cam Temizlik`,
    iban: cleaner.iban,
    identityNumber: cleaner.tc_identity_number,
    currency: Iyzipay.CURRENCY.TRY,
  };

  const result = await toPromise(iyzipay.subMerchant.create, request);
  return result.subMerchantKey;
}

/**
 * ADIM 2 — İşletmeden abonelik/iş ücretini tahsil eder ve tutarı
 * platform payı + temizlikçi payı olarak böler. Temizlikçiye giden pay
 * AI onayı verilene kadar iyzico'da escrow'da (hakediş) bekletilir.
 *
 * price = business'tan çekilecek toplam tutar
 * cleanerPayoutAmount = temizlikçinin subMerchantPrice payı
 */
async function chargeJobWithSplit({ job, business, cleaner, card, conversationId }) {
  const platformCommission = (job.price - job.cleaner_payout_amount).toFixed(2);

  if (MOCK_MODE) {
    return {
      iyzicoPaymentId: mockId('payment'),
      iyzicoPaymentTransactionId: mockId('txn'),
      rawResponse: { mock: true, note: 'MOCK_MODE — gerçek ödeme yapılmadı' },
      platformCommission,
    };
  }

  const request = {
    locale: Iyzipay.LOCALE.TR,
    conversationId,
    price: job.price.toFixed(2),
    paidPrice: job.price.toFixed(2),
    currency: Iyzipay.CURRENCY.TRY,
    installment: '1',
    paymentChannel: Iyzipay.PAYMENT_CHANNEL.WEB,
    paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
    paymentCard: {
      cardHolderName: card.holderName,
      cardNumber: card.number,
      expireMonth: card.expireMonth,
      expireYear: card.expireYear,
      cvc: card.cvc,
      registerCard: '0', // '1' yapılırsa iyzico kartı saklar ve bir sonraki adımda paymentCardToken kullanılabilir
    },
    buyer: {
      id: business.id,
      name: business.contact_name,
      surname: '-',
      email: business.email,
      identityNumber: '11111111111', // KYC alanı; gerçek entegrasyonda işletme vergi/kimlik no
      registrationAddress: business.address,
      ip: business.last_known_ip || '0.0.0.0',
      city: business.city || 'Istanbul',
      country: 'Turkey',
    },
    basketItems: [
      {
        id: job.id,
        name: 'Cam Temizlik Hizmeti',
        category1: 'Temizlik',
        itemType: Iyzipay.BASKET_ITEM_TYPE.PHYSICAL,
        price: job.price.toFixed(2),
        subMerchantKey: cleaner.iyzico_submerchant_key,
        subMerchantPrice: job.cleaner_payout_amount.toFixed(2),
      },
    ],
  };

  const result = await toPromise(iyzipay.payment.create, request);

  return {
    iyzicoPaymentId: result.paymentId,
    iyzicoPaymentTransactionId: result.itemTransactions?.[0]?.paymentTransactionId,
    rawResponse: result,
    platformCommission,
  };
}

/**
 * ADIM 3 — Onay. AI kalite kontrolü işi onayladığında çağrılır;
 * escrow'daki subMerchantPrice tutarını temizlikçinin IBAN'ına
 * aktarılmak üzere serbest bırakır (fiili IBAN transferi iyzico'nun
 * settlement takvimine göre gerçekleşir).
 */
async function approvePayoutToCleaner({ paymentTransactionId, conversationId }) {
  if (MOCK_MODE) return { status: 'success', mock: true };

  const request = {
    locale: Iyzipay.LOCALE.TR,
    conversationId,
    paymentTransactionId,
  };

  return toPromise(iyzipay.approval.create, request);
}

/**
 * AI onaylamazsa: escrow tutarı iade edilir / reddedilir.
 */
async function disapprovePayout({ paymentTransactionId, conversationId }) {
  if (MOCK_MODE) return { status: 'success', mock: true };

  const request = {
    locale: Iyzipay.LOCALE.TR,
    conversationId,
    paymentTransactionId,
  };
  return toPromise(iyzipay.disapproval.create, request);
}

module.exports = {
  onboardCleanerAsSubmerchant,
  chargeJobWithSplit,
  approvePayoutToCleaner,
  disapprovePayout,
  MOCK_MODE,
};
