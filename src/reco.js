import { searchTracks } from "./spotify.js";
import { pickEmotionQuote } from "./emotionQuotes.js";
import { Router } from "express";

const r = Router();

// ==========================================
// 1. 한국어 감지 헬퍼
// ==========================================
function hasKorean(text) {
  if (!text) return false;
  return /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(text);
}

// ==========================================
// 2. 감정별 검색어 매핑
// ==========================================
const MOOD_KR = {
  happy: ["신나는", "기분전환", "여행", "드라이브", "아이돌", "청량한"],
  sad: ["슬픈", "이별", "발라드", "새벽", "눈물", "그리움"],
  angry: ["스트레스", "힙합", "강렬한", "락", "터지는"],
  calm: ["잔잔한", "새벽감성", "카페", "힐링", "어쿠스틱", "잠잘때"],
  energetic: ["운동", "노동요", "텐션", "파이팅", "댄스", "동기부여"],
  romantic: ["사랑", "설렘", "고백", "데이트", "달달한", "썸"],
  melancholic: ["우울", "비오는날", "센치한", "위로", "혼자"],
  focused: ["공부", "집중", "독서", "피아노", "노동요"]
};

// ==========================================
// 3. 감정별 서브 장르
// ==========================================
const MOOD_SUB_GENRES = {
  happy: ["dance", "pop"],
  sad: ["ballad", "r-n-b"],
  angry: ["hip-hop", "rock"],
  calm: ["acoustic", "indie"],
  energetic: ["dance", "electronic", "hip-hop"],
  romantic: ["r-n-b", "soul"],
  melancholic: ["r-n-b", "indie"],
  focused: ["piano", "jazz"]
};

r.get("/", async (req, res) => {
  try {
    const analysis = req.session.analysis || null;
    let recos = [];
    let emotionQuote = null;

    if (analysis && analysis.mood) {
      recos = await recommend(analysis);
      emotionQuote = pickEmotionQuote(analysis.mood);
    }

    res.render("recommend", {
      analysis: analysis,
      recos: recos,
      emotionQuote: emotionQuote
    });
  } catch (err) {
    console.error("Recommendation Error:", err);
    res.render("recommend", {
      analysis: req.session.analysis || null,
      recos: [],
      emotionQuote: null
    });
  }
});
export default r;

const MOOD_TARGET = {
  happy: { energy: 0.7, valence: 0.8 },
  sad: { energy: 0.3, valence: 0.2 },
  angry: { energy: 0.9, valence: 0.2 },
  calm: { energy: 0.25, valence: 0.6 },
  energetic: { energy: 0.85, valence: 0.7 },
  romantic: { energy: 0.4, valence: 0.75 },
  melancholic: { energy: 0.35, valence: 0.3 },
  focused: { energy: 0.35, valence: 0.55 }
};

export async function recommend({ mood, keywords, energy, valence }, { market = "KR", topK = 20 } = {}) {
  const SEARCH_LIMIT = 50; 
  
  const krKeywords = MOOD_KR[mood] || [];
  const krQueryString = krKeywords.join(" "); 
  const subGenres = MOOD_SUB_GENRES[mood] || [];

  // 쿼리 조합
  let qList = [
    `genre:k-pop ${mood}`,
    `genre:k-indie ${mood}`,
    `${krQueryString}`,
    `korean ${mood} song`
  ];

  // 서브 장르 추가
  for (const sub of subGenres) {
    qList.push(`genre:k-pop genre:${sub}`); 
  }

  // 최신 곡 추가
  qList.push(`genre:k-pop year:2020-2025 ${mood}`);

  const pool = [];
  
  for (const q of qList) {
    try {
      const items = await searchTracks(q, { limit: SEARCH_LIMIT, market });
      for (const t of items) pool.push(toTrack(t));
    } catch (e) {
      // 무시
    }
  }

  // 중복 제거
  const uniq = dedup(pool, x => x.id);

  // 점수화
  for (const tr of uniq) {
    tr.score = score(tr, { mood });
  }

  // 정렬 (점수 높은 순)
  uniq.sort((a, b) => b.score - a.score);

  // ==================================================
  // ★ [New] 가수당 3곡 제한 필터링 로직 (Greedy Selection)
  // ==================================================
  const finalRecos = [];
  const artistCounts = {}; // { "IU": 1, "NewJeans": 2 ... }

  for (const tr of uniq) {
    // 이미 목표 개수(topK)만큼 채웠으면 중단
    if (finalRecos.length >= topK) break;

    // 메인 가수(첫 번째 가수) 이름 가져오기
    const mainArtist = tr.artists[0];
    
    // 현재까지 저장된 이 가수의 곡 수 확인
    const count = artistCounts[mainArtist] || 0;

    // 3곡 미만일 때만 목록에 추가
    if (count < 3) {
      finalRecos.push(tr);
      artistCounts[mainArtist] = count + 1;
    } 
    // 3곡 이상이면 이 곡은 버리고(skip) 다음 곡으로 넘어감
  }

  return finalRecos;
}

function toTrack(t) {
  return {
    id: t.id,
    title: t.name,
    artists: (t.artists || []).map(a => a.name),
    url: t.external_urls?.spotify,
    preview: t.preview_url || null,
    albumImg: t.album?.images?.[0]?.url || null,
    popularity: t.popularity ?? 0,
    releaseDate: t.album?.release_date || "2000-01-01"
  };
}

function score(track, { mood }) {
  let s = 0;
  const title = track.title || "";
  const artistStr = (track.artists || []).join(" ");

  // 한글 있으면 +20
  if (hasKorean(title) || hasKorean(artistStr)) {
    s += 20; 
  }

  // 인기도 반영
  s += (track.popularity || 0) * 0.5;

  // 제목 키워드 매칭
  if (title.toLowerCase().includes(mood)) s += 10;

  // 최신곡 가산점
  if (track.releaseDate.startsWith("2023") || track.releaseDate.startsWith("2024") || track.releaseDate.startsWith("2025")) {
    s += 10;
  }

  return s;
}

function dedup(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}