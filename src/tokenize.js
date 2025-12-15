import OpenAI from "openai";
import db from "./db.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-5-nano";

const SYSTEM = `You are a tokenizer for music metadata. Output JSON ONLY.
Schema: { "items": [ { "artists": string[], "keywords": string[] } ] }
Rules:
- artists: performer / singer / composer names only.
- keywords:
  - Only subject- and tag-like terms that describe the CONTENT or THEME, not the format of the video.
  - Valid examples: anime / game / drama / movie titles or franchises, series names, story themes, game titles, character names, story arcs, etc.
  - Remove all non-subject words from the title/description before deciding.
  - DO NOT put the song title itself into keywords.
  - DO NOT put any artist names into keywords.
  - DO NOT put language / format / style / upload-related words into keywords.
  - Never include words like: cover, covered, song, mv, music video, official, short ver, version, remix, edit, feat, featuring, uploaded, premiere, lyric video, audio, inst, instrumental, 커버, 자작곡, 원곡, drama, (unless truly part of an official title).
  - If nothing clear remains, return keywords: [].
- lowercase latin; keep kana/kanji/hangul; deduplicate; limit artists<=18, keywords<=20.
- Never include any video id or channel id.`;

/**
 * 콘솔 + DB(logs 테이블)로 로그를 남긴다.
 * - 화면에 출력하는 용도가 아니라 디버깅/추적용이다.
 */
export function log(userId, phase, message, data) {
  const line = `[${new Date().toISOString()}] ${phase} :: ${message}`;

  // 로그 실패가 기능을 막지 않도록
  try {
    const payload =
      data === undefined ? "" : typeof data === "string" ? data : JSON.stringify(data);
    console.log(line, payload);
  } catch {
    console.log(line);
  }

  try {
    db.prepare("INSERT INTO logs(user_id, phase, message, data_json) VALUES(?,?,?,?)").run(
      userId,
      phase,
      message,
      data ? JSON.stringify(data) : null
    );
  } catch {
    // 로그 저장 실패는 무시
  }
}

/**
 * 배열을 n개 단위로 묶어 배치 처리한다.
 */
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * LLM에 전달할 사용자 프롬프트를 생성한다.
 * - title/channel만 전달해 “환각 요소”를 줄이는 목적
 */
function buildUserPrompt(rows) {
  const items = rows.map(r => ({
    title: r.title ?? "",
    channel: r.channelTitle ?? "",
  }));

  return `Tokenize the following videos. Respond with JSON only and follow the schema exactly.
items=
${JSON.stringify(items)}`;
}

/**
 * OpenAI Responses API 응답에서 텍스트(JSON 문자열)를 추출한다.
 */
function getOutputText(resp) {
  // output_text 우선, 없으면 output 배열에서 output_text 타입을 수집
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) return resp.output_text;

  let out = "";
  const blocks = Array.isArray(resp?.output) ? resp.output : [];
  for (const b of blocks) {
    const content = Array.isArray(b?.content) ? b.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") out += c.text;
    }
  }
  return out.trim() ? out : null;
}

/**
 * JSON 파싱을 최대한 성공시키기 위한 파서
 * - 정상 JSON
 * - ```json ... ``` 코드펜스 제거
 * - 가장 바깥 { ... } 추출
 */
function parseJsonStrict(raw) {
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {}

  const cleaned = raw.replace(/```json|```/g, "");
  try {
    return JSON.parse(cleaned);
  } catch {}

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch {}
  }
  return null;
}

/**
 * kind에 따라 원본 데이터를 읽을 테이블을 선택한다.
 * - 임의 테이블 주입 방지를 위해 허용 값만 매핑한다.
 */
function selectSourceTable(kind) {
  if (kind === "liked") return "liked_videos";
  if (kind === "candidate") return "candidates";
  throw new Error("invalid kind");
}

/**
 * 영상 토큰화를 수행한다.
 * 핵심 흐름:
 * 1) 원본(좋아요/후보) 조회
 * 2) 이미 tokens에 저장된 영상은 스킵
 * 3) 배치로 OpenAI에 요청
 * 4) 결과를 tokens 테이블에 저장 + step_status 갱신
 *
 * 옵션:
 * - batchSize: 한 번에 보내는 영상 개수(기본 12)
 * - forceSingleRequest: true면 전체를 1회 요청으로 처리(큰 입력이면 실패 가능성↑)
 * - maxArtists/maxKeywords: 저장 시 상한
 */
