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
  } catch (e) {
    //기존 제거: next(e);

    // ★ MODIFIED START: 분석 실패 시 calm fallback 적용
    req.session.analysis = {
      mood: "calm",
      keywords: ["ambient", "soft", "instrumental"],
      energy: 0.3,
      valence: 0.6,
      at: Date.now(),
      raw: req.body?.text || "",
      fallback: true,
    };
    res.redirect("/recommend");
    // ★ MODIFIED DONE
  }
});

export default r;
