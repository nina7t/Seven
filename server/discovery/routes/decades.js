const express = require('express');
const { listDecades, nextDecadeBatch } = require('../decades');

const router = express.Router();

// GET /api/decades → liste des radios par décennie
router.get('/', (req, res) => res.json({ decades: listDecades() }));

// POST /api/decades/next  { decade: "1980", excludeKeys?: [...], limit?: 20 }
router.post('/next', async (req, res) => {
  try {
    const { decade, excludeKeys, limit } = req.body || {};
    const keys = Array.isArray(excludeKeys) ? excludeKeys.filter(k => typeof k === 'string').slice(-500) : [];
    const result = await nextDecadeBatch(decade, { excludeKeys: keys, limit: parseInt(limit, 10) || 20 });
    if (!result) return res.status(404).json({ error: 'Décennie inconnue' });
    if (!result.tracks.length) return res.status(502).json({ error: 'Aucun titre disponible pour le moment' });
    res.json(result);
  } catch (e) {
    console.error('[decades/next]', e);
    res.status(500).json({ error: e.message || 'Erreur lors du chargement de la radio' });
  }
});

module.exports = router;
