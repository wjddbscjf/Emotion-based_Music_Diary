import { requireUser, loadOAuth2ForUser } from "../auth.js";
import { syncLikesForUser, searchByQueries, upsertCandidates } from "../youtube.js";
import { tokenizeVideos, log as logTokenize } from "../tokenize.js";
import { buildQueriesFromLiked, scoreCandidates } from "../ppr.js";
import db from "../db.js";

// 상수
const QUERY_MAX = 4;
const SEARCH_PER_QUERY = 100;
const CANDIDATE_HARD_LIMIT = 200;

const TOPK = 50;
const PER_ARTIST = 3;

// DB 쿼리
const qCandidatesCount = db.prepare("SELECT COUNT(1) c FROM candidates WHERE user_id=?");
const qUpsertSearchedStep = db.prepare(
  "INSERT OR REPLACE INTO step_status(user_id, step, done_at) VALUES(?, 'searched_candidates', datetime('now'))"
);
const qTopCandidates = db.prepare(
  "SELECT video_id, title, channel_title, thumbnail_url, score FROM candidates WHERE user_id=? ORDER BY score DESC LIMIT 200"
);

// 후보 검색 + DB 저장
async function searchAndStoreCandidates(userId, auth) {
  // 좋아요 토큰 기반으로 PPR에서 쿼리 생성 → 상위 QUERY_MAX개만 사용
  const queries = buildQueriesFromLiked(userId).slice(0, QUERY_MAX);

  // YouTube Search API로 후보 수집
  let cand = await searchByQueries(auth, queries, { perQuery: SEARCH_PER_QUERY });
  cand = cand.slice(0, CANDIDATE_HARD_LIMIT);

  // candidates 테이블에 upsert(중복은 갱신)
  upsertCandidates(userId, cand);

  // 단계 완료 기록(홈 화면/상태 관리용)
  qUpsertSearchedStep.run(userId);

  return { queries, count: cand.length };
}

export default function youtubeRoutes(app) {
  // 좋아요 동기화 후 홈으로 돌아가기
  app.get("/youtube/sync", requireUser, async (req, res, next) => {
    try {
      // Google OAuth 토큰 로드(없으면 다시 로그인 유도)
      const auth = loadOAuth2ForUser(req.session.userId);
      if (!auth) return res.redirect("/auth/google");

      await syncLikesForUser(req.session.userId, auth);

      res.redirect("/");
    } catch (e) {
      next(e);
    }
  });

  // 추천 출력 (동기화→토큰화→검색→후보 토큰화까지 자동 실행)
  app.get("/youtube/recommend", requireUser, async (req, res, next) => {
    try {
      const userId = req.session.userId;
      const auth = loadOAuth2ForUser(userId);

      // 1) 좋아요 동기화(토큰이 있으면, syncLikesForUser 내부에서 스킵될 수 있음)
      if (auth) await syncLikesForUser(userId, auth);

      // 2) 좋아요 토큰화(이미 처리된 항목이면 tokenizeVideos 내부에서 스킵될 수 있음)
      await tokenizeVideos(userId, "liked");

      // 3) 후보 검색(후보가 이미 있으면 스킵)
      if (auth) {
        const already = qCandidatesCount.get(userId).c;
        if (already === 0) await searchAndStoreCandidates(userId, auth);
      }

      // 4) 후보 토큰화
      await tokenizeVideos(userId, "candidate");

      // 5) PPR 점수 계산 후 상위 후보 렌더
      scoreCandidates(userId);

      const rowsRaw = qTopCandidates.all(userId);

      // 채널(아티스트)별 최대 N개 제한
      const seen = new Map();
      const rows = [];
      for (const r of rowsRaw) {
        const key = r.channel_title || "unknown";
        const cnt = seen.get(key) || 0;
        if (cnt >= PER_ARTIST) continue;

        seen.set(key, cnt + 1);
        rows.push(r);
        if (rows.length >= TOPK) break;
      }

      res.render("youtube_recommendations", { rows });
    } catch (e) {
      next(e);
    }
  });
}
