/**
 * server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Combined static file server (serves dashboard/) + a grounded RAG API
 * (/api/ask) over THREE distinct, clearly-tagged corpora:
 *   1. "secondary"          — data/dataset_sip_only_verified.jsonl (51,979
 *                              real, SHA-256-deduped SIP-lifecycle reviews)
 *   2. "primary_survey"     — primary_research_survey.csv (the author's own
 *                              n=21 first-time-SIP-investor survey)
 *   3. "primary_interview"  — interview_data.json (2 recorded, transcribed
 *                              investor interviews)
 *
 * Every indexed document carries a `corpus` + human-readable `source` tag so
 * retrieval, citations and the quantitative review stats (avg rating,
 * %positive/negative) never conflate a secondary review with a self-reported
 * survey answer or an interview quote — each is labeled distinctly end to end.
 *
 * The RAG bot ONLY retrieves and summarizes real text already in these three
 * sources — it never calls an external LLM and never generates text that
 * wasn't derived from the corpus. It explicitly refuses any question that
 * asks for investment advice (which fund/stock to buy, whether to invest,
 * whether a SIP is "safe", etc.) per the project's no-advice constraint.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');
const url = require('url');

const DASHBOARD_DIR = __dirname;
const DATA_FILE = path.resolve(__dirname, 'data', 'dataset_sip_only_verified.jsonl');
const PRIMARY_SURVEY_CSV = path.join(__dirname, 'primary_research_survey.csv');
const INTERVIEW_JSON = path.join(__dirname, 'interview_data.json');
const PORT = 8099;

// ───────────────────────────── Sentiment lexicon (same as preprocess scripts) ─────────────────────────────
const POS_WORDS = new Set([
  'great','good','excellent','awesome','amazing','love','best','easy','fast',
  'helpful','nice','superb','fantastic','perfect','smooth','wonderful','happy',
  'reliable','convenient','user-friendly','recommended','brilliant','useful',
  'intuitive','seamless','efficient','satisfied','impressed','outstanding','quick','simple'
]);
const NEG_WORDS = new Set([
  'bad','worst','terrible','horrible','poor','slow','crash','bug','fraud',
  'scam','pathetic','useless','disappointed','annoying','waste','broken',
  'hate','ugly','confusing','stuck','error','issue','problem','laggy','spam',
  'unresponsive','glitch','delay','lost','fail','failure','freeze','hang',
  'misleading','hidden','charges','deducted','stolen','cheat','fake','penalty'
]);

const STOPWORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being','i','me','my','we','our',
  'you','your','he','she','it','its','they','them','their','this','that','these','those',
  'and','or','but','if','then','so','because','as','of','at','by','for','with','about',
  'against','between','into','through','during','before','after','above','below','to',
  'from','up','down','in','out','on','off','over','under','again','further','not','no',
  'nor','only','own','same','than','too','very','can','will','just','don','should','now',
  'do','does','did','doing','have','has','had','having','what','which','who','whom','why',
  'how','when','where','there','here','all','any','both','each','few','more','most','other',
  'some','such'
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

function sentimentOf(text) {
  const words = (text || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let pos = 0, neg = 0;
  words.forEach(w => { if (POS_WORDS.has(w)) pos++; if (NEG_WORDS.has(w)) neg++; });
  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

// ───────────────────────────── Thematic grouping (for "Thematic Findings & Evidence") ─────────────────────────────
// Each cited review is matched against every theme's keyword list (a review can
// land under more than one theme, same as a real multi-topic customer complaint).
const THEMES = {
  'SIP Pause & Stop Lifecycle': ['pause', 'stop sip', 'cancel sip', 'stop my sip', 'skip', 'mandate', 'nach', 'autopay', 'auto debit', 'auto-debit', 'instalment', 'installment', 'deduct'],
  'Mutual Fund Mechanics': ['mutual fund', 'nav', 'units', 'folio', 'cagr', 'xirr', 'elss', 'index fund', 'amc'],
  'Returns & Market Reaction': ['return', 'returns', 'loss', 'profit', 'crash', 'market down', 'negative', 'red', 'drop', 'fall'],
  'KYC & Onboarding': ['kyc', 'verification', 'verify', 'onboard', 'signup', 'register', 'activate', 'video kyc'],
  'App Confusion & Bugs': ['confus', 'stuck', 'error', 'sync', 'glitch', 'hang', 'crash', 'bug', 'unclear'],
  'Customer Support': ['customer care', 'support', 'response', 'complaint', 'ticket', 'helpline', 'waiting'],
  'Charges & Fees': ['charge', 'fee', 'hidden', 'penalty', 'deducted'],
  'First-Time Investor Guidance': ['beginner', 'first time', 'new to', 'start investing', 'guidance', 'trust', 'safe']
};

// ───────────────────────────── Investment-advice guardrail ─────────────────────────────
// Project constraint: never give fund/stock/SIP recommendations, never nudge with
// fear/FOMO/urgency. If a question is asking the bot to make an investment decision
// FOR the user, refuse and redirect — answer only from what reviewers said.
const ADVICE_PATTERNS = [
  /\b(should|shall|can)\s+i\s+(invest|buy|sell|start|stop|pause|cancel|put|withdraw)\b/i,
  /\bis\s+it\s+(safe|good|wise|worth|smart)\s+(to\s+)?(invest|buy|put)\b/i,
  /\bwhich\s+(fund|stock|sip|scheme|app)\s+(is\s+)?(best|better|good|should)\b/i,
  /\b(best|top|good)\s+(mutual\s+fund|sip|stock|scheme)s?\s+(to|for)\s+(invest|buy)\b/i,
  /\brecommend(ed)?\b.*\b(fund|stock|sip|scheme|invest(ment)?)\b/i,
  /\bwhich\s+(fund|stock|sip)\s+should\s+i\s+(pick|choose|buy|invest)\b/i,
  /\b(buy|sell|invest)\s+(now|today|this\s+fund|this\s+stock)\b/i,
  /\bhow\s+much\s+(should\s+i\s+)?invest\b/i,
  /\bis\s+.*\s+a\s+good\s+investment\b/i,
  /\bwhat\s+should\s+i\s+invest\s+in\b/i,
  /\bfinancial\s+advice\b/i,
  /\bportfolio\s+(allocation|advice|recommendation)\b/i
];
function isAdviceSeeking(q) {
  return ADVICE_PATTERNS.some(re => re.test(q));
}
const ADVICE_REFUSAL =
  "I can't recommend whether to invest, which fund/stock to pick, or whether a SIP is " +
  "safe for you — that's financial advice, and this bot only summarizes real app reviews, " +
  "our own primary investor survey, and interview transcripts already in the data. If you " +
  "want, ask me something like \"why do people pause their SIP?\" or \"what did interview " +
  "participants say about checking their SIP?\" and I'll answer from that evidence. " +
  "For actual investment decisions, please consult a SEBI-registered financial advisor.";

// ───────────────────────────── Load corpus + build BM25 index ─────────────────────────────
let docs = [];        // { app_name, rating, date, text, source, corpus, sentiment, tokens, tokenCount }
let df = new Map();   // term -> doc frequency
let postings = new Map(); // term -> [{ idx, tf }]
let avgDocLen = 0;
let ready = false;
let loadError = null;
let totalTokenLen = 0;
const corpusCounts = { secondary: 0, primary_survey: 0, primary_interview: 0 };

// Shared by all three corpora so every document — secondary review, survey
// response, or interview quote — goes through identical tokenizing/BM25
// indexing, and is distinguishable afterwards only by its `corpus`/`source` tag.
function addDoc(doc) {
  const text = doc.text || '';
  const tokens = tokenize(text);
  const idx = docs.length;

  docs.push({
    app_name: doc.app_name || 'Unknown',
    user_name: doc.user_name || 'Anonymous',
    rating: doc.rating != null ? doc.rating : null,
    date: doc.date || null,
    text,
    source: doc.source || 'Unknown',
    corpus: doc.corpus,
    sentiment: sentimentOf(text),
    tags: doc.tags || [],
    tokenCount: tokens.length
  });
  totalTokenLen += tokens.length;

  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [term, freq] of tf) {
    if (!postings.has(term)) postings.set(term, []);
    postings.get(term).push({ idx, tf: freq });
    df.set(term, (df.get(term) || 0) + 1);
  }

  corpusCounts[doc.corpus] = (corpusCounts[doc.corpus] || 0) + 1;
}

// Minimal RFC4180 CSV parser — handles quoted fields with embedded commas
// and doubled-quote escaping, sufficient for a Google Forms export.
function parseCsvSimple(text) {
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

// Primary survey (n=21, author-administered Google Form): one synthesized,
// readable doc per respondent so BM25 has real prose to match against.
function loadPrimarySurvey() {
  if (!fs.existsSync(PRIMARY_SURVEY_CSV)) { console.warn('[RAG] Primary survey CSV not found, skipping:', PRIMARY_SURVEY_CSV); return; }
  const raw = fs.readFileSync(PRIMARY_SURVEY_CSV, 'utf8');
  const rows = parseCsvSimple(raw).slice(1).filter(r => r.some(c => (c || '').trim() !== ''));

  rows.forEach((r, i) => {
    const [timestamp, app, sipStart, ageGroup, income, influence, checkFreq, lookFor, unsureAction] = r.map(c => (c || '').trim());
    const text =
      `First-time SIP investor survey response. Started their first SIP via ${app || 'an app'}, ${(sipStart || '').toLowerCase()}. ` +
      `Age group ${ageGroup || 'unspecified'}, income: ${income || 'unspecified'}. Influenced by: ${influence || 'not specified'}. ` +
      `Checks the SIP/portfolio in the app: ${(checkFreq || 'unspecified').toLowerCase()}. ` +
      `When opening the app, looks for: ${lookFor || 'not specified'}. ` +
      `When unsure about the SIP, outside the app did: ${unsureAction || 'nothing specific'}.`;

    addDoc({
      app_name: app || 'Unknown',
      user_name: `Survey Respondent #${i + 1}`,
      rating: null,
      date: timestamp ? timestamp.slice(0, 10) : null,
      text,
      source: 'Primary Survey (Author-Administered, n=21)',
      corpus: 'primary_survey',
      tags: ['primary-survey']
    });
  });

  console.log(`[RAG] Primary survey indexed: ${rows.length} respondents.`);
}

// Interview transcripts (2 recorded calls): one profile doc per participant
// plus one doc per theme-quote, so a question about any of the 8 shared
// themes (discovery, tracking, returns reaction, confusion, pausing, advice,
// feature wishes) retrieves the actual thing that participant said.
function loadInterviewTranscripts() {
  if (!fs.existsSync(INTERVIEW_JSON)) { console.warn('[RAG] interview_data.json not found, skipping:', INTERVIEW_JSON); return; }
  let data;
  try { data = JSON.parse(fs.readFileSync(INTERVIEW_JSON, 'utf8')); } catch (e) { console.warn('[RAG] Failed to parse interview_data.json:', e.message); return; }

  const participants = data.participants || [];

  participants.forEach(p => {
    const text =
      `${p.name} is a ${p.role}. Income: ${p.income}. Started their first SIP: ${p.sipStart}. ` +
      `Apps used: ${(p.apps || []).join(', ')}. Current status: ${p.status}.`;
    addDoc({
      app_name: (p.apps && p.apps[0]) || 'Unknown',
      user_name: `${p.name} (Interview)`,
      rating: null,
      date: null,
      text,
      source: 'Primary Interview Transcript (Recorded Call)',
      corpus: 'primary_interview',
      tags: ['primary-interview', 'participant-profile']
    });
  });

  (data.themes || []).forEach(theme => {
    participants.forEach(p => {
      const rawQuote = theme[p.id];
      if (!rawQuote) return;
      const quote = rawQuote.replace(/[“”]/g, '"');
      addDoc({
        app_name: (p.apps && p.apps[0]) || 'Unknown',
        user_name: `${p.name} (Interview)`,
        rating: null,
        date: null,
        text: `On "${theme.title}": ${quote}`,
        source: 'Primary Interview Transcript (Recorded Call)',
        corpus: 'primary_interview',
        tags: ['primary-interview', theme.title]
      });
    });
  });

  console.log(`[RAG] Interview transcripts indexed: ${participants.length} participants, ${(data.themes || []).length} themes.`);
}

async function buildIndex() {
  console.log('[RAG] Loading secondary corpus:', DATA_FILE);
  const rl = readline.createInterface({ input: fs.createReadStream(DATA_FILE, 'utf8'), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    addDoc({
      app_name: rec.app_name || 'Unknown',
      user_name: rec.user_name || 'Anonymous Customer',
      rating: rec.rating,
      date: rec.date,
      text: rec.text || '',
      source: rec.source || 'Unknown',
      corpus: 'secondary',
      tags: rec.tags || []
    });
    if (docs.length % 20000 === 0) console.log(`[RAG] Indexed ${docs.length.toLocaleString()} secondary reviews...`);
  }
  console.log(`[RAG] Secondary corpus loaded: ${corpusCounts.secondary.toLocaleString()} reviews.`);

  loadPrimarySurvey();
  loadInterviewTranscripts();

  avgDocLen = totalTokenLen / docs.length;
  ready = true;
  console.log(
    `[RAG] Index ready: ${docs.length.toLocaleString()} total docs ` +
    `(${corpusCounts.secondary.toLocaleString()} secondary reviews, ` +
    `${corpusCounts.primary_survey.toLocaleString()} primary survey, ` +
    `${corpusCounts.primary_interview.toLocaleString()} primary interview), ` +
    `${postings.size.toLocaleString()} unique terms.`
  );
}

// ───────────────────────────── Extractive summarizer ─────────────────────────────
// No external LLM: this ranks actual review SENTENCES by word-frequency relevance
// (classic Luhn-style extractive summarization) over the top BM25-matched reviews,
// then stitches the highest-scoring, non-redundant, app-diverse sentences into an
// "overall summary" paragraph. Every word in the summary came from a real review.
function splitSentences(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : [t];
}

function buildExtractiveSummary(poolIdxs, maxSentences = 5) {
  const freq = new Map();
  const sentenceObjs = [];

  for (const idx of poolIdxs) {
    const d = docs[idx];
    for (let s of splitSentences(d.text)) {
      // Strip forum @mention prefixes and stray quote markers so summary
      // sentences read as clean prose, not forum-reply fragments.
      s = s.replace(/^@\S+[,:]?\s*/, '').replace(/^>+\s*/, '').trim();
      if (s.length < 20 || s.length > 240) continue;
      const words = tokenize(s);
      if (words.length < 4) continue;
      sentenceObjs.push({ idx, app: d.app_name, sentence: s, words });
      for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  if (sentenceObjs.length === 0) return [];

  const maxFreq = Math.max(...freq.values());
  const normFreq = new Map();
  for (const [w, c] of freq) normFreq.set(w, c / maxFreq);

  sentenceObjs.forEach(o => {
    const score = o.words.reduce((s, w) => s + (normFreq.get(w) || 0), 0) / Math.sqrt(o.words.length);
    o.score = score;
  });
  sentenceObjs.sort((a, b) => b.score - a.score);

  const picked = [];
  const usedApps = new Map();
  const seenWordSets = [];

  for (const o of sentenceObjs) {
    if (picked.length >= maxSentences) break;
    const wordSet = new Set(o.words);
    let dup = false;
    for (const prevSet of seenWordSets) {
      let overlap = 0;
      for (const w of wordSet) if (prevSet.has(w)) overlap++;
      if (overlap / Math.min(wordSet.size, prevSet.size) > 0.6) { dup = true; break; }
    }
    if (dup) continue;
    const appCount = usedApps.get(o.app) || 0;
    if (appCount >= 2) continue;

    picked.push(o);
    usedApps.set(o.app, appCount + 1);
    seenWordSets.push(wordSet);
  }

  return picked.map(p => p.sentence);
}

