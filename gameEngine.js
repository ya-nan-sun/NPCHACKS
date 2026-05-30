/**
 * gameEngine.js
 * Handles variable spec generation, AI function generation, code assembly, and sandboxed execution.
 */

require('dotenv').config();

const vm = require('vm');

// ── Variable spec pool ────────────────────────────────────────────────────────
const VARIABLE_SPECS = [
  {
    id: 'score_board',
    label: 'Score Board',
    description: 'You have a scoreboard. Write a function that does something with it.',
    code: `// Shared variables — do NOT redefine these.
let scores = { alice: 10, bob: 5, charlie: 8 };
let winner = null;
let log = [];`,
  },
  {
    id: 'shopping_cart',
    label: 'Shopping Cart',
    description: 'A shopping cart with some items. Write a function that manipulates it.',
    code: `// Shared variables — do NOT redefine these.
let cart = [
  { name: 'apple',  price: 1.2,  qty: 3 },
  { name: 'bread',  price: 2.5,  qty: 1 },
  { name: 'milk',   price: 1.8,  qty: 2 },
];
let discount = 0;
let log = [];`,
  },
  {
    id: 'chat_room',
    label: 'Chat Room',
    description: 'A chat room with messages and users. Write a function that does something.',
    code: `// Shared variables — do NOT redefine these.
let messages = [
  { user: 'alice', text: 'hello!' },
  { user: 'bob',   text: 'hey there' },
];
let bannedWords = ['spam'];
let log = [];`,
  },
  {
    id: 'todo_list',
    label: 'Todo List',
    description: 'A todo list app. Write a function that operates on the todos.',
    code: `// Shared variables — do NOT redefine these.
let todos = [
  { id: 1, text: 'Buy groceries',   done: false },
  { id: 2, text: 'Walk the dog',    done: true  },
  { id: 3, text: 'Write some code', done: false },
];
let log = [];`,
  },
  {
    id: 'bank_account',
    label: 'Bank Account',
    description: 'A simple bank account. Write a function that does something financial.',
    code: `// Shared variables — do NOT redefine these.
let balance = 1000;
let transactions = [];
let frozen = false;
let log = [];`,
  },
];

function pickRandomSpec() {
  return VARIABLE_SPECS[Math.floor(Math.random() * VARIABLE_SPECS.length)];
}

// ── AI Function Generation ────────────────────────────────────────────────────

/**
 * Calls the Anthropic API to generate a JavaScript function for an AI player.
 * The AI only sees the shared variable spec — same as a human player.
 */
async function generateAIFunction(spec, aiName) {
  const fnName = aiName.toLowerCase().replace(/[^a-z0-9]/g, '_');

  const prompt = `You are playing a coding party game. You will be given some shared JavaScript variables and you must write exactly ONE JavaScript function that does something creative, funny, or chaotic with those variables.

Rules:
- Write exactly one function named \`${fnName}\`
- Do NOT redefine the shared variables
- Use the \`log\` array to push output strings (e.g. log.push("hello"))
- Keep it short: 5-15 lines max
- Be creative and a little unpredictable — this is a party game
- Return ONLY the raw JavaScript function, no explanation, no markdown, no backticks

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

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  const raw = data.content?.find(b => b.type === 'text')?.text || '';

  // Strip any accidental markdown fences
  const cleaned = raw
    .replace(/```javascript\n?/gi, '')
    .replace(/```js\n?/gi, '')
    .replace(/```\n?/gi, '')
    .trim();

  return cleaned || `function ${fnName}() { log.push('${aiName} had nothing to say.'); }`;
}

// ── Code Assembly ─────────────────────────────────────────────────────────────

function assembleProgram(specCode, submissions) {
  const functionDefs = submissions
    .map(({ playerName, code }) =>
      `// ── ${playerName}'s function ──────────────────────\n${code.trim()}`
    )
    .join('\n\n');

  // Extract all function names and auto-call them
  const fnNames = submissions.map(({ code }) => {
    const match = code.match(/function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/);
    return match ? match[1] : null;
  }).filter(Boolean);

  const autoCalls = fnNames.length
    ? `\n// ── Auto-calling all functions ──────────────────\n` +
    fnNames.map(n => `try { ${n}(); } catch(e) { log.push('${n}() threw: ' + e.message); }`).join('\n')
    : '';

  return `${specCode}\n\n${functionDefs}${autoCalls}`;
}

// ── Safe Execution ────────────────────────────────────────────────────────────

const TIMEOUT_MS = 3000;

function executeProgram(source) {
  const sandbox = {
    console: { log: () => { } },
    Math, JSON, Array, Object, String, Number, Boolean,
    setTimeout: undefined, setInterval: undefined,
    fetch: undefined, require: undefined, process: undefined,
  };

  try {
    const ctx = vm.createContext(sandbox);
    vm.runInContext(source, ctx, { timeout: TIMEOUT_MS });

    let logs = [];
    try {
      const rawLog = vm.runInContext('typeof log !== "undefined" ? log : []', ctx, { timeout: 200 });
      logs = Array.isArray(rawLog) ? rawLog.map(String) : [];
    } catch (_) { }

    return { output: logs, error: null };
  } catch (err) {
    const isTimeout = err.message && err.message.includes('timed out');
    return {
      output: [],
      error: isTimeout ? '⏱ Execution timed out (infinite loop?)' : `💥 Runtime error: ${err.message}`,
    };
  }
}

module.exports = { pickRandomSpec, generateAIFunction, assembleProgram, executeProgram };
