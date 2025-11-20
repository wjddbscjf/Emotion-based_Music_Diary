import { Router } from "express";
import { getAudioFeatures, searchTracks } from "../spotify.js";
const r = Router();

r.get("/status", async (req, res, next) => {
  try {
    const sample = await searchTracks("lofi", { limit: 1 });
    res.json({ ok: true, sample: sample[0]?.name || null });
  } catch (e) { next(e); }
});

r.get("/debug/search", async (req, res, next) => {
  try {
    const q = String(req.query.q || "lofi");
    const items = await searchTracks(q, { limit: 5 });
    res.json({
      q,
      count: items.length,
      ids: items.map(i => i.id),
      sample: items[0] ? { id: items[0].id, name: items[0].name } : null
    });
  } catch (e) { next(e); }
});

r.get("/debug/af", async (req, res, next) => {
  try {
    const ids = String(req.query.id || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return res.status(400).json({ error: "id query required" });

    const feats = await getAudioFeatures(ids);
    res.json({ count: feats.length, feats });
  } catch (e) { next(e); }
});

export default r;
