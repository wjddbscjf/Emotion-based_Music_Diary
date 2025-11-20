import { Router } from "express";
import { recommend } from "../reco.js";
const r = Router();

r.get("/", async (req, res, next) => {
  try {
    const analysis = req.session.analysis;
    if (!analysis) return res.redirect("/diary");
    const recos = await recommend(analysis, { topK: 24 });
    res.render("recommendations", { analysis, recos });
  } catch (e) { next(e); }
});

export default r;
