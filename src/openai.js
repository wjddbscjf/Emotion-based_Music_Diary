// src/openai.js
import { OpenAI } from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-5-nano";

const SYSTEM = `Analyze a diary entry and emit JSON only.
Return a SINGLE JSON object. No markdown, no extra text.
Fields:
- mood: one of [happy,sad,angry,calm,energetic,romantic,melancholic,focused]
- keywords: 3-8 short music terms
- genres: 1-3 Spotify-friendly genres
- energy: 0..1
- valence: 0..1
- tempo: bpm 60..180 or null
- market: ISO 3166-1 alpha-2 for the inferred country/market (e.g., KR, US, JP)
- search_queries: 2-3 concise Spotify search strings, 한국어 자연어 + genre 필터를 함께 쓰는 것을 선호한다.
  예) "에너지 넘치는 밝은 트랙 genre:dance", "비 오는 날 잔잔한 피아노 genre:ambient"
  (필요 시 필터 추가: album/artist/track/year/genre/tag:new/tag:hipster/isrc/upc)
Keep it compact.`;


// 일기 텍스트 → (분석 결과 + Spotify 검색어 + 추천 파라미터) 생성
export async function analyzeDiaryAndBuildSpotify(text) {
  // 빈 입력은 분석이 불가능하므로 예외 처리
  if (!text?.trim()) throw new Error("Empty diary text");

  // 사용자 입력
  const userText = text.slice(0, 2000);

  const resp = await client.responses.create({
    model: MODEL,
    input: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userText },
    ],
    // 모델이 “JSON 객체”로만 출력
    text: { format: { type: "json_object" } },
    max_output_tokens: 2500,
  });

  // 모델 출력 텍스트 추출
  const raw = getOutputText(resp);

  const extracted = extractJsonObject(raw);
  const json =
    resp.output_parsed ??
    safeJsonParse(raw) ??
    safeJsonParse(extracted);

  // JSON 파싱 실패 로그 출력
  if (!json || typeof json !== "object") {
    console.error("[openai] raw output (first 400):", (raw || "").slice(0, 400));
    throw new Error("No JSON parsed");
  }

  // 파싱/검증 과정에서 폴백이 발생하면 이 배열에 기록
  const fallbacks = [];

  // 분석 결과 정규화(필드 누락/형식 오류 시 기본값으로 폴백)
  const analysis = {
    mood:
      typeof json.mood === "string"
        ? json.mood
        : pushFb("mood", json.mood, "calm", fallbacks),

    keywords: normList(json.keywords, 8, ["chill", "lofi"], "keywords", fallbacks),
    genres: normList(json.genres, 3, [], "genres", fallbacks),

    energy: clamp(json.energy, 0, 1, 0.5, "energy", fallbacks),
    valence: clamp(json.valence, 0, 1, 0.5, "valence", fallbacks),
    tempo: clamp(json.tempo, 60, 180, null, "tempo", fallbacks),

    market: typeof json.market === "string" ? json.market.toUpperCase() : "KR",

    __fallbacks: fallbacks,
  };

  // 검색어는 최대 3개만 사용(비정상 출력/빈 배열이면 폴백 생성)
  const qs = normList(json.search_queries, 3, [], "search_queries", fallbacks)
    .filter(Boolean)
    .slice(0, 3);

  const searchQueries = qs.length ? qs : buildFallbackQueries(analysis);

  console.log("[openai] analysis:", analysis);
  console.log("[openai] searchQueries:", searchQueries);
  if (fallbacks.length) console.warn("[openai] fallbacks used:", fallbacks);

  return { analysis, searchQueries };
}

// 분석만 필요한 경우(호출 편의용 래퍼)
export async function analyzeDiary(text) {
  const { analysis } = await analyzeDiaryAndBuildSpotify(text);
  return analysis;
}

/* =========================
   아래는 내부 유틸 함수들
   ========================= */

// Responses API 응답에서 텍스트를 안전하게 추출
function getOutputText(resp) {
  if (typeof resp?.output_text === "string") return resp.output_text;

  // output 배열을 순회하며 output_text 조각을 합침
  let out = "";
  const items = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of items) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") out += c.text;
    }
  }
  return out;
}

// 문자열을 JSON으로 파싱(실패 시 null)
function safeJsonParse(s) {
  if (!s || typeof s !== "string") return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// 텍스트에서 가장 바깥쪽 JSON 객체({ ... })만 추출
function extractJsonObject(s) {
  if (!s || typeof s !== "string") return null;
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  return i >= 0 && j > i ? s.slice(i, j + 1) : null;
}

// 배열 필드를 “문자열 배열”로 정규화하고, 비정상이면 폴백 적용
function normList(v, max, fallback, field, fallbacks) {
  if (!Array.isArray(v)) return pushFb(field, v, fallback, fallbacks);

  const out = v
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, max);

  return out.length ? out : pushFb(field, v, fallback, fallbacks);
}

// 숫자 필드를 범위로 클램프(범위 밖/비정상이면 폴백 적용)
function clamp(v, lo, hi, dflt, field, fallbacks) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) {
    return pushFb(field, v, dflt, fallbacks);
  }
  return n;
}

// 폴백 기록을 남기고 기본값을 반환
function pushFb(field, got, used, fallbacks) {
  fallbacks.push({ field, got, used });
  return used;
}

// 모델이 search_queries를 비우거나 실패했을 때의 검색어 폴백 생성
function buildFallbackQueries({ keywords, genres }) {
  const base = [...(genres || []), ...(keywords || [])].filter(Boolean);

  return [
    base.slice(0, 2).join(" "),
    base.slice(0, 3).join(" "),
    base.join(" "),
  ]
    .filter(Boolean)
    .map((q) => q.trim())
    .slice(0, 3);
}