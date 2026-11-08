/**
 * preprocess_primary_research.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Parses the author's own primary-research survey (primary_research_survey.csv
 * — a Google Form export, n respondents) and aggregates it into
 * primary_research_data.json for the "Primary Research" section of the
 * dashboard. This is distinct from the 51,979-review secondary dataset:
 * it's direct, first-party survey evidence of real SIP investors' behavior.
 */

const fs = require('fs');
const path = require('path');

const CSV_FILE = path.join(__dirname, 'primary_research_survey.csv');
const OUT_FILE = path.join(__dirname, 'primary_research_data.json');

// Minimal RFC4180 CSV line parser (handles quoted fields, no embedded commas
// inside quotes escaping other than doubled quotes — sufficient for a Google
// Forms export).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0] !== '');
}

function trim(s) { return (s || '').trim(); }

function splitMulti(s) {
  return trim(s).split(';').map(trim).filter(Boolean);
}

// `denom` is the % base: respondent count for both single- and multi-select
// questions, so a multi-select bar reads as "% of respondents who picked
// this" (bars needn't sum to 100%), not "% of all picks across everyone".
function distribution(values, denom) {
  const counts = new Map();
  values.forEach(v => { if (v) counts.set(v, (counts.get(v) || 0) + 1); });
  const total = denom != null ? denom : values.length;
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count, pct: total ? +((count / total) * 100).toFixed(1) : 0 }))
    .sort((a, b) => b.count - a.count);
}

const raw = fs.readFileSync(CSV_FILE, 'utf8');
const rows = parseCsv(raw);
const header = rows[0];
const dataRows = rows.slice(1).filter(r => r.some(c => trim(c) !== ''));

const COL = {
  timestamp: 0, app: 1, sipStart: 2, ageGroup: 3, income: 4,
  influence: 5, checkFreq: 6, lookFor: 7, unsureAction: 8
};

const respondents = dataRows.map(r => ({
  timestamp: trim(r[COL.timestamp]),
  app: trim(r[COL.app]),
  sipStart: trim(r[COL.sipStart]),
  ageGroup: trim(r[COL.ageGroup]),
  income: trim(r[COL.income]),
  influence: splitMulti(r[COL.influence]),
  checkFreq: trim(r[COL.checkFreq]),
  lookFor: splitMulti(r[COL.lookFor]),
  unsureAction: splitMulti(r[COL.unsureAction])
}));

const n = respondents.length;

const appDist = distribution(respondents.map(r => r.app), n);
const sipStartDist = distribution(respondents.map(r => r.sipStart), n);
const ageGroupDist = distribution(respondents.map(r => r.ageGroup), n);
const incomeDist = distribution(respondents.map(r => r.income), n);
const influenceDist = distribution(respondents.flatMap(r => r.influence), n);
const checkFreqDist = distribution(respondents.map(r => r.checkFreq), n);
const lookForDist = distribution(respondents.flatMap(r => r.lookFor), n);
const unsureActionDist = distribution(respondents.flatMap(r => r.unsureAction), n);

// A few headline, human-readable insights derived straight from the
// aggregates above (no external interpretation beyond the top entries).
const pct = (dist, label) => {
  const row = dist.find(d => d.label === label);
  return row ? row.pct : 0;
};
const selfResearchPct = +(
  (respondents.filter(r => r.influence.includes('Self-research')).length / n) * 100
).toFixed(1);
const dailyOrFewTimesPct = +(
  (respondents.filter(r => r.checkFreq === 'Daily' || r.checkFreq === 'A few times a week').length / n) * 100
).toFixed(1);
const outsideAppHelpPct = +(
  (respondents.filter(r => r.unsureAction.length > 0).length / n) * 100
).toFixed(1);

const insights = [
  {
    label: 'Top entry app',
    value: appDist[0] ? `${appDist[0].label} (${appDist[0].pct}%)` : 'n/a',
    note: 'where first-time SIP investors in this sample actually started'
  },
  {
    label: 'Self-research driven',
    value: `${selfResearchPct}%`,
    note: 'cite self-research as an influence on starting their SIP, more than any single social source'
  },
  {
    label: 'Check frequently',
    value: `${dailyOrFewTimesPct}%`,
    note: 'check their SIP/portfolio daily or a few times a week'
  },
  {
    label: 'Look outside the app when unsure',
    value: `${outsideAppHelpPct}%`,
    note: 'leave the app entirely (YouTube, forums, friends, advisors) when confused about their SIP'
  },
  {
    label: 'Top thing checked in-app',
    value: lookForDist[0] ? lookForDist[0].label : 'n/a',
    note: 'the single most-opened screen/intent when respondents open their investing app'
  }
];

const output = {
  meta: {
    n,
    source: 'Author-administered primary survey (Google Forms), self-reported, convenience sample',
    collectedThrough: dataRows.length ? trim(dataRows[dataRows.length - 1][COL.timestamp]) : null,
    questions: header.slice(1).map(trim)
  },
  appDist,
  sipStartDist,
  ageGroupDist,
  incomeDist,
  influenceDist,
  checkFreqDist,
  lookForDist,
  unsureActionDist,
  insights
};

fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
console.log(`[Primary Research] Parsed ${n} respondents -> ${path.basename(OUT_FILE)}`);
console.log(`[Primary Research] App dist:`, appDist.map(a => `${a.label}=${a.count}`).join(', '));
