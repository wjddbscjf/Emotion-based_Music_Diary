import { OpenAI } from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-5-nano"; // 가성비 우선

const SYSTEM = `You are a classifier. Output JSON only.
Fields: mood (one of: happy, sad, angry, calm, energetic, romantic, melancholic, focused),
keywords (array<string> length 3..8),
energy (0..1),
valence (0..1).
Keep it compact.`;

// ★ MODIFIED START: OpenAI 응답 JSON을 안전하게 추출하기 위한 함수 추가
function extractJSONFromResponse(resp) {
  // SDK가 파싱 결과를 제공하는 경우
  if (resp.output_parsed && typeof resp.output_parsed === "object") {
    return resp.output_parsed;
  }

  // output 배열 직접 순회
  if (Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (!Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (c.type === "output_text" && typeof c.text === "string") {
          return JSON.parse(c.text);
        }
      }
    }
  }

  throw new Error("OpenAI response JSON not found");
}
// ★ MODIFIED DONE

export async function analyzeDiary(text) {
  if (!text || !text.trim()) {
    // 기존 제거: return { mood: "calm", keywords: ["ambient", "soft", "instrumental"], energy: 0.3, valence: 0.6 };
    // ★ MODIFIED: 실패를 호출자에게 위임
    throw new Error("Empty diary text");
    // ★ MODIFIED DONE
  }
  try {
    const resp = await client.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text.slice(0, 2000) },
      ],
      max_output_tokens: 300,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    //기존 제거: const content = resp.output_text || "{}";
    //기존 제거: const json = JSON.parse(content);
    // 기본값 보정

    // ★ MODIFIED START: 정확한 JSON 파싱
    const json = extractJSONFromResponse(resp);
    // ★ MODIFIED DONE
    return {
      //기존 제거: mood: json.mood || "calm",
      // ★ MODIFIED START
      mood: json.mood,
      // ★ MODIFIED DONE
      keywords:
        Array.isArray(json.keywords) && json.keywords.length
          ? json.keywords.slice(0, 8)
          : ["ambient", "soft", "instrumental"],
      energy: clamp(json.energy, 0, 1, 0.5),
      valence: clamp(json.valence, 0, 1, 0.5),
    };
  } catch (e) {
    /* 기존 제거: catch (_) {
    return { mood: "calm", keywords: ["ambient", "soft", "instrumental"], energy: 0.4, valence: 0.6 };
  }*/
    throw e;
  }
}

function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  if (Number.isFinite(n) && n >= lo && n <= hi) return n;
  return dflt;
}
