import db from "./db.js";
// 유튜브 용 점수화
/**
 * 좋아요(=liked) 토큰으로 토큰-동시출현(co-occurrence) 그래프를 만든다.
 * - 정점: 토큰(artist/keyword)
 * - 간선: 같은 영상에서 나온 토큰 쌍
 * - 간선 가중치: 같은 영상에서 함께 등장한 횟수
 */
function buildGraph(userId) {
  // tokens 테이블에서 liked 소스의 토큰(artists, keywords)을 전부 가져온다.
  // source_id는 video_id
  const rows = db
    .prepare(
      `SELECT source_id, artists_json, keywords_json
       FROM tokens
       WHERE user_id=? AND source_type='liked'`
    )
    .all(userId);

  // 전체 토큰 집합을 만든다. (중복 제거)
  // perVideoTokens: 각 영상마다 토큰 배열을 저장해둔다. (간선 생성 용)
  const tokSet = new Set();
  const perVideoTokens = rows.map((r) => {

    // DB에는 JSON 문자열로 저장되어 있으니 다시 배열로
    const artists = JSON.parse(r.artists_json || "[]");
    const keywords = JSON.parse(r.keywords_json || "[]");

    // 한 영상의 토큰 목록 = artists + keywords
    const tokens = [...artists, ...keywords];

     // 전체 토큰 집합에 추가
    for (const t of tokens) tokSet.add(t);

    return tokens;
  });

  // Set -> 배열: 정점 목록
  const tokens = [...tokSet];

  // 정점 번호(0..N-1)
  const index = new Map(tokens.map((t, i) => [t, i]));

  const N = tokens.length;

  // 인접 리스트(각 정점 -> Map(이웃정점, 가중치))
  // key: 이웃 정점 index j
  // value: 간선 가중치(동시출현 횟수)
  const adj = Array.from({ length: N }, () => new Map());

  // 같은 영상 안에서 동시출현하는 토큰쌍의 간선 가중치 누적
  // 예) 한 영상에서 [A,B,C]가 나오면 (A-B),(A-C),(B-C) 간선 +1
  for (const toks of perVideoTokens) {
    // 영상 단위로 처리
    const uniq = [...new Set(toks)];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        // 토큰 문자열을 정점 번호로 변환
        const a = index.get(uniq[i]);
        const b = index.get(uniq[j]);
        if (a == null || b == null) continue;

        // 무방향 그래프이므로 양쪽에 가중치 누적
        adj[a].set(b, (adj[a].get(b) || 0) + 1);
        adj[b].set(a, (adj[b].get(a) || 0) + 1);
      }
    }
  }

  return { tokens, index, adj };
}

/**
 * Personalized PageRank 계산
 * - seedWeights: Map(token -> weight)
 * - alpha: 개인화 강도
 * - iters: 반복 횟수
 */
function personalizedPageRank({ tokens, index, adj }, seedWeights, { alpha = 0.15, iters = 40 } = {}) {
  const N = tokens.length;
  if (N === 0) return new Map();

  // p: 개인화 분포
  const p = new Float64Array(N);
  let sum = 0;

  // seedWeights의 (token, weight)를 순회하면서 p에 누적
  for (const [t, w] of seedWeights) {
    const i = index.get(t);
    if (i != null) {
      p[i] += w;
      sum += w;
    }
  }

  // seed가 없으면 균등 분포로
  if (sum === 0) {
    for (let i = 0; i < N; i++) p[i] = 1 / N;
  } else {
    for (let i = 0; i < N; i++) p[i] /= sum;
  }

  // r: 현재 랭크 벡터(초기 균등)
  let r = new Float64Array(N);
  r.fill(1 / N);

  // outdeg[i] = i 정점에서 나가는 총 가중치 합
  // outdeg가 0이면 고립정점 케이스
  const outdeg = adj.map((m) => {
    let s = 0;
    for (const v of m.values()) s += v;
    return s || 1; // 고립정점 케이스이면 1로 처리(0 나눗셈 방지)
  });

  // 반복 갱신: nr = (1-alpha) * (r * 전이) + alpha * p
  for (let k = 0; k < iters; k++) {
    const nr = new Float64Array(N);

    // i에서 j로 (w/outdeg[i]) 비율로 랭크 분배
    for (let i = 0; i < N; i++) {
      for (const [j, w] of adj[i]) {
        nr[j] += (1 - alpha) * r[i] * (w / outdeg[i]);
      }
    }
    // 개인화 단계: alpha * p를 더한다
    for (let i = 0; i < N; i++) nr[i] += alpha * p[i];
    r = nr;
  }

  // 결과를 Map(token -> score)로 반환
  const out = new Map();
  for (let i = 0; i < N; i++) out.set(tokens[i], r[i]);
  return out;
}

