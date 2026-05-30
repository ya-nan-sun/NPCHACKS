/**
 * gameEngine.js
 * Handles variable spec generation, code assembly, and sandboxed execution.
 *
 * SAFETY: Uses Node's built-in `vm` module with a strict timeout.
 * For production, replace with vm2 or a subprocess jail.
 *   npm install vm2
 */

const vm = require('vm');

// ── Variable spec pool ────────────────────────────────────────────────────────
// Each spec gives players a shared "world" to write functions against.
// Players see ONLY the spec — not each other's functions.

const VARIABLE_SPECS = [
  {
    id: 'score_board',
    label: 'Score Board',
    description: 'You have a scoreboard. Write a function that does something with it.',
    code: `
// Shared variables — do NOT redefine these.
let scores = { alice: 10, bob: 5, charlie: 8 };
let winner = null;
let log = [];
    `.trim(),
  },
  {
    id: 'shopping_cart',
    label: 'Shopping Cart',
    description: 'A shopping cart with some items. Write a function that manipulates it.',
    code: `
// Shared variables — do NOT redefine these.
let cart = [
  { name: 'apple',  price: 1.2,  qty: 3 },
  { name: 'bread',  price: 2.5,  qty: 1 },
  { name: 'milk',   price: 1.8,  qty: 2 },
];
let discount = 0;
let log = [];
    `.trim(),
  },
  {
    id: 'chat_room',
    label: 'Chat Room',
    description: 'A chat room with messages and users. Write a function that does something.',
    code: `
// Shared variables — do NOT redefine these.
let messages = [
  { user: 'alice', text: 'hello!' },
  { user: 'bob',   text: 'hey there' },
];
let bannedWords = ['spam'];
let log = [];
    `.trim(),
  },
  {
    id: 'todo_list',
    label: 'Todo List',
    description: 'A todo list app. Write a function that operates on the todos.',
    code: `
// Shared variables — do NOT redefine these.
let todos = [
  { id: 1, text: 'Buy groceries',   done: false },
  { id: 2, text: 'Walk the dog',    done: true  },
  { id: 3, text: 'Write some code', done: false },
];
let log = [];
    `.trim(),
  },
  {
    id: 'bank_account',
    label: 'Bank Account',
    description: 'A simple bank account. Write a function that does something financial.',
    code: `
// Shared variables — do NOT redefine these.
let balance = 1000;
let transactions = [];
let frozen = false;
let log = [];
    `.trim(),
  },
];

function pickRandomSpec() {
  return VARIABLE_SPECS[Math.floor(Math.random() * VARIABLE_SPECS.length)];
}

// ── Code assembly ─────────────────────────────────────────────────────────────

/**
 * Build the full program from the shared spec + each player's submission.
 * Order: spec → player functions (in player order) → a final call to each function.
 *
 * @param {string} specCode  - The shared variable spec
 * @param {Array}  submissions - [{ playerName, code }] in player order
 * @returns {string} The full assembled source
 */
function assembleProgram(specCode, submissions) {
  const functionDefs = submissions
    .map(({ playerName, code }) =>
      `// ── ${playerName}'s function ──────────────────────\n${code.trim()}`
    )
    .join('\n\n');

  // Extract function names from submissions to auto-call them
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

// ── Safe execution ────────────────────────────────────────────────────────────

const TIMEOUT_MS = 3000;

/**
 * Execute the assembled program in a sandboxed vm context.
 * Returns { output, error, finalState }
 */
function executeProgram(source) {
  // We expose a `log` array and capture its state after execution.
  const sandbox = {
    // Allow basic JS globals
    console: { log: () => {} }, // silence, we use `log` array
    Math, JSON, Array, Object, String, Number, Boolean,
    setTimeout: undefined, setInterval: undefined, // block async
    fetch: undefined, require: undefined, process: undefined, // block dangerous APIs
  };

  try {
    const ctx = vm.createContext(sandbox);
    vm.runInContext(source, ctx, { timeout: TIMEOUT_MS });

    // Pull final state of top-level vars
    const finalState = {};
    const stateCapture = `
      (() => {
        const out = {};
        const keys = Object.keys(this);
        keys.forEach(k => {
          try { out[k] = JSON.stringify(this[k]); } catch(e) { out[k] = '[unserializable]'; }
        });
        return out;
      })()
    `;
    const rawState = vm.runInContext(stateCapture, ctx, { timeout: 500 });

    // Grab log array if it exists
    let logs = [];
    try {
      const rawLog = vm.runInContext('typeof log !== "undefined" ? log : []', ctx, { timeout: 200 });
      logs = Array.isArray(rawLog) ? rawLog.map(String) : [];
    } catch (_) {}

    return { output: logs, error: null, finalState: rawState };
  } catch (err) {
    const isTimeout = err.message && err.message.includes('timed out');
    return {
      output: [],
      error: isTimeout ? '⏱ Execution timed out (infinite loop?)' : `💥 Runtime error: ${err.message}`,
      finalState: {},
    };
  }
}

module.exports = { pickRandomSpec, assembleProgram, executeProgram };
