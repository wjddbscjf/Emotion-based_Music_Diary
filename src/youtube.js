import { google } from "googleapis";
import db from "./db.js";

// 상수 이름으로 정리
const MUSIC_CATEGORY_ID = "10"; // 유튜브 음악 카테고리
const LIKED_PLAYLIST_ID = "LL"; // 좋아요 동영상은 특수 재생목록 "LL"
const MAX_API_PAGE_SIZE = 50;   // YouTube Data API 페이지당 최대 50
const SHORTS_MAX_SEC = 90;      // 쇼츠 필터

// YouTube API 클라이언트 생성 함수
function yt(auth) {
  return google.youtube({ version: "v3", auth });
}

/* 영상 길이를 초로 변환 
 * YouTube API가 주는 ISO 8601 duration 문자열 (예: PT#H#M#S)
 * H/M/S는 있을 수도 없을 수도 있음
 */
function parseDurationSeconds(iso) {
  if (!iso || typeof iso !== "string") return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  return h * 3600 + min * 60 + s;
}

/* 쇼츠 필터 */
function isShortsLike({ durationSeconds }) {
  return durationSeconds != null && durationSeconds <= SHORTS_MAX_SEC;
}


/**
 * 좋아요(LL) 재생목록에서 videoId 목록을 최대 max개까지 가져옵니다.
 * - auth: OAuth2Client (YouTube scope 포함)
 * - max: 최대 수집 개수(기본 500)
 */
export async function fetchLikedVideoIds(auth, max = 300) {
  const ytapi = yt(auth);

  const ids = [];
  let pageToken;

  // // 좋아요 목록을 max개 모으기
  while (ids.length < max) {
    const { data } = await ytapi.playlistItems.list({
      part: ["contentDetails"],
      playlistId: LIKED_PLAYLIST_ID,
      maxResults: MAX_API_PAGE_SIZE,
      pageToken,
    });

    const items = data.items || []; // items 는 항상 배열
    const batch = items             // contentDetails.videoId만 뽑아 배열 생성
      .map((i) => i?.contentDetails?.videoId)
      .filter(Boolean);             // null 제거 

    ids.push(...batch);
    pageToken = data.nextPageToken;   // 다음 페이지가 있으면

    // 더 이상 페이지가 없거나, 이번 페이지에 데이터가 없으면 종료
    if (!pageToken || batch.length === 0) break;
  }

  return ids.slice(0, max); // 혹시 마지막에 max를 넘어갈 수 있으므로
}

/**
 * videoIds(최대 50개/요청)를 videos.list로 조회해 snippet 메타데이터를 가져옵니다.
 * - videoIds: 조회할 비디오 ID 배열
 */
export async function fetchVideoMeta(auth, videoIds) {
  if (!videoIds.length) return [];  // 가져온 영상이 없다면

  const ytapi = yt(auth);
  const out = [];

  // 50개 단위로 요청(YouTube API 제한)
  // snippet = 제목/채널명/카테고리/게시일/썸네일 등
  // contentDetails: duration(영상 길이) 등
  for (let i = 0; i < videoIds.length; i += MAX_API_PAGE_SIZE) {
    const slice = videoIds.slice(i, i + MAX_API_PAGE_SIZE);
    const { data } = await ytapi.videos.list({
      part: ["snippet", "contentDetails"],
      id: slice,
    });

    const items = data.items || [];

    // title, channelTitle, categoryId, publishedAt, thumbnail을 꺼내고
    // durationSeconds는 초로 변경
    for (const it of items) {
      const sn = it?.snippet;
      const durSec = parseDurationSeconds(it?.contentDetails?.duration);

      out.push({
        videoId: it?.id,
        title: sn?.title || "",
        channelTitle: sn?.channelTitle || "",
        categoryId: sn?.categoryId || null,
        publishedAt: sn?.publishedAt || null,
        thumbnail: sn?.thumbnails?.medium?.url || sn?.thumbnails?.default?.url || null,
        durationSeconds: durSec,
      });
    }
  }

  return out;
}

// 영상 길이 가져오기 (쇼츠 제거)
async function fetchVideoDurations(auth, videoIds) {
  if (!videoIds.length) return new Map();

  const ytapi = yt(auth);
  const map = new Map();

  for (let i = 0; i < videoIds.length; i += MAX_API_PAGE_SIZE) {
    const slice = videoIds.slice(i, i + MAX_API_PAGE_SIZE);
    const { data } = await ytapi.videos.list({
      part: ["contentDetails"],
      id: slice,
    });

    const items = data.items || [];
    for (const it of items) {
      const vid = it?.id;
      if (!vid) continue;
      map.set(vid, parseDurationSeconds(it?.contentDetails?.duration));
    }
  }

  return map;
}

/**
 * 사용자 좋아요 동영상을 DB(liked_videos)에 동기화합니다.
 * - 이미 DB에 존재하고 force=false면 스킵합니다.
 * - 콘솔에는 "스킵 여부/동기화 개수"만 출력합니다.
 */
