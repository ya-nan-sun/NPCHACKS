// Local snippet library — picks a random card from buggy_java_cards.json.
// Replaces the Claude API call; no network needed.

const cards = require('./buggy_java_cards.json').cards;

// Pre-index cards by bugCount for fast lookup.
const byCount = {};
for (const card of cards) {
  const n = card.bugCount;
  if (!byCount[n]) byCount[n] = [];
  byCount[n].push(card);
}

const allCounts = Object.keys(byCount).map(Number).sort((a, b) => a - b);

/**
 * Return a random card whose bugCount is as close as possible to targetBugCount.
 * Converts the flat bugs string array into the {line, type, description} shape
 * the rest of the game expects.
 */
function generateSnippet(difficulty, targetBugCount) {
  // Find the closest available bugCount to the target.
  let best = allCounts[0];
  let bestDiff = Math.abs(allCounts[0] - targetBugCount);
  for (const n of allCounts) {
    const d = Math.abs(n - targetBugCount);
    if (d < bestDiff) { bestDiff = d; best = n; }
  }

  const pool = byCount[best];
  const card = pool[Math.floor(Math.random() * pool.length)];

  // Convert string bugs to structured objects.
  // Format in JSON is "Line N: description" — parse that out.
  const bugs = (card.bugs || []).map((b) => {
    const m = String(b).match(/^Line\s+(\d+):\s*(.+)$/i);
    return {
      line: m ? Number(m[1]) : 0,
      type: inferType(m ? m[2] : b),
      description: m ? m[2] : String(b),
    };
  });

  return Promise.resolve({
    language: 'java',
    title: card.title || null,
    code: card.code,
    bugs,
    bugCount: bugs.length,
  });
}

function inferType(desc) {
  const d = desc.toLowerCase();
  if (d.includes('semicolon'))               return 'missing semicolon';
  if (d.includes('brace') || d.includes('{')) return 'missing brace';
  if (d.includes('off-by-one') || d.includes('<= instead of <') || d.includes('< instead of <=')) return 'off-by-one';
  if (d.includes('i--') || d.includes('decrement')) return 'wrong operator';
  if (d.includes('= 0') || d.includes('assignment') || d.includes('== ')) return 'wrong operator';
  if (d.includes('addition') || d.includes('subtraction') || d.includes('multiplication') || d.includes('division')) return 'wrong operator';
  if (d.includes('swap') || d.includes('reversed') || d.includes('wrong order')) return 'swapped values';
  if (d.includes('wrong') || d.includes('incorrect')) return 'wrong value';
  if (d.includes('missing')) return 'missing token';
  return 'logic error';
}

module.exports = { generateSnippet };
