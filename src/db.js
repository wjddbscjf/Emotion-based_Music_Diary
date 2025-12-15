import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// 유튜브 기능용 db
// DB 파일 경로 준비(없으면 폴더 생성)
const dbPath = path.resolve("data/app.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// DB 연결 및 WAL 모드 설정
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// 테이블/인덱스 초기화
db.exec(`
-- 사용자/토큰
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,      -- Google user id(sub)
  email TEXT,
  name TEXT,
  picture TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  user_id TEXT PRIMARY KEY,
  tokens_json TEXT NOT NULL,      -- OAuth tokens(JSON)
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 좋아요(원본)
CREATE TABLE IF NOT EXISTS liked_videos (
  user_id TEXT,
  video_id TEXT,
  title TEXT,
  channel_title TEXT,
  category_id TEXT,
  published_at TEXT,
  thumbnail_url TEXT,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_user ON liked_videos(user_id);

-- 토큰화 결과(좋아요/후보 공용)
CREATE TABLE IF NOT EXISTS tokens (
  user_id TEXT,
  source_type TEXT,              -- 'liked' | 'candidate'
  source_id TEXT,                -- video_id
  artists_json TEXT,
  keywords_json TEXT,
  raw_json TEXT,
  PRIMARY KEY (user_id, source_type, source_id)
);

-- 후보(검색 결과)
CREATE TABLE IF NOT EXISTS candidates (
  user_id TEXT,
  video_id TEXT,
  title TEXT,
  channel_title TEXT,
  published_at TEXT,
  thumbnail_url TEXT,
  source_query TEXT,
  score REAL DEFAULT 0,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_candidates_user ON candidates(user_id);

-- 단계 상태(중복 실행 방지/진행 상태 표시용)
CREATE TABLE IF NOT EXISTS step_status (
  user_id TEXT,
  step TEXT,                     -- 예: synced_likes, tokenized_likes ...
  done_at TEXT,
  PRIMARY KEY (user_id, step)
);

-- 디버그 로그(서버 콘솔 외 저장용)
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  phase TEXT,
  message TEXT,
  data_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

export default db;
