// Node 18+ 전제: global fetch 사용
let appToken = { access_token: null, exp: 0 };

async function fetchJSON(url, { method = "GET", headers = {}, body, timeout = 8000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} :: ${text}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function getAppToken() {
  const now = Date.now();
  if (appToken.access_token && now < appToken.exp - 60_000) return appToken.access_token;

  const body = new URLSearchParams({ grant_type: "client_credentials" }).toString();
  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const data = await fetchJSON("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  appToken = { access_token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return appToken.access_token;
}

export async function searchTracks(q, { limit = 20, market = "KR" } = {}) {
  const token = await getAppToken();
  const params = new URLSearchParams({
    q,
    type: "track",
    limit: String(limit),
    market
  });
  const data = await fetchJSON(`https://api.spotify.com/v1/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return data.tracks?.items || [];
}

export async function getAudioFeatures(ids) {
  if (!ids?.length) return [];
  const token = await getAppToken();
  const params = new URLSearchParams({ ids: ids.join(",") });
  const data = await fetchJSON(`https://api.spotify.com/v1/audio-features?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return data.audio_features || [];
}
