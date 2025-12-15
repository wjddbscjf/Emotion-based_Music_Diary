import { google } from "googleapis";
import db from "./db.js";

// Google OAuth에서 요청할 권한(scope) 목록
// - openid/email/profile: 로그인 및 기본 프로필
// - youtube.readonly: 좋아요(LL) 조회 등 YouTube 읽기
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/youtube.readonly",
];

// OAuth2 클라이언트 생성
// - 환경변수에 등록된 Client ID/Secret/Callback URL을 사용
export function makeOAuth2Client() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    OAUTH_CALLBACK_URL,
  } = process.env;

  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    OAUTH_CALLBACK_URL
  );
}

// 인증 관련 라우트 등록
// - /auth/google: Google 로그인 시작
// - /oauth2/callback: OAuth 콜백 처리(토큰 발급 + 세션 저장)
// - /logout: 세션 종료
export function authRoutes(app) {
  app.get("/auth/google", (req, res) => {
    const oauth2 = makeOAuth2Client();

    // 옵션 정리
    const authUrl = oauth2.generateAuthUrl({
      access_type: "offline", // refresh_token을 받기 위함
      prompt: "consent",      // 매번 동의 화면 표시(토큰 재발급/갱신 안정성)
      scope: SCOPES,
    });

    res.redirect(authUrl);
  });

  app.get("/oauth2/callback", async (req, res, next) => {
    try {
      const oauth2 = makeOAuth2Client();

      const code = req.query.code;
      const { tokens } = await oauth2.getToken(code);
      oauth2.setCredentials(tokens);

      // Google 사용자 정보 조회(프로필/이메일/사진)
      const oauth2api = google.oauth2({ version: "v2", auth: oauth2 });
      const { data: me } = await oauth2api.userinfo.get();
      const userId = me.id;

      // DB에 사용자 정보 저장
      db.prepare(
        "INSERT OR REPLACE INTO users(user_id, email, name, picture) VALUES(?,?,?,?)"
      ).run(userId, me.email, me.name, me.picture || null);

      // DB에 토큰 저장(갱신을 위해 refresh_token 포함 가능)
      db.prepare(
        "INSERT OR REPLACE INTO oauth_tokens(user_id, tokens_json, updated_at) VALUES(?,?,datetime('now'))"
      ).run(userId, JSON.stringify(tokens));

      req.session.userId = userId;
      req.session.user = {
        name: me.name || "User",
        email: me.email || null,
        picture: me.picture || null,
      };

      res.redirect("/");
    } catch (e) {
      next(e);
    }
  });

  app.get("/logout", (req, res) => {
    // 세션 종료(서버 저장 세션 제거) 후 홈으로 이동
    req.session.destroy((err) => {
      if (err) {
        console.error("[auth] logout destroy failed:", err);
        return res.status(500).send("Logout failed");
      }

      const SESSION_COOKIE_NAME = "edr.sid";
      res.clearCookie(SESSION_COOKIE_NAME);

      res.redirect("/");
    });
  });
}

// YouTube "로그인 필수" 페이지에서 사용
export function requireUser(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/auth/google");
  }
  next();
}

// DB에 저장된 토큰으로 OAuth2 클라이언트를 복원
// - YouTube API 호출 시 auth로 전달
export function loadOAuth2ForUser(userId) {
  const row = db
    .prepare("SELECT tokens_json FROM oauth_tokens WHERE user_id = ?")
    .get(userId);

  if (!row) return null;

  const tokens = JSON.parse(row.tokens_json);
  const oauth2 = makeOAuth2Client();
  oauth2.setCredentials(tokens);

  return oauth2;
}
