const express = require('express');
const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function calculateScore(nutriScore, novaGroup, riskyAdditives) {
  const nutriPoints = { 'a': 50, 'b': 40, 'c': 30, 'd': 15, 'e': 5 };
  const nutriPts = nutriPoints[nutriScore?.toLowerCase()] || 25;
  const novaPoints = { 1: 30, 2: 20, 3: 10, 4: 0 };
  const novaPts = novaPoints[parseInt(novaGroup)] ?? 15;
  const additivePts = Math.max(0, 20 - ((riskyAdditives || 0) * 5));
  return nutriPts + novaPts + additivePts;
}

app.post('/score', async (req, res) => {
  try {
    const { ingredients, nutriscore, nova_group, risky_additives_count } = req.body;
    const score = calculateScore(nutriscore, nova_group, risky_additives_count);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{ role: 'user', content: `These are the ingredients: ${ingredients}. In one plain English sentence (max 20 words), explain the main health concern or benefit.` }]
      })
    });
    const data = await response.json();
    const explanation = data.content[0].text;
    res.json({ score, explanation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
