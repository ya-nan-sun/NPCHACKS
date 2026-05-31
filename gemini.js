// Gemini-backed code-snippet generator for Bug Blackjack.
// Produces realistic-looking code that secretly contains a known set of bugs.
// The bug data is authoritative and must NEVER be sent to the client before reveal.

const MODEL = 'gemini-2.0-flash-lite';
const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const DIFFICULTY_RULES = {
  easy:
    'short (8-15 lines), common languages (Python or JavaScript), obvious bugs ' +
    '(syntax errors, wrong variable names, off-by-one).',
  medium:
    'longer (15-30 lines), mixed languages (Python, JS, Java, Go, C#), logic errors and edge cases.',
  hard:
    'dense (25-45 lines), may include obscure languages, subtle bugs ' +
    '(race conditions, integer overflow, memory leaks, use-after-free).',
};

function buildPrompt(difficulty) {
  const rule = DIFFICULTY_RULES[difficulty] || DIFFICULTY_RULES.easy;
  return `You generate code snippets for a "spot the bug" blackjack game.

Produce ONE realistic, plausible-looking code snippet that secretly contains a specific number of bugs.

Difficulty "${difficulty}": ${rule}

Hard rules:
- The code must look like genuine production code a developer might actually write.
- Do NOT add comments that hint at bugs. Do NOT include "bug here" markers or TODOs about the bugs.
- Include between 0 and 6 real, identifiable bugs. VARY the count between calls (sometimes 0, sometimes several).
- Every listed bug must be a concrete, defensible defect tied to one specific line of the snippet.
- "line" is the 1-based line number within the "code" string.

Return ONLY a JSON object with this exact shape:
{
  "language": string,
  "code": string,            // the snippet, real newlines
  "bugs": [
    { "line": number, "type": string, "description": string }
  ]
}
"type" is a short category (e.g. "off-by-one", "null dereference", "race condition", "type coercion").
"description" is one sentence explaining the defect.`;
}

function coerceSnippet(obj) {
  const bugs = Array.isArray(obj && obj.bugs)
    ? obj.bugs
        .filter((b) => b && (b.description || b.type))
        .map((b) => ({
          line: Number.isFinite(Number(b.line)) ? Number(b.line) : 0,
          type: String(b.type || 'bug'),
          description: String(b.description || ''),
        }))
    : [];
  return {
    language: String((obj && obj.language) || 'code').toLowerCase(),
    code: String((obj && obj.code) || ''),
    bugs,
    bugCount: bugs.length,
  };
}

function parseResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text && text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('model returned non-JSON output');
  }
}

/**
 * Generate one snippet at the given difficulty.
 * @param {'easy'|'medium'|'hard'} difficulty
 * @returns {Promise<{language:string, code:string, bugs:Array, bugCount:number}>}
 */
async function generateSnippet(difficulty = 'easy') {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');

  const res = await fetch(`${ENDPOINT(MODEL)}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(difficulty) }] }],
      generationConfig: { temperature: 1.0, responseMimeType: 'application/json' },
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Gemini: ${data.error.message}`);

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini: empty response');

  const snippet = coerceSnippet(parseResponse(text));
  if (!snippet.code.trim()) throw new Error('Gemini: produced empty snippet');
  return snippet;
}

module.exports = { generateSnippet, MODEL };
