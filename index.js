const express = require('express');
const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function calculateScore(nutriScore, novaGroup, additivesCount) {
  const nutriPoints = { 'a': 50, 'b': 40, 'c': 30, 'd': 15, 'e': 5 };
  const nutriPts = nutriPoints[nutriScore?.toLowerCase()] || 25;
  const novaPoints = { 1: 30, 2: 20, 3: 10, 4: 0 };
  const novaPts = novaPoints[parseInt(novaGroup)] ?? 15;
  const additivePts = Math.max(0, 20 - ((additivesCount || 0) * 5));
  return nutriPts + novaPts + additivePts;
}

app.get('/scan/:barcode', async (req, res) => {
  try {
    const { barcode } = req.params;

    const offRes = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
    const offData = await offRes.json();
    const product = offData.product;

    if (!product) return res.status(404).json({ error: 'Product not found' });

    const productName = product.product_name || 'Unknown Product';
    const ingredients = product.ingredients_text || '';
    const nutriScore = product.nutriscore_grade || 'c';
    const novaGroup = product.nova_group || 3;
    const additivesCount = product.additives_n || 0;

    const score = calculateScore(nutriScore, novaGroup, additivesCount);

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

    res.json({ productName, ingredients, nutriScore, score, explanation });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
