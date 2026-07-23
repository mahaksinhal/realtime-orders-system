const logger = require('../utils/logger');

async function generateInsight(promptText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn('GEMINI_API_KEY is not configured. AI Order Copilot is disabled.');
    return null;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: promptText }]
        }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Gemini API HTTP Error ${response.status}: ${errorText}`);
      return null;
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      logger.error('Gemini API returned an empty or unexpected response format: ' + JSON.stringify(data));
      return null;
    }

    return text.trim();
  } catch (err) {
    logger.error('Failed to communicate with Gemini API:', err);
    return null;
  }
}

module.exports = { generateInsight };