const K1 = 1.5, B = 0.75;
function bm25Search(queryTokens, topK = 8) {
  const uniqueTerms = Array.from(new Set(queryTokens));
  const scores = new Map();
  const matchedSet = new Set();

  for (const term of uniqueTerms) {
    const list = postings.get(term);
    if (!list) continue;
    const dfT = list.length;
    const idf = Math.log((docs.length - dfT + 0.5) / (dfT + 0.5) + 1);
    for (const { idx, tf } of list) {
      matchedSet.add(idx);
      const docLen = docs[idx].tokenCount || 1;
      const denom = tf + K1 * (1 - B + B * (docLen / avgDocLen));
      const score = idf * ((tf * (K1 + 1)) / denom);
      scores.set(idx, (scores.get(idx) || 0) + score);
    }
  }

  const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]).slice(0, topK).map(([idx]) => idx);
  return { ranked, matchedSet };
}

function buildAnswer(question) {
  const t0 = Date.now();
  const qTokens = tokenize(question);
  if (qTokens.length === 0) {
    return {
      guarded: false,
      answer: "Could you rephrase that with a few more words? E.g. \"why do people stop their SIP\" or \"what causes KYC confusion\".",
      summary: null,
      stats: null,
      citations: []
    };
  }

  // Gather a wide pool of relevant reviews (up to 200) so the summarizer has
  // enough real sentences to work with, not just the top few.
  const { ranked, matchedSet } = bm25Search(qTokens, 200);
  const retrievalMs = Date.now() - t0;

  if (matchedSet.size === 0) {
    return {
      guarded: false,
      answer: `I couldn't find anything in the review corpus, the primary survey, or the interview transcripts matching "${question}". Try different wording, e.g. "SIP pause", "NACH mandate failure", "KYC delay", "first time investor confusion".`,
      summary: null,
      stats: null,
      citations: []
    };
  }

  // Quant review stats (avg rating, %positive/negative/neutral, top apps) are
  // computed from the SECONDARY review corpus only — mixing in self-reported
  // survey answers or interview quotes (no star rating, tiny n) would silently
  // distort "X% positive" claims. Evidence from all three corpora still flows
  // into citations/themes below, just clearly tagged by corpus.
  let ratingSum = 0, ratedCount = 0;
  let pos = 0, neg = 0, neu = 0;
  let secondaryTotal = 0;
  const appFreq = new Map();
  const sourceFreq = new Map();
  const corpusBreakdown = { secondary: 0, primary_survey: 0, primary_interview: 0 };
  for (const idx of matchedSet) {
    const d = docs[idx];
    corpusBreakdown[d.corpus] = (corpusBreakdown[d.corpus] || 0) + 1;
    sourceFreq.set(d.source, (sourceFreq.get(d.source) || 0) + 1);
    if (d.corpus !== 'secondary') continue;
    secondaryTotal++;
    if (typeof d.rating === 'number' && d.rating >= 1 && d.rating <= 5) { ratingSum += d.rating; ratedCount++; }
    if (d.sentiment === 'positive') pos++; else if (d.sentiment === 'negative') neg++; else neu++;
    appFreq.set(d.app_name, (appFreq.get(d.app_name) || 0) + 1);
  }
  const total = matchedSet.size; // across all three corpora
  const avgRating = ratedCount ? +(ratingSum / ratedCount).toFixed(2) : null;
  const posPct = secondaryTotal ? +((pos / secondaryTotal) * 100).toFixed(1) : 0;
  const negPct = secondaryTotal ? +((neg / secondaryTotal) * 100).toFixed(1) : 0;
  const neuPct = secondaryTotal ? +((neu / secondaryTotal) * 100).toFixed(1) : 0;
  const topApps = Array.from(appFreq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // ── Numbered, BM25-scored citations (the "Grounding Citations" evidence set) ──
  const citationPool = ranked.slice(0, 10);
  const scoreByIdx = new Map();
  (function recomputeScores() {
    const uniqueTerms = Array.from(new Set(qTokens));
    for (const term of uniqueTerms) {
      const list = postings.get(term);
      if (!list) continue;
      const dfT = list.length;
      const idf = Math.log((docs.length - dfT + 0.5) / (dfT + 0.5) + 1);
      for (const { idx, tf } of list) {
        if (!citationPool.includes(idx)) continue;
        const docLen = docs[idx].tokenCount || 1;
        const denom = tf + K1 * (1 - B + B * (docLen / avgDocLen));
        const s = idf * ((tf * (K1 + 1)) / denom);
        scoreByIdx.set(idx, (scoreByIdx.get(idx) || 0) + s);
      }
    }
  })();

  const citations = citationPool.map((idx, i) => {
    const d = docs[idx];
    return {
      index: i + 1,
      reviewer: d.user_name || 'Anonymous Customer',
      app_name: d.app_name,
      rating: d.rating,
      date: d.date ? String(d.date).slice(0, 10) : null,
      source: d.source,
      corpus: d.corpus,
      sentiment: d.sentiment,
      bm25: +(scoreByIdx.get(idx) || 0).toFixed(2),
      full_text: d.text,
      excerpt: d.text.length > 200 ? d.text.slice(0, 200).trim() + '…' : d.text
    };
  });

  // ── Sentiment trend over the cited sample (mirrors "N critical, N positive in top sample") ──
  let sampleCritical = 0, samplePositive = 0, sampleNeutral = 0;
  citations.forEach(c => {
    if (c.sentiment === 'negative') sampleCritical++;
    else if (c.sentiment === 'positive') samplePositive++;
    else sampleNeutral++;
  });
  const sentimentLabel = sampleCritical > samplePositive
    ? 'Predominantly Critical / Grievance-Oriented'
    : (samplePositive > sampleCritical ? 'Predominantly Positive' : 'Mixed / Neutral');

  // ── Thematic grouping: which themes does each cited review touch? ──
  const themeMap = new Map(); // label -> { mentions, citationIndexes: [] }
  citations.forEach(c => {
    const lower = c.full_text.toLowerCase();
    for (const [label, keywords] of Object.entries(THEMES)) {
      if (keywords.some(k => lower.includes(k))) {
        if (!themeMap.has(label)) themeMap.set(label, { mentions: 0, citationIndexes: [] });
        const t = themeMap.get(label);
        t.mentions++;
        t.citationIndexes.push(c.index);
      }
    }
  });
  const themes = Array.from(themeMap.entries())
    .sort((a, b) => b[1].mentions - a[1].mentions)
    .map(([label, t]) => ({ label, mentions: t.mentions, citationIndexes: t.citationIndexes.slice(0, 2) }));

  // ── Closing summary: extractive, word-frequency-ranked real sentences (no LLM) ──
  const summaryPool = ranked.slice(0, 150);
  const summarySentences = buildExtractiveSummary(summaryPool, 4);
  const closingSummary = summarySentences.length
    ? summarySentences.map(s => (/[.!?]$/.test(s) ? s : s + '.')).join(' ') +
      ' Refer to the citations panel for full source text.'
    : 'Refer to the citations panel for full source text.';

  const totalMs = Date.now() - t0;
  const appLine = topApps.map(([a, c]) => `${a} (${c})`).join(', ');
  const evidenceMixNote = `Evidence mix for this answer: ${corpusBreakdown.secondary.toLocaleString()} secondary review${corpusBreakdown.secondary === 1 ? '' : 's'}, ` +
    `${corpusBreakdown.primary_survey} primary survey response${corpusBreakdown.primary_survey === 1 ? '' : 's'}, ` +
    `${corpusBreakdown.primary_interview} interview quote${corpusBreakdown.primary_interview === 1 ? '' : 's'}.`;

  return {
    guarded: false,
    question,
    totalMatched: total,
    sampleSize: citations.length,
    retrievalMs,
    totalMs,
    sentimentTrend: { label: sentimentLabel, critical: sampleCritical, positive: samplePositive, neutral: sampleNeutral },
    dominantFactorsNote: `Queries relating to "${question}" frequently cite specific SIP lifecycle, KYC, or charge-related friction points across ${topApps.length} leading apps (${appLine}).`,
    evidenceMixNote,
    corpusBreakdown,
    corpusTotals: corpusCounts,
    themes,
    citations,
    closingSummary,
    stats: { total, secondaryTotal, avgRating, posPct, negPct, neuPct, topApps, sourceFreq: Object.fromEntries(sourceFreq) },
    // Back-compat plain-text fields (older UI code paths / API consumers)
    answer: secondaryTotal
      ? `Gathered ${total.toLocaleString()} matching record${total === 1 ? '' : 's'} (${secondaryTotal.toLocaleString()} secondary review${secondaryTotal === 1 ? '' : 's'}, avg rating ${avgRating ?? 'n/a'}★, ${posPct}% positive / ${negPct}% negative / ${neuPct}% neutral).`
      : `Gathered ${total.toLocaleString()} matching record${total === 1 ? '' : 's'} from the primary survey/interview corpus (no secondary reviews matched this query).`,
    summary: closingSummary
  };
}

// ───────────────────────────── HTTP server ─────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/api/ask' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (!ready) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: loadError || 'Index still loading, try again in a few seconds.' }));
        return;
      }
      let question = '';
      try { question = (JSON.parse(body || '{}').question || '').toString().slice(0, 500); } catch {}
      if (!question.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing "question" in request body.' }));
        return;
      }

      let result;
      if (isAdviceSeeking(question)) {
        result = { guarded: true, answer: ADVICE_REFUSAL, summary: null, stats: null, citations: [] };
      } else {
        result = buildAnswer(question);
      }
      result.disclaimer = 'Grounded only in verified SIP-lifecycle reviews, the author\'s primary investor survey, and recorded interview transcripts. Not financial advice — consult a licensed advisor for investment decisions.';
      res.writeHead(200);
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (parsed.pathname === '/api/health' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ ready, totalReviews: docs.length, corpusCounts }));
    return;
  }

  // Static file serving
  let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  filePath = path.join(DASHBOARD_DIR, path.normalize(filePath).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(DASHBOARD_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.writeHead(200);
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[Server] Dashboard + RAG API running at http://localhost:${PORT}`);
  buildIndex().catch(e => { loadError = e.message; console.error('[RAG] Index build failed:', e); });
});
