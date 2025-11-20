import { OpenAI } from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-5-nano"; // 가성비 우선

const SYSTEM = `You are a classifier. Output JSON only.
Fields: mood (one of: happy, sad, angry, calm, energetic, romantic, melancholic, focused),
keywords (array<string> length 3..8),
energy (0..1),
valence (0..1).
Keep it compact.`;

export async function analyzeDiary(text) {
  if (!text || !text.trim()) {
    return { mood: "calm", keywords: ["ambient", "soft", "instrumental"], energy: 0.3, valence: 0.6 };
  }
  try {
    const resp = await client.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text.slice(0, 2000) }
      ],
      max_output_tokens: 300,
      temperature: 0.2,
      response_format: { type: "json_object" }
    });
    const content = resp.output_text || "{}";
    const json = JSON.parse(content);
    // 기본값 보정
    return {
      mood: json.mood || "calm",
      keywords: Array.isArray(json.keywords) && json.keywords.length ? json.keywords.slice(0, 8) : ["ambient","soft","instrumental"],
      energy: clamp(json.energy, 0, 1, 0.5),
      valence: clamp(json.valence, 0, 1, 0.5)
    };
  } catch (_) {
    return { mood: "calm", keywords: ["ambient", "soft", "instrumental"], energy: 0.4, valence: 0.6 };
  }
}

function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  if (Number.isFinite(n) && n >= lo && n <= hi) return n;
  return dflt;
}
