/**
 * Temizlikçinin yüklediği "after" fotoğrafını (mümkünse "before" ile
 * karşılaştırarak) bir vision-capable LLM'e göndererek temizlik
 * kalitesini puanlar. Sağlayıcı bağımsız tutulmuştur — Anthropic
 * Messages API (vision) veya benzeri bir servisle değiştirilebilir.
 */

const DECISION_THRESHOLD = 0.75;

const VERIFICATION_PROMPT = `
Sana bir cam temizlik işinden önce ve sonra çekilmiş iki fotoğraf (varsa)
veya yalnızca sonuç fotoğrafı verilecek. Görevin:
1) Camların/yüzeylerin leke, toz, çizgi izi veya kir kalıntısı içerip içermediğini değerlendir.
2) 0.000 ile 1.000 arasında bir "cleanliness_score" ver (1.000 = kusursuz temizlik).
3) Kararını kısaca gerekçelendir.

Yalnızca şu JSON formatında yanıt ver, başka hiçbir metin ekleme:
{"cleanliness_score": 0.00, "reasoning": "..."}
`.trim();

async function verifyCleaningPhoto({ beforePhotoUrl, afterPhotoUrl }) {
  const content = [{ type: 'text', text: VERIFICATION_PROMPT }];
  if (beforePhotoUrl) content.push({ type: 'image', source: { type: 'url', url: beforePhotoUrl } });
  content.push({ type: 'image', source: { type: 'url', url: afterPhotoUrl } });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content }],
    }),
  });

  const data = await response.json();
  const text = data.content?.map((b) => b.text || '').join('') || '{}';
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

  return {
    cleanlinessScore: parsed.cleanliness_score,
    reasoning: parsed.reasoning,
    isApproved: parsed.cleanliness_score >= DECISION_THRESHOLD,
    rawResponse: data,
  };
}

module.exports = { verifyCleaningPhoto, DECISION_THRESHOLD };