export async function syncLikesForUser(userId, auth, { force = false } = {}) {
  // liked_videos 테이블에서 userId에 해당하는 영상 행 개수를 셉니다
  const already = db
    .prepare("SELECT COUNT(1) c FROM liked_videos WHERE user_id = ?")
    .get(userId).c;

  // 이미 있으면
  if (already > 0 && !force) {
    console.log("[yt-sync]", { skipped: true, count: already });
    return { skipped: true, count: already };
  }

  // YouTube에서 좋아요 videoId 목록을 가져옴
  const ids = await fetchLikedVideoIds(auth, 300);
  //videoId들을 메타데이터로 확장 조회
  const metas = await fetchVideoMeta(auth, ids);

  // 음악 카테고리(10)+쇼츠 필터링
  const onlyMusic = metas
    .filter(m => m.categoryId === MUSIC_CATEGORY_ID);

  let shortsRemoved = 0;
  const musicNoShorts = onlyMusic.filter((m) => {
    const dur = m.durationSeconds;
    if (dur != null && dur <= SHORTS_MAX_SEC) {
      shortsRemoved += 1;
      return false;
    }
    return true;
  });

  console.log("[yt-sync] shorts filtered", {
    removed: shortsRemoved,
    kept: musicNoShorts.length,
    total: onlyMusic.length,
    threshold: SHORTS_MAX_SEC,
  });

  // INSERT OR REPLACE는 이미 같은 키가 있으면 덮어씌우고, 없으면 새로
  // 영상 1개는 1행
  const insert = db.prepare(
    "INSERT OR REPLACE INTO liked_videos(user_id, video_id, title, channel_title, category_id, published_at, thumbnail_url) VALUES(?,?,?,?,?,?,?)"
  );

  // 여러 행을 DB에 저장하는 작업
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      insert.run(
        userId,
        r.videoId,
        r.title,
        r.channelTitle,
        r.categoryId,
        r.publishedAt,
        r.thumbnail
      );
    }
  });
  tx(musicNoShorts);

  // 워크플로우 관리
  // 좋아요 동기화를 완료했다를 DB에 남김
  db.prepare(
    "INSERT OR REPLACE INTO step_status(user_id, step, done_at) VALUES(?, 'synced_likes', datetime('now'))"
  ).run(userId);

  console.log("[yt-sync]", { skipped: false, count: musicNoShorts.length });
  return { skipped: false, count: musicNoShorts.length };
}

/**
 * queries 배열로 YouTube 검색을 수행하고(음악 카테고리 한정),
 * videoId 기준으로 중복 제거된 후보 목록을 반환합니다.
 * - perQuery: 쿼리당 최대 수집 개수(실제 요청은 50으로 제한)
 */
export async function searchByQueries(auth, queries, { perQuery = 50 } = {}) {
  const ytapi = yt(auth);
  const candidates = new Map();

  // API 제한 50을 한 번만 계산
  const limit = Math.min(perQuery, MAX_API_PAGE_SIZE);

  console.log("[search] queries =", queries);

  // 검색 수행
  for (const q of queries || []) {
    const { data } = await ytapi.search.list({
      part: ["snippet"],
      q,
      type: ["video"],
      videoCategoryId: MUSIC_CATEGORY_ID,
      maxResults: limit,
      order: "relevance",
    });

    const items = data.items || [];
    console.log("[search] q =", q, "requested =", limit, "returned =", items.length);

    // 중복 제거
    for (const it of items) {
      const id = it?.id?.videoId;
      if (!id || candidates.has(id)) continue;

      // 후보 저장
      const sn = it?.snippet;
      candidates.set(id, {
        videoId: id,
        title: sn?.title || "",
        channelTitle: sn?.channelTitle || "",
        publishedAt: sn?.publishedAt || null,
        thumbnail: sn?.thumbnails?.medium?.url || sn?.thumbnails?.default?.url || null,
        sourceQuery: q,
      });
    }
  }

  console.log("[search] total unique =", candidates.size);
  const durations = await fetchVideoDurations(auth, [...candidates.keys()]);

  // 쇼츠 제거
  let shortsRemoved = 0;
  const filtered = [];
  for (const cand of candidates.values()) {
    const dur = durations.get(cand.videoId);
    if (dur != null && dur <= SHORTS_MAX_SEC) {
      shortsRemoved += 1;
      continue;
    }
    filtered.push({ ...cand, durationSeconds: dur ?? null });
  }

  console.log("[search] shorts filtered", {
    removed: shortsRemoved,
    kept: filtered.length,
    total: candidates.size,
    threshold: SHORTS_MAX_SEC,
  });

  return filtered;
}

/**
 * 검색 후보(candidates)를 DB(candidates 테이블)에 upsert 합니다.
 * - rows: searchByQueries에서 받은 후보 배열
 * 라우트에서 사용
 */
export function upsertCandidates(userId, rows) {
  const ins = db.prepare(
    "INSERT OR REPLACE INTO candidates(user_id, video_id, title, channel_title, published_at, thumbnail_url, source_query) VALUES(?,?,?,?,?,?,?)"
  );

  // DB에 저장
  const tx = db.transaction((arr) => {
    for (const r of arr) {
      ins.run(
        userId,
        r.videoId,
        r.title,
        r.channelTitle,
        r.publishedAt,
        r.thumbnail,
        r.sourceQuery
      );
    }
  });

  tx(rows);
}
