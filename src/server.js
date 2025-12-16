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

// 템플릿에서 공통으로 쓸 locals 주입
app.use((req, res, next) => {
  // 세션은 모든 페이지에서
  res.locals.session = req.session;
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

// 에러 핸들러
app.use((err, req, res, next) => {
  console.error(err);
  if (req.accepts("json")) return res.status(500).json({ error: "internal_error" });
  res.status(500).send("Internal Server Error");
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
