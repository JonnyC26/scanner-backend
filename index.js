const express = require('express');
const app = express();
app.use(express.json());
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function calculateScore(nutriScore, novaGroup, additivesCount, isOrganic, protein) {
  const nutriPoints = { 'a': 50, 'b': 40, 'c': 30, 'd': 15, 'e': 5 };
  const nutriPts = nutriPoints[nutriScore?.toLowerCase()] || 25;
  const novaPoints = { 1: 20, 2: 15, 3: 10, 4: 0 };
  const novaPts = novaPoints[parseInt(novaGroup)] ?? 10;
  const additivePts = Math.max(0, 20 - ((additivesCount || 0) * 5));
  const organicPts = isOrganic ? 10 : 0;
  const proteinPts = (protein && protein >= 10) ? 5 : 0;
  const rawScore = nutriPts + novaPts + additivePts + organicPts + proteinPts;
  return Math.min(100, Math.round(rawScore));
}

app.get('/scan/:barcode', async (req, res) => {
  try {
    const { barcode } = req.params;
    const offRes = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
    const offData = await offRes.json();
    const product = offData.product;
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const productName = product.product_name || 'Unknown Product';
    const imageUrl = product.image_url || '';
    const ingredients = product.ingredients_text || '';
    const nutriScore = product.nutriscore_grade || 'c';
    const novaGroup = product.nova_group || 3;
    const additivesCount = product.additives_n || 0;
    const isOrganic = product.labels_tags?.includes('en:organic') || false;
    const protein = product.nutriments?.proteins_100g || 0;
    const score = calculateScore(nutriScore, novaGroup, additivesCount, isOrganic, protein);
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{ role: 'user', content: `Food ingredients: ${ingredients}. In one plain English sentence (max 20 words), explain the main health concern or benefit for a regular consumer.` }]
      })
    });
    const claudeData = await claudeRes.json();
    const explanation = claudeData.content[0].text;
    const scoreColor = score >= 75 ? '#2E7D32' : score >= 50 ? '#8BC34A' : score >= 25 ? '#FF9800' : '#F44336';
    res.json({ productName, ingredients, nutriScore, score, explanation, scoreColor });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
