import { Router } from "express";
import { recommend } from "../reco.js";

/* ================== [추가] ================== */
import { pickEmotionQuote } from "../emotionQuotes.js";
/* ============================================ */

const r = Router();

r.get("/", async (req, res, next) => {
  try {
    const analysis = req.session.analysis;
    if (!analysis) return res.redirect("/diary");

    const recos = await recommend(analysis, { topK: 24 });

    /* ================== [추가] ================== */
    const emotionQuote = pickEmotionQuote(analysis.mood);
    /* ============================================ */

    res.render("recommendations", {
      analysis,
      recos,
      /* ================== [추가] ================== */
      emotionQuote,
      /* ============================================ */
    });
  } catch (e) {
    next(e);
  }
});

export default r;
