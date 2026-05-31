/**
 * gameEngine.js
 * Python edition — specs, AI generation, assembly, and subprocess execution.
 */

require('dotenv').config();

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Variable spec pool ────────────────────────────────────────────────────────
const VARIABLE_SPECS = [
  {
    id: 'score_board',
    label: 'Score Board',
    description: 'You have a scoreboard. Write a function that does something with it.',
    code: `# Shared variables — do NOT redefine these.
scores = {"alice": 10, "bob": 5, "charlie": 8}
winner = None
log = []`,
  },
  {
    id: 'shopping_cart',
    label: 'Shopping Cart',
    description: 'A shopping cart with some items. Write a function that manipulates it.',
    code: `# Shared variables — do NOT redefine these.
cart = [
    {"name": "apple",  "price": 1.2,  "qty": 3},
    {"name": "bread",  "price": 2.5,  "qty": 1},
    {"name": "milk",   "price": 1.8,  "qty": 2},
]
discount = 0
log = []`,
  },
  {
    id: 'chat_room',
    label: 'Chat Room',
    description: 'A chat room with messages and users. Write a function that does something.',
    code: `# Shared variables — do NOT redefine these.
messages = [
    {"user": "alice", "text": "hello!"},
    {"user": "bob",   "text": "hey there"},
]
banned_words = ["spam"]
log = []`,
  },
  {
    id: 'todo_list',
    label: 'Todo List',
    description: 'A todo list app. Write a function that operates on the todos.',
    code: `# Shared variables — do NOT redefine these.
todos = [
    {"id": 1, "text": "Buy groceries",   "done": False},
    {"id": 2, "text": "Walk the dog",    "done": True},
    {"id": 3, "text": "Write some code", "done": False},
]
log = []`,
  },
  {
    id: 'bank_account',
    label: 'Bank Account',
    description: 'A simple bank account. Write a function that does something financial.',
    code: `# Shared variables — do NOT redefine these.
balance = 1000
transactions = []
frozen = False
log = []`,
  },
];

function pickRandomSpec() {
  return VARIABLE_SPECS[Math.floor(Math.random() * VARIABLE_SPECS.length)];
}

// ── AI Function Generation ────────────────────────────────────────────────────
async function generateAIFunction(spec, aiName) {
  const fnName = aiName.toLowerCase().replace(/[^a-z0-9]/g, '_');

  const prompt = `You are playing a coding party game. You will be given some shared Python variables and you must write exactly ONE Python function that does something creative, funny, or chaotic with those variables.

Rules:
- Write exactly one function named \`${fnName}\`
- Do NOT redefine the shared variables — they are already declared above your function
- Use the \`log\` list to append output strings (e.g. log.append("hello"))
- Keep it short: 5-15 lines max
- Be creative and a little unpredictable — this is a party game
- Return ONLY the raw Python function, no explanation, no markdown, no backticks

Shared variables:
${spec.code}

Write the function now:`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`);

  const data  = await response.json();
  const raw   = data.content?.find(b => b.type === 'text')?.text || '';
  const cleaned = raw
    .replace(/```python\n?/gi, '')
    .replace(/```\n?/gi, '')
    .trim();

  return cleaned || `def ${fnName}():\n    log.append("${aiName} had nothing to say.")`;
}

// ── Code Assembly ─────────────────────────────────────────────────────────────
function assembleProgram(specCode, submissions) {
  // Python is indentation-sensitive so we keep each block cleanly separated
  const functionDefs = submissions
    .map(({ playerName, code }) =>
      `# ── ${playerName}'s function ──────────────────────\n${code.trim()}`
    )
    .join('\n\n');

  // Extract function names (def <name>(...):) and call them
  const fnNames = submissions.map(({ code }) => {
    const match = code.match(/^def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/m);
    return match ? match[1] : null;
  }).filter(Boolean);

  const autoCalls = fnNames.length
    ? `\n# ── Auto-calling all functions ──────────────────\n` +
      fnNames.map(n =>
        `try:\n    ${n}()\nexcept Exception as e:\n    log.append("${n}() threw: " + str(e))`
      ).join('\n')
    : '';

  // Print the log at the end so we can capture stdout
  const printLog = `\n# ── Output ──────────────────────────────────────\nimport json\nprint(json.dumps(log))`;

  return `${specCode}\n\n${functionDefs}${autoCalls}${printLog}`;
}

// ── Safe Execution (Python subprocess) ───────────────────────────────────────
const TIMEOUT_MS = 5000;

function executeProgram(source) {
  // Write to a temp file and run with python
  const tmpFile = path.join(os.tmpdir(), `npc_hacks_${Date.now()}.py`);

  try {
    fs.writeFileSync(tmpFile, source, 'utf8');

    const stdout = execSync(`python "${tmpFile}"`, {
      timeout: TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Last line of stdout should be our JSON log array
    const lines = stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    let logs = [];
    try { logs = JSON.parse(lastLine); } catch (_) { logs = lines.filter(Boolean); }

    return { output: logs, error: null };
  } catch (err) {
    const stderr = err.stderr || '';
    const isTimeout = err.signal === 'SIGTERM' || (err.message || '').includes('timed out');
    return {
      output: [],
      error: isTimeout
        ? '⏱ Execution timed out (infinite loop?)'
        : `💥 Runtime error:\n${stderr || err.message}`,
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

module.exports = { pickRandomSpec, generateAIFunction, assembleProgram, executeProgram };
