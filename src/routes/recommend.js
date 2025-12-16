import { Router } from "express";
import { pickEmotionQuote } from "../emotionQuotes.js";
import { recommendTracks } from "../spotify.js";

const r = Router();

/**
 * 추천 페이지
 * - /diary에서 저장한 세션(analysis, spotify)을 기반으로 Spotify 트랙을 추천하고 렌더링한다.
 */
r.get("/", async (req, res, next) => {
  //  세션 
  const analysis = req.session?.analysis || null;
  const spotify = req.session?.spotify || null;

  // 일기 페이지
  if (!analysis || !spotify) return res.redirect("/diary");

  try {
    // 기본값 처리
    const market = analysis.market || "KR";

    // 세션에 저장된 OpenAI 결과 사용해 추천 생성
    const recos = await recommendTracks({
      analysis,
      searchQueries: spotify.searchQueries,
      topK: 24,
      market,
    });

    // 감정에 맞는 문구
    const emotionQuote = pickEmotionQuote(analysis.mood);

    res.render("recommendations", { analysis, recos, emotionQuote });
  } catch (e) {
    next(e);
  }
});

export default r;
