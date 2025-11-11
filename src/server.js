import "dotenv/config";

import path from "path";
import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import expressLayouts from "express-ejs-layouts";

import diaryRoutes from "./routes/diary.js";
import recommendRoutes from "./routes/recommend.js";
import spotifyRoutes from "./routes/spotify.js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.resolve("views"));

app.use(express.static(path.resolve("public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(expressLayouts);
app.set("layout", "layout");

app.use(session({
  name: "edr.sid",
  secret: process.env.SESSION_SECRET || "dev",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 30
  }
}));

app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

app.get("/", (req, res) => res.render("home"));

app.use("/diary", diaryRoutes);
app.use("/recommend", recommendRoutes);
app.use("/spotify", spotifyRoutes);

// simple error handler
app.use((err, req, res, next) => {
  console.error(err);
  if (req.accepts("json")) return res.status(500).json({ error: "internal_error" });
  res.status(500).send("Internal Server Error");
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
