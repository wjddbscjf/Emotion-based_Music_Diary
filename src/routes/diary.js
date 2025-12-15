import { Router } from "express";
import { analyzeDiaryAndBuildSpotify } from "../openai.js";

const r = Router();

// 세션 저장 + 로그
function saveAndLog(req, { analysis, searchQueries, recommendationParams }) {
  // 분석 결과 세션에 저장
  req.session.analysis = analysis;
  req.session.spotify = { searchQueries, recommendationParams };

  // 서버 콘솔 로그
  console.log("[flow] openai.analysis:", analysis);
  console.log("[flow] openai.searchQueries:", searchQueries);
  console.log("[flow] openai.recParams:", recommendationParams);
}

// 일기 입력 페이지 렌더링
r.get("/", (req, res) => {
  res.render("diary", { analysis: req.session.analysis || null });
});

// 일기 분석 요청 처리(성공 시 OpenAI 결과 저장, 실패 시 fallback 저장)
r.post("/analyze", async (req, res) => {
  // 입력 텍스트 
  const text = String(req.body?.text || "");
  const now = Date.now();

  try {
    const { analysis, searchQueries, recommendationParams } =
      await analyzeDiaryAndBuildSpotify(text);

    // 성공 시 at/raw를 분석 결과에 포함
    saveAndLog(req, {
      analysis: { ...analysis, at: now, raw: text },
      searchQueries,
      recommendationParams,
    });

    return res.redirect("/recommend");
  } catch (e) {
    // 분석 실패 시
    const errMsg = e?.message || String(e);

    const analysis = {
      mood: "calm",
      keywords: ["ambient", "soft", "instrumental"],
      genres: [],
      energy: 0.3,
      valence: 0.6,
      tempo: null,
      at: now,
      raw: text,
      fallback: true,
      __fallbacks: [{ field: "openai", got: errMsg, used: "fallback" }],
    };

    const searchQueries = ["ambient piano", "lofi chill", "soft instrumental"];
    const recommendationParams = {
      seed_genres: ["lo-fi"],
      target_energy: 0.3,
      target_valence: 0.6,
      market: "KR",
      limit: 30,
    };

    console.warn("[flow] openai failed -> fallback:", errMsg); 
    saveAndLog(req, { analysis, searchQueries, recommendationParams }); 

    return res.redirect("/recommend");
  }
});

export default r;
