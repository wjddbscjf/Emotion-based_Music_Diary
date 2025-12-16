// ===============================
// 1) Spotify App Token (Client Credentials)
// ===============================
let appToken = { accessToken: null, exp: 0 };

async function getAppToken() {
  // 앱 토큰은 만료되기 60초 전부터 미리 갱신
  const now = Date.now();
  if (appToken.accessToken && now < appToken.exp - 60_000) return appToken.accessToken;

  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) throw new Error(`Spotify token failed: ${res.status}`);

  const data = await res.json();
  appToken = {
    accessToken: data.access_token,
    exp: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return appToken.accessToken;
}

// ===============================
// 2) Spotify Web API GET 공통 함수
// ===============================
async function apiGET(path, params = {}) {
  // 공통 GET 호출: Bearer 토큰 + 쿼리스트링 구성
  const token = await getAppToken();
  const qs = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    qs.set(k, String(v));
  }

  // params가 비어도 URL이 자연스럽게 만들어지도록 처리
  const query = qs.toString();
  const url = `https://api.spotify.com/v1/${path}${query ? `?${query}` : ""}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) throw new Error(`Spotify GET ${path} failed: ${res.status}`);
  return res.json();
}

// ===============================
// 3) 트랙 검색(기존 사용 API)
// ===============================
export async function searchTracks(q, { limit = 20, market = "KR" } = {}) {
  // 텍스트 기반 트랙 검색(Spotify Search API)
  const data = await apiGET("search", { q, type: "track", limit, market });
  return data.tracks?.items || [];
}

// ===============================
// 4) 감정 기반 한국어/장르 쿼리 보강 유틸
// ===============================
function hasKorean(text) {
  // 한글 포함 여부(가산점/쿼리 보강용)
  return /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(String(text || ""));
}

const MOOD_KR = {
  happy: ["신나는", "기분전환", "여행", "드라이브", "아이돌", "청량한"],
  sad: ["슬픈", "이별", "발라드", "새벽", "눈물", "그리움"],
  angry: ["스트레스", "힙합", "강렬한", "락", "터지는"],
  calm: ["잔잔한", "새벽감성", "카페", "힐링", "어쿠스틱", "잠잘때"],
  energetic: ["운동", "노동요", "텐션", "파이팅", "댄스", "동기부여"],
  romantic: ["사랑", "설렘", "고백", "데이트", "달달한", "썸"],
  melancholic: ["우울", "비오는날", "센치한", "위로", "혼자"],
  focused: ["공부", "집중", "독서", "피아노", "노동요"],
};

const MOOD_SUB_GENRES = {
  happy: ["dance", "pop"],
  sad: ["ballad", "r-n-b"],
  angry: ["hip-hop", "rock"],
  calm: ["acoustic", "indie"],
  energetic: ["dance", "electronic", "hip-hop"],
  romantic: ["r-n-b", "soul"],
  melancholic: ["r-n-b", "indie"],
  focused: ["piano", "jazz"],
};

function uniqStrings(arr) {
  // 쿼리 문자열 중복 제거(대소문자 무시)
  const out = [];
  const seen = new Set();
  for (const v of arr || []) {
    const s = String(v || "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function buildMoodQueries(mood) {
  // 감정에 따라 한국어 키워드/서브장르/최신곡 조건을 섞어 검색 쿼리 생성
  if (!mood) return [];

  const krKeywords = MOOD_KR[mood] || [];
  const krQuery = krKeywords.slice(0, 6).join(" ");
  const subGenres = MOOD_SUB_GENRES[mood] || [];

  const qList = [
    `genre:k-pop ${mood}`,
    `genre:k-indie ${mood}`,
    krQuery,
    `korean ${mood} song`,
    `genre:k-pop year:2020-2025 ${mood}`, // 최신곡 유도
  ].filter(Boolean);

  for (const sub of subGenres) qList.push(`genre:k-pop genre:${sub}`);
  return qList;
}


// ===============================
// 트랙 정리/점수화/중복 제거
// ===============================
function toTrack(t) {
  //  트랙 필드 정규화
  return {
    id: t.id,
    title: t.name,
    artists: (t.artists || []).map(a => a.name),
    url: t.external_urls?.spotify,
    preview: t.preview_url || null,
    albumImg: t.album?.images?.[0]?.url || null,
    popularity: t.popularity ?? 0,
    albumName: t.album?.name || "",
    releaseDate: t.album?.release_date || null,
  };
}

function dedupById(list) {
  // 동일 트랙 중복 제거
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!x?.id || seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out;
}

function dedupKeepBestScore(arr) {
  // 동일 id가 여러 번 들어오면, score가 더 높은 것을 남김
  const best = new Map();
  for (const t of arr) {
    if (!t?.id) continue;
    const prev = best.get(t.id);
    if (!prev || (Number(t.score) || 0) > (Number(prev.score) || 0)) best.set(t.id, t);
  }
  return Array.from(best.values());
}

function isRecent(releaseDate) {
  // 간단한 최신곡 판정(연도 기준)
  const s = String(releaseDate || "");
  return s.startsWith("2023") || s.startsWith("2024") || s.startsWith("2025");
}

function scoreTrack(t, { keywords = [], genres = [], mood = "" }) {
  // 점수(한글/최신/인기도/감정 키워드) + 기존 점수(키워드 매칭/프리뷰) 혼합
  const title = t.title || "";
  const titleLower = title.toLowerCase();
  const artistsStr = (t.artists || []).join(" ");
  const artistsLower = artistsStr.toLowerCase();
  const albumLower = (t.albumName || "").toLowerCase();

  let s = 0;

  // 한글 포함 가산점
  if (hasKorean(title) || hasKorean(artistsStr)) s += 20;

  // 인기도 반영(가중치 너무 커지지 않게 0.5)
  s += (t.popularity || 0) * 0.5;

  // 최신곡 가산점
  if (isRecent(t.releaseDate)) s += 10;

  // 키워드 매칭(제목/아티스트)
  for (const k of keywords || []) {
    const kw = String(k || "").toLowerCase().trim();
    if (!kw) continue;
    if (titleLower.includes(kw) || artistsLower.includes(kw)) s += 10;
  }

  // 장르 문자열 약가산(앨범명/제목 기반 — 실제 장르가 아니라 “문자열 힌트” 수준)
  for (const g of genres || []) {
    const gg = String(g || "").toLowerCase().trim();
    if (!gg) continue;
    if (titleLower.includes(gg) || albumLower.includes(gg)) s += 5;
  }

  return s;
}

function applyArtistCap(sorted, { topK, maxPerArtist }) {
  // 동일 아티스트 당 최대 N곡만 선택
  const cap = Number.isFinite(maxPerArtist) ? maxPerArtist : 0;
  if (cap <= 0) return sorted.slice(0, topK);

  const out = [];
  const counts = new Map();

  for (const tr of sorted) {
    if (out.length >= topK) break;

    const mainArtist = tr?.artists?.[0] || "";
    const cur = counts.get(mainArtist) || 0;

    if (!mainArtist || cur < cap) {
      out.push(tr);
      counts.set(mainArtist, cur + 1);
    }
  }
  return out;
}


// ===============================
//  추천(메인 함수)
// ===============================
/**
 * OpenAI 분석 결과 기반으로 Spotify 트랙을 추천한다.
 * - searchQueries: OpenAI가 만든 검색 쿼리
 * - recommendationParams: OpenAI가 만든 recommendations 파라미터(선택)
 * - analysis: mood/keywords/genres 등(점수화에 사용)
 */
export async function recommendTracks({
  searchQueries = [],
  recommendationParams = null,
  analysis = {},
  perQuery = 20,
  topK = 24,
  market = "KR",
  maxPerArtist = 3,
  maxQueries = 8, // 변경: 쿼리 폭주로 느려지는 것을 방지하기 위한 상한(동작은 동일 범주)
} = {}) {
  const m = market || "KR";
  const mood = analysis?.mood || "";

  // 1) 쿼리 구성: OpenAI 쿼리 + 감정 기반 쿼리
  const baseQ = (searchQueries || []).filter(Boolean);
  const moodQ = buildMoodQueries(mood);

  const queries = uniqStrings([...baseQ, ...moodQ]).slice(0, maxQueries);

  // 쿼리가 비어있으면 최소 폴백 1개 생성
  if (!queries.length) {
    const fallback =
      [...(analysis.genres || []), ...(analysis.keywords || [])].slice(0, 4).join(" ") || "chill";
    queries.push(fallback);
  }

  console.log("[spotify] searchQueries:", queries, "market:", m);

  // 2) Search API 병렬 수집(속도 개선)
  const searchLists = await Promise.all(
    queries.map(q => searchTracks(q, { limit: perQuery, market: m }).catch(() => []))
  );
  const searchPool = dedupById(searchLists.flat().map(toTrack));


  const recPool = [];

  // 3) 풀 합치기 + 점수화 + 정렬
  const merged = dedupKeepBestScore(
    dedupById([...recPool, ...searchPool]).map(t => ({
      ...t,
      score: scoreTrack(t, {
        keywords: analysis.keywords || [],
        genres: analysis.genres || [],
        mood,
      }),
    }))
  );

  merged.sort((a, b) => (b.score || 0) - (a.score || 0));

  // 가수당 최대 N곡 제한을 적용해 topK 구성
  const finalList = applyArtistCap(merged, { topK, maxPerArtist });

  console.log("[spotify] pools:", {
    search: searchPool.length,
    rec: recPool.length,
    merged: merged.length,
    final: finalList.length,
  });

  return finalList;
}
