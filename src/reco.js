import { searchTracks } from "./spotify.js";

// mood → target audio profile
const MOOD_TARGET = {
  happy:      { energy: 0.7, valence: 0.8 },
  sad:        { energy: 0.3, valence: 0.2 },
  angry:      { energy: 0.9, valence: 0.2 },
  calm:       { energy: 0.25, valence: 0.6 },
  energetic:  { energy: 0.85, valence: 0.7 },
  romantic:   { energy: 0.4, valence: 0.75 },
  melancholic:{ energy: 0.35, valence: 0.3 },
  focused:    { energy: 0.35, valence: 0.55 }
};

export async function recommend({ mood, keywords, energy, valence }, { market = "KR", perQuery = 20, topK = 20 } = {}) {
  const target = MOOD_TARGET[mood] || { energy, valence };
  const qList = buildQueries(keywords);

  // 수집
  const pool = [];
  for (const q of qList) {
    const items = await searchTracks(q, { limit: perQuery, market });
    for (const t of items) pool.push(toTrack(t));
  }

  // 중복 제거
  const uniq = dedup(pool, x => x.id);

  // 점수화
  for (const tr of uniq) tr.score = score(tr,{keywords});

  // 정렬 상위 반환
  uniq.sort((a, b) => b.score - a.score);
  return uniq.slice(0, topK);
}

function buildQueries(keywords = []) {
  const kw = keywords.filter(Boolean).map(s => s.toString().trim()).filter(s => s.length >= 2).slice(0, 6);
  if (!kw.length) return ["chill instrumental", "lofi beats"];
  const q1 = kw.slice(0, 2).join(" ");
  const q2 = kw.slice(0, 3).join(" ");
  const q3 = kw.join(" ");
  return [q1, q2, q3];
}

function toTrack(t) {
  return {
    id: t.id,
    title: t.name,
    artists: (t.artists || []).map(a => a.name),
    url: t.external_urls?.spotify,
    preview: t.preview_url || null,
    albumImg: t.album?.images?.[0]?.url || null,
    popularity: t.popularity ?? 0
  };
}

function score(track, { keywords }) {
  let s = 0;

  // 텍스트 매칭
  const title = (track.title || "").toLowerCase();
  const artists = (track.artists || []).join(" ").toLowerCase();
  for (const k of keywords || []) {
    const kw = String(k).toLowerCase();
    if (kw && (title.includes(kw) || artists.includes(kw))) s += 8;
  }

  s += (track.popularity || 0) * 0.1;
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