/**
 * 좋아요 토큰 빈도(최대 2로 캡핑)를 seedWeights로 만든다.
 * - 같은 토큰이 여러 영상에서 반복 등장하면 가중치 상승
 * - 2로 상한을 둬 특정 토큰 쏠림을 완화
 */
function buildSeedFreq(userId) {
  const liked = db
    .prepare(
      `SELECT artists_json, keywords_json
       FROM tokens
       WHERE user_id=? AND source_type='liked'`
    )
    .all(userId);

  const freq = new Map();

  for (const r of liked) {
    const artists = JSON.parse(r.artists_json || "[]");
    const keywords = JSON.parse(r.keywords_json || "[]");

    for (const t of [...artists, ...keywords]) {
      const prev = freq.get(t) || 0;

      // 상한 2까지만 증가 (3 이상은 고정)
      freq.set(t, prev >= 2 ? 2 : prev + 1);
    }
  }
  return freq;
}

/**
 * 좋아요 기반으로 YouTube 검색 쿼리 1~4개를 만든다.
 * - PR 상위 토큰을 뽑고, 아티스트/키워드를 섞어 검색어 생성
 */
export function buildQueriesFromLiked(userId) {
  const freq = buildSeedFreq(userId);
  const graph = buildGraph(userId);

  // PR 계산(개인화 강도/반복 횟수는 기존과 동일)
  const pr = personalizedPageRank(graph, freq, { alpha: 0.2, iters: 30 });
  const ranked = [...pr.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);

  const isArtistLike = (t) => /^[a-z0-9가-힣ぁ-ゟァ-ヿ]/i.test(t);

  // 상위 토큰에서 아티스트 후보/키워드 후보 분리
  const topArtists = ranked.filter(isArtistLike).slice(0, 12);
  const topKeys = ranked.filter((t) => !topArtists.includes(t)).slice(0, 30);

  // 1) 아티스트 3개를 최대한 확보(부족하면 키워드로 채움)
  const artistsForQueries = topArtists.slice(0, 3);
  while (artistsForQueries.length < 3 && topKeys.length) {
    artistsForQueries.push(topKeys.shift());
  }

  // 2) 아티스트 반복 정책: 첫 아티스트 2회, 나머지 1회씩
  const artistUsage = [];
  if (artistsForQueries[0]) artistUsage.push(artistsForQueries[0], artistsForQueries[0]);
  if (artistsForQueries[1]) artistUsage.push(artistsForQueries[1]);
  if (artistsForQueries[2]) artistUsage.push(artistsForQueries[2]);

  // 3) "아티스트 + 키워드 2개" 형태로 최대 4개 검색어 생성
  const keyQueue = [...topKeys];
  const queries = [];

  for (const a of artistUsage) {
    if (queries.length >= 4) break;
    const k1 = keyQueue.shift() || "";
    const k2 = keyQueue.shift() || "";
    const q = [a, k1, k2].filter(Boolean).join(" ").trim();
    if (q) queries.push(q);
  }

  // 아무것도 못 만들면 PR 상위 토큰 단독 사용(최대 4개)
  if (queries.length === 0) return ranked.slice(0, 4).filter(Boolean);

  // 중복 제거 후 반환
  return [...new Set(queries)];
}

/**
 * 후보(candidate) 영상의 점수를 계산해 DB에 반영한다.
 * - 점수 = 후보 영상 토큰들의 PR 가중치 합
 */
export function scoreCandidates(userId) {
  const freq = buildSeedFreq(userId);
  const graph = buildGraph(userId);
  const pr = personalizedPageRank(graph, freq, { alpha: 0.2, iters: 30 });

  const rows = db
    .prepare(
      `SELECT source_id, artists_json, keywords_json
       FROM tokens
       WHERE user_id=? AND source_type='candidate'`
    )
    .all(userId);

  //  배열로 업데이트 목록 생성
  const updates = rows.map((r) => {
    const artists = JSON.parse(r.artists_json || "[]");
    const keywords = JSON.parse(r.keywords_json || "[]");
    let score = 0;
    for (const t of [...artists, ...keywords]) score += pr.get(t) || 0;
    return [r.source_id, score];
  });

  const upd = db.prepare("UPDATE candidates SET score=? WHERE user_id=? AND video_id=?");

  // 트랜잭션으로 일괄 업데이트(기존과 동일)
  const tx = db.transaction((arr) => {
    for (const [vid, score] of arr) upd.run(score, userId, vid);
  });
  tx(updates);
}
