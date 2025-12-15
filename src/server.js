import "dotenv/config";

import path from "path";
import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import expressLayouts from "express-ejs-layouts";

import diaryRoutes from "./routes/diary.js";
import recommendRoutes from "./routes/recommend.js";

import { authRoutes } from "./auth.js";
import youtubeRoutes from "./routes/youtube.js";

import db from "./db.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 뷰 엔진(EJS) 및 레이아웃 설정
app.set("view engine", "ejs");
app.set("views", path.resolve("views"));
app.set("layout", "layout");

// 정적 파일 / 바디 파싱
app.use(express.static(path.resolve("public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(expressLayouts);

// 세션 설정(로그인/유튜브 기능용)
app.use(
  session({
    name: "edr.sid",
    secret: process.env.SESSION_SECRET || "dev",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 30,
    },
  })
);

// 유저의 좋아요 동기화 결과 행 개수 조회
// 유저의 후보(검색 결과) 저장 행 개수 조회
// 유저의 유튜브 추천 상황 진행 상태(qstep) 
const qLikesCount = db.prepare("SELECT COUNT(1) c FROM liked_videos WHERE user_id=?");
const qCandidatesCount = db.prepare("SELECT COUNT(1) c FROM candidates WHERE user_id=?");
const qSteps = db.prepare("SELECT step FROM step_status WHERE user_id=?");

// 템플릿에서 공통으로 쓸 locals 주입
app.use((req, res, next) => {
  // 세션은 모든 페이지에서
  res.locals.session = req.session;

  // 유튜브 요약 정보(홈 화면 표시용)
  res.locals.yt = null;

  try {
    const userId = req.session?.userId;
    if (!userId) return next(); // 로그인 안 했으면

    const likesCount = qLikesCount.get(userId).c;
    const candidatesCount = qCandidatesCount.get(userId).c;

    const steps = qSteps.all(userId).map((r) => r.step);
    const stepsMap = {
      synced_likes: steps.includes("synced_likes"),
      tokenized_likes: steps.includes("tokenized_likes"),
      searched_candidates: steps.includes("searched_candidates"),
      tokenized_candidates: steps.includes("tokenized_candidates"),
    };

    const doneStepsCount = Object.values(stepsMap).filter(Boolean).length;

    res.locals.yt = { likesCount, candidatesCount, stepsMap, doneStepsCount };
  } catch {
    // 실패 시 yt만 비움
    res.locals.yt = null;
  }

  next();
});

// 인증(구글 OAuth) 라우트
authRoutes(app);

// 홈
app.get("/", (req, res) => res.render("home"));

// 기능별 라우트
app.use("/diary", diaryRoutes);
app.use("/recommend", recommendRoutes);
youtubeRoutes(app);

// Spotify OAuth 콜백(코드 수동 캡처용)
app.get("/callback", (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Error: ${error}`);
  if (!code) return res.status(400).send("Missing code");

  console.log("[spotify oauth] auth code:", code);
  res.send("Spotify auth code received. Check server logs to copy the code for token exchange.");
});

// 에러 핸들러
app.use((err, req, res, next) => {
  console.error(err);
  if (req.accepts("json")) return res.status(500).json({ error: "internal_error" });
  res.status(500).send("Internal Server Error");
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
