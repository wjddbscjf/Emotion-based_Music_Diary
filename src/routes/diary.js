import { Router } from "express";
import { analyzeDiary } from "../openai.js";
const r = Router();

r.get("/", (req, res) => {
  res.render("diary", { analysis: req.session.analysis || null });
});

r.post("/analyze", async (req, res, next) => {
  try {
    const { text } = req.body;
    const result = await analyzeDiary(text || "");
    req.session.analysis = { ...result, at: Date.now(), raw: text || "" };
    res.redirect("/recommend");
  } catch (e) { next(e); }
});

export default r;