export async function tokenizeVideos(userId, kind, opts = {}) {
  const {
    batchSize = 12,
    forceSingleRequest = false,
    maxArtists = 18,
    maxKeywords = 20,
  } = opts;

  const table = selectSourceTable(kind);

  // 쿼리 준비
  const qRows = db.prepare(
    `SELECT video_id AS videoId, title, channel_title AS channelTitle
     FROM ${table}
     WHERE user_id = ?`
  );

  const qExisting = db.prepare(
    "SELECT source_id FROM tokens WHERE user_id=? AND source_type=?"
  );

  const ins = db.prepare(
    "INSERT OR REPLACE INTO tokens (user_id, source_type, source_id, artists_json, keywords_json, raw_json) VALUES (?,?,?,?,?,?)"
  );

  // 1) 원본 행 조회
  const rows = qRows.all(userId);

  // 한 번에 가져와 Set으로 필터링
  const existingIds = new Set(qExisting.all(userId, kind).map(r => r.source_id));
  const todo = rows.filter(r => r?.videoId && !existingIds.has(r.videoId));

  if (todo.length === 0) return { skipped: true, added: 0 };

  const groups = forceSingleRequest ? [todo] : chunk(todo, batchSize);
  let added = 0;

  for (const group of groups) {
    const prompt = buildUserPrompt(group);

    log(userId, `tokenize_${kind}`, "request", {
      count: group.length,
      sample: { title: group[0]?.title, channel: group[0]?.channelTitle },
    });

    let resp;
    try {
      resp = await client.responses.create({
        model: MODEL,
        reasoning: { effort: "minimal" },
        input: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt },
        ],
        max_output_tokens: 5000,
        text: { format: { type: "json_object" } },
      });
    } catch (e) {
      log(userId, `tokenize_${kind}`, "api_error", { error: String(e) });
      continue;
    }

    const raw = getOutputText(resp);
    if (!raw) {
      log(userId, `tokenize_${kind}`, "no_output", {});
      continue;
    }

    log(userId, `tokenize_${kind}`, "raw_head", raw.slice(0, 500));

    const parsed = parseJsonStrict(raw);
    let items = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];

    if (items.length === 0) {
      log(userId, `tokenize_${kind}`, "empty_items", {});
      continue;
    }

    // 2) 응답 길이를 입력 배치 길이에 맞춤
    const need = group.length;
    if (items.length < need) items = items.concat(Array(need - items.length).fill({}));
    if (items.length > need) items = items.slice(0, need);

    // 3) 저장(입력 인덱스 기준으로 videoId 매핑)
    let stored = 0;

    const tx = db.transaction(arr => {
      arr.forEach((it, idx) => {
        const src = group[idx];
        if (!src?.videoId) return;

        // slice된 배열을 직접 저장(rawItem도 동일한 구조로 저장)
        const artists = Array.isArray(it?.artists) ? it.artists.slice(0, maxArtists) : [];
        const keywords = Array.isArray(it?.keywords) ? it.keywords.slice(0, maxKeywords) : [];

        const artistsJson = JSON.stringify(artists);
        const keywordsJson = JSON.stringify(keywords);
        const rawItem = JSON.stringify({ artists, keywords });

        ins.run(userId, kind, src.videoId, artistsJson, keywordsJson, rawItem);
        stored += 1;
      });
    });

    tx(items);

    const coverage = stored / group.length;
    log(userId, `tokenize_${kind}`, "stored", { stored, requested: group.length, coverage });

    added += stored;
  }

  // 4) 단계 완료 표시
  db.prepare(
    "INSERT OR REPLACE INTO step_status(user_id, step, done_at) VALUES(?, ?, datetime('now'))"
  ).run(userId, kind === "liked" ? "tokenized_likes" : "tokenized_candidates");

  return { skipped: false, added };
}

/**
 * 전체를 1회 요청으로 처리하는 편의 함수
 */
export async function tokenizeVideosSingleShot(userId, kind) {
  return tokenizeVideos(userId, kind, { forceSingleRequest: true });
}