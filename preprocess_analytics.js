/**
 * preprocess_analytics.js
 * ─────────────────────────────────────────────────
 * Scans the 400k verified JSONL dataset and emits
 * dashboard/analytics_data.json  – ready for the web UI.
 */

const fs   = require('fs');
const path = require('path');
const readline = require('readline');

const SRC  = path.resolve(__dirname, '..', 'data', 'dataset_400000_verified.jsonl');
const OUT  = path.resolve(__dirname, 'analytics_data.json');

// ── sentiment keywords ────────────────────────────
const POS_WORDS = new Set([
  'great','good','excellent','awesome','amazing','love','best','easy','fast',
  'helpful','nice','superb','fantastic','perfect','smooth','wonderful','happy',
  'reliable','convenient','user-friendly','recommended','brilliant','useful',
  'intuitive','seamless','efficient','satisfied','impressed','outstanding'
]);
const NEG_WORDS = new Set([
  'bad','worst','terrible','horrible','poor','slow','crash','bug','fraud',
  'scam','pathetic','useless','disappointed','annoying','waste','broken',
  'hate','ugly','confusing','stuck','error','issue','problem','laggy','spam',
  'unresponsive','glitch','delay','lost','fail','failure','freeze','hang',
  'misleading','hidden','charges','deducted','stolen','cheat','fake'
]);

// ── fintech topic keywords ────────────────────────
const TOPICS = {
  'UX & Design':       ['ui','ux','design','interface','navigation','layout','theme','dark mode','look','beautiful','clean'],
  'Performance':       ['slow','fast','lag','crash','hang','freeze','loading','speed','smooth','responsive','buffer'],
  'Security & Trust':  ['security','otp','kyc','fraud','scam','trust','safe','privacy','hack','phishing','verify'],
  'Investment':        ['invest','sip','mutual fund','stock','equity','portfolio','returns','nifty','sensex','share','dividend'],
  'Payments & UPI':    ['upi','payment','transfer','send','receive','transaction','qr','pay','wallet','cashback','money'],
  'Customer Support':  ['support','help','response','ticket','call','chat','agent','resolve','complaint','waiting'],
  'Loans & Credit':    ['loan','credit','emi','interest','borrow','repay','lending','score','cibil'],
  'Banking':           ['bank','account','savings','fd','deposit','withdraw','balance','statement','passbook','ifsc'],
  'Onboarding':        ['signup','register','onboard','kyc','verification','login','activate','new user','first time'],
  'Rewards & Offers':  ['reward','offer','cashback','coupon','referral','bonus','discount','earn','points','promo']
};

async function main() {
  console.log('⏳  Reading', SRC);
  const rl = readline.createInterface({ input: fs.createReadStream(SRC, 'utf8'), crlfDelay: Infinity });

  // ── accumulators ────────────────────────────────
  let totalReviews = 0;
  const ratingDist = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  const sentimentBuckets = { positive:0, neutral:0, negative:0 };

  // per-app
  const appStats = {};          // appName -> { count, ratingSum, ratings:{}, sentiment:{pos,neg,neu} }
  // per-source
  const sourceCounts = {};
  // monthly timeline
  const monthlyTimeline = {};   // 'YYYY-MM' -> { count, ratingSum, pos, neg, neu }
  // day-of-week heatmap
  const dowCounts = [0,0,0,0,0,0,0]; // Sun=0
  // hour-of-day heatmap
  const hourCounts = new Array(24).fill(0);
  // topic hits
  const topicCounts = {};
  Object.keys(TOPICS).forEach(t => topicCounts[t] = 0);

  // review length histogram  (bins: 0-50,50-100,...500+)
  const lengthBins = {};
  // keyword frequency (top 200)
  const wordFreq = {};
  // version popularity
  const versionCounts = {};

  // star-sentiment cross-tab
  const starSentiment = {};
  [1,2,3,4,5].forEach(r => starSentiment[r] = { positive:0, neutral:0, negative:0 });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    totalReviews++;

    // ── rating ──────────────────────────────────
    const rating = Number(rec.rating) || 0;
    if (rating >= 1 && rating <= 5) ratingDist[rating]++;

    // ── sentiment (simple lexicon) ──────────────
    const words = (rec.text || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
    let posHits = 0, negHits = 0;
    words.forEach(w => { if (POS_WORDS.has(w)) posHits++; if (NEG_WORDS.has(w)) negHits++; });
    let sent = 'neutral';
    if (posHits > negHits) sent = 'positive';
    else if (negHits > posHits) sent = 'negative';
    sentimentBuckets[sent]++;
    if (rating >= 1 && rating <= 5) starSentiment[rating][sent]++;

    // ── per-app ─────────────────────────────────
    const appName = rec.app_name || 'Unknown';
    if (!appStats[appName]) appStats[appName] = { count:0, ratingSum:0, ratings:{1:0,2:0,3:0,4:0,5:0}, pos:0, neg:0, neu:0 };
    const a = appStats[appName];
    a.count++;
    a.ratingSum += rating;
    if (rating >= 1 && rating <= 5) a.ratings[rating]++;
    if (sent === 'positive') a.pos++;
    else if (sent === 'negative') a.neg++;
    else a.neu++;

    // ── source ──────────────────────────────────
    const source = rec.source || 'Unknown';
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;

    // ── timeline ────────────────────────────────
    if (rec.date) {
      try {
        const d = new Date(rec.date);
        if (!isNaN(d)) {
          const ym = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
          if (!monthlyTimeline[ym]) monthlyTimeline[ym] = { count:0, ratingSum:0, pos:0, neg:0, neu:0 };
          const mt = monthlyTimeline[ym];
          mt.count++; mt.ratingSum += rating;
          if (sent === 'positive') mt.pos++;
          else if (sent === 'negative') mt.neg++;
          else mt.neu++;
          dowCounts[d.getDay()]++;
          hourCounts[d.getHours()]++;
        }
      } catch {}
    }

    // ── topic detection ─────────────────────────
    const lower = (rec.text || '').toLowerCase();
    for (const [topic, keys] of Object.entries(TOPICS)) {
      if (keys.some(k => lower.includes(k))) topicCounts[topic]++;
    }

    // ── review length ───────────────────────────
    const len = (rec.text || '').length;
    const bin = Math.min(Math.floor(len / 50) * 50, 500);
    const label = bin >= 500 ? '500+' : `${bin}-${bin+49}`;
    lengthBins[label] = (lengthBins[label] || 0) + 1;

    // ── word freq (sample every 5th record for speed) ──
    if (totalReviews % 5 === 0) {
      words.forEach(w => {
        if (w.length > 2 && !POS_WORDS.has(w) && !NEG_WORDS.has(w)) {
          wordFreq[w] = (wordFreq[w] || 0) + 1;
        }
      });
    }

    // ── version ─────────────────────────────────
    if (rec.version) {
      versionCounts[rec.version] = (versionCounts[rec.version] || 0) + 1;
    }

    if (totalReviews % 50000 === 0) process.stdout.write(`  processed ${totalReviews.toLocaleString()} records...\n`);
  }

  // ── build output object ─────────────────────────
  // top 30 apps by volume
  const topApps = Object.entries(appStats)
    .sort((a,b) => b[1].count - a[1].count)
    .slice(0, 30)
    .map(([name, s]) => ({
      name, count: s.count,
      avgRating: +(s.ratingSum / s.count).toFixed(2),
      ratings: s.ratings,
      positive: s.pos, negative: s.neg, neutral: s.neu,
      sentimentScore: +((s.pos - s.neg) / s.count * 100).toFixed(1)
    }));

  // top 200 keywords
  const topKeywords = Object.entries(wordFreq)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 200)
    .map(([word, count]) => ({ word, count: count * 5 })); // compensate for 1-in-5 sampling

  // sorted timeline
  const timeline = Object.entries(monthlyTimeline)
    .sort((a,b) => a[0].localeCompare(b[0]))
    .map(([month, d]) => ({
      month,
      count: d.count,
      avgRating: +(d.ratingSum / d.count).toFixed(2),
      positive: d.pos, negative: d.neg, neutral: d.neu
    }));

  // top 20 versions
  const topVersions = Object.entries(versionCounts)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 20)
    .map(([version, count]) => ({ version, count }));

  const analytics = {
    meta: {
      totalReviews,
      generatedAt: new Date().toISOString(),
      dataSource: 'dataset_400000_verified.jsonl'
    },
    ratingDistribution: ratingDist,
    sentimentOverview: sentimentBuckets,
    starSentimentCrossTab: starSentiment,
    topApps,
    sourceCounts,
    monthlyTimeline: timeline,
    dayOfWeekHeatmap: {
      labels: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],
      values: dowCounts
    },
    hourOfDayHeatmap: hourCounts,
    topicDistribution: topicCounts,
    reviewLengthHistogram: lengthBins,
    topKeywords,
    topVersions
  };

  fs.writeFileSync(OUT, JSON.stringify(analytics, null, 2), 'utf8');
  console.log(`\n✅  analytics_data.json written (${totalReviews.toLocaleString()} reviews processed)`);
}

main().catch(err => { console.error(err); process.exit(1); });
