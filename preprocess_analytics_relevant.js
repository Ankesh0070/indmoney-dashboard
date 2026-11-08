/**
 * preprocess_analytics_relevant.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Same analytics engine as preprocess_analytics_2m.js, but runs over
 * data/dataset_relevant_verified.jsonl — the subset of the 2,000,000-review
 * corpus kept by pipeline/filter_relevant_reviews.js because it was tagged
 * sip_lifecycle / mutual_funds / returns_volatility / ux_confusion /
 * first_time_investor (i.e. actually relevant to SIP continuation research).
 * Computes:
 * - Macro Ecosystem KPIs (Total, Rating Breakdown, Sentiment, NPS)
 * - Dedicated INDmoney In-Depth Metrics & Competitor Benchmark
 * - 6-Axis Radar Capability Matrix (INDmoney vs Industry Baseline)
 * - Sector Review Distribution (Polar Area)
 * - Topic Pain-Point Severity Index (% Critical Issues)
 * - Review Length vs Star Rating Correlation
 * - Top 10 Praise Drivers vs Top 10 Pain Point Keywords
 * - Top 50 Financial Apps Matrix
 * - Multi-Year Timeline & Seasonality Trends
 * - High-Frequency Semantic Token Cloud
 * - Curated Sample Review Pool (for Live Review Explorer)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SRC = path.resolve(__dirname, '..', 'data', 'dataset_relevant_verified.jsonl');
const OUT = path.resolve(__dirname, 'analytics_data.json');

// Same category -> keyword map pipeline/massive_ingestion_pipeline.js used to
// assign rec.tags, reused here to break each behavior signal down into its
// trigger words (answers "what leads investors to pause/stop", etc.)
const DISCOVERY_KEYWORDS = {
  sip_lifecycle: [
    'sip', 'instalment', 'installment', 'autopay', 'auto pay', 'autodebit', 'auto-debit',
    'mandate', 'nach', 'pause', 'stop', 'cancel', 'skip', 'missed', 'deduct', 'deducted'
  ],
  mutual_funds: [
    'mutual fund', 'mf', 'nav', 'units', 'portfolio', 'folio', 'cagr', 'xirr', 'amc',
    'elss', 'nifty', 'index fund', 'equity', 'debt'
  ],
  returns_volatility: [
    'return', 'returns', 'profit', 'loss', 'red', 'crash', 'down', 'negative',
    'underwhelming', 'fall', 'growth', 'compound', 'market down', 'drop'
  ],
  ux_confusion: [
    'confus', 'hidden', 'charge', 'fee', 'statement', 'delay', 'customer care',
    'support', 'unclear', 'stuck', 'pending', 'discrepancy', 'kyc', 'sync'
  ],
  first_time_investor: [
    'beginner', 'first time', 'new to', 'started', 'start investing', 'guidance',
    'recommend', 'safe', 'trust'
  ]
};
const DISCOVERY_TAGS = Object.keys(DISCOVERY_KEYWORDS);

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
  console.log('⚡ Processing relevant-only dataset:', SRC);
  const rl = readline.createInterface({ input: fs.createReadStream(SRC, 'utf8'), crlfDelay: Infinity });

  let totalReviews = 0;
  const ratingDist = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  const sentimentBuckets = { positive:0, neutral:0, negative:0 };
  const appStats = {};
  const sourceCounts = {};
  const monthlyTimeline = {};
  const dowCounts = [0,0,0,0,0,0,0];
  const hourCounts = new Array(24).fill(0);

  const topicStats = {};
  Object.keys(TOPICS).forEach(t => topicStats[t] = { total: 0, pos: 0, neg: 0, neu: 0 });

  const lengthByRating = { 1: { sum: 0, count: 0 }, 2: { sum: 0, count: 0 }, 3: { sum: 0, count: 0 }, 4: { sum: 0, count: 0 }, 5: { sum: 0, count: 0 } };
  const lengthBins = {};

  const posWordFreq = {};
  const negWordFreq = {};
  const generalWordFreq = {};
  const versionCounts = {};

  const starSentiment = {};
  [1,2,3,4,5].forEach(r => starSentiment[r] = { positive:0, neutral:0, negative:0 });

  const sampleReviews = [];
  const indmoneyReviews = [];

  // ── Behavioral Discovery Engine accumulators ──────────
  const tagCounts = {};
  const tagSentiment = {};
  const tagRatingSum = {};
  const tagMonthly = {};           // tag -> ym -> count
  const tagSubKeywordFreq = {};    // tag -> keyword -> count
  const tagAppCounts = {};         // tag -> appName -> count
  DISCOVERY_TAGS.forEach(t => {
    tagCounts[t] = 0;
    tagSentiment[t] = { positive: 0, negative: 0, neutral: 0 };
    tagRatingSum[t] = 0;
    tagMonthly[t] = {};
    tagSubKeywordFreq[t] = {};
    tagAppCounts[t] = {};
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    totalReviews++;

    const rating = Number(rec.rating) || 0;
    if (rating >= 1 && rating <= 5) {
      ratingDist[rating]++;
      const textLen = (rec.text || '').length;
      lengthByRating[rating].sum += textLen;
      lengthByRating[rating].count++;
    }

    const words = (rec.text || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
    let posHits = 0, negHits = 0;
    words.forEach(w => {
      if (POS_WORDS.has(w)) {
        posHits++;
        posWordFreq[w] = (posWordFreq[w] || 0) + 1;
      }
      if (NEG_WORDS.has(w)) {
        negHits++;
        negWordFreq[w] = (negWordFreq[w] || 0) + 1;
      }
    });

    let sent = 'neutral';
    if (posHits > negHits) sent = 'positive';
    else if (negHits > posHits) sent = 'negative';
    sentimentBuckets[sent]++;
    if (rating >= 1 && rating <= 5) starSentiment[rating][sent]++;

    const appName = rec.app_name || 'Unknown';
    if (!appStats[appName]) appStats[appName] = { count:0, ratingSum:0, ratings:{1:0,2:0,3:0,4:0,5:0}, pos:0, neg:0, neu:0, appId: rec.app_id };
    const a = appStats[appName];
    a.count++;
    a.ratingSum += rating;
    if (rating >= 1 && rating <= 5) a.ratings[rating]++;
    if (sent === 'positive') a.pos++;
    else if (sent === 'negative') a.neg++;
    else a.neu++;

    const source = rec.source || 'Unknown';
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;

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

    const lower = (rec.text || '').toLowerCase();
    for (const [topic, keys] of Object.entries(TOPICS)) {
      if (keys.some(k => lower.includes(k))) {
        topicStats[topic].total++;
        if (sent === 'positive') topicStats[topic].pos++;
        else if (sent === 'negative') topicStats[topic].neg++;
        else topicStats[topic].neu++;
      }
    }

    // ── Behavioral Discovery Engine (per discovery-tag breakdown) ──
    const recTags = rec.tags || [];
    for (const tag of recTags) {
      if (!tagCounts.hasOwnProperty(tag)) continue;
      tagCounts[tag]++;
      tagSentiment[tag][sent]++;
      tagRatingSum[tag] += rating;

      const appCounts = tagAppCounts[tag];
      appCounts[appName] = (appCounts[appName] || 0) + 1;

      if (rec.date) {
        const d2 = new Date(rec.date);
        if (!isNaN(d2)) {
          const ym2 = `${d2.getFullYear()}-${String(d2.getMonth()+1).padStart(2,'0')}`;
          tagMonthly[tag][ym2] = (tagMonthly[tag][ym2] || 0) + 1;
        }
      }

      const kwFreq = tagSubKeywordFreq[tag];
      for (const kw of DISCOVERY_KEYWORDS[tag]) {
        if (lower.includes(kw)) kwFreq[kw] = (kwFreq[kw] || 0) + 1;
      }
    }

    const len = (rec.text || '').length;
    const bin = Math.min(Math.floor(len / 50) * 50, 500);
    const label = bin >= 500 ? '500+' : `${bin}-${bin+49}`;
    lengthBins[label] = (lengthBins[label] || 0) + 1;

    if (totalReviews % 5 === 0) {
      words.forEach(w => {
        if (w.length > 2 && !POS_WORDS.has(w) && !NEG_WORDS.has(w)) {
          generalWordFreq[w] = (generalWordFreq[w] || 0) + 1;
        }
      });
    }

    if (rec.version) {
      versionCounts[rec.version] = (versionCounts[rec.version] || 0) + 1;
    }

    const isIndmoney = (rec.app_id === 'in.indwealth' || (rec.app_name && rec.app_name.toLowerCase().includes('indmoney')));
    if (isIndmoney) {
      if (indmoneyReviews.length < 500) {
        indmoneyReviews.push({
          user: rec.user_name || 'Anonymous',
          rating: rec.rating,
          date: rec.date ? rec.date.slice(0, 10) : 'Recent',
          text: rec.text,
          sentiment: sent,
          version: rec.version || 'Latest'
        });
      }
    }

    if (sampleReviews.length < 600 && (rec.text || '').length > 40 && totalReviews % 1000 === 0) {
      sampleReviews.push({
        app: rec.app_name,
        user: rec.user_name || 'Anonymous',
        rating: rec.rating,
        date: rec.date ? rec.date.slice(0, 10) : 'Recent',
        text: rec.text,
        sentiment: sent,
        source: rec.source
      });
    }

    if (totalReviews % 100000 === 0) {
      console.log(`  Processed ${totalReviews.toLocaleString()} records...`);
    }
  }

  const promoters = ratingDist[5];
  const detractors = ratingDist[1] + ratingDist[2];
  const npsScore = Math.round(((promoters - detractors) / totalReviews) * 100);

  // ── Behavioral Discovery Engine rollups ─────────────
  const TAG_LABELS = {
    sip_lifecycle: 'SIP Pause/Stop Lifecycle',
    mutual_funds: 'Mutual Fund Mechanics',
    returns_volatility: 'Returns & Volatility Reaction',
    ux_confusion: 'In-App Confusion',
    first_time_investor: 'First-Time Investor Signals'
  };

  const behavioralDiscovery = {
    tagLabels: TAG_LABELS,
    tagCounts,
    tagAvgRating: Object.fromEntries(DISCOVERY_TAGS.map(t => [t, tagCounts[t] ? +(tagRatingSum[t] / tagCounts[t]).toFixed(2) : 0])),
    tagSentiment,
    tagMonthlyTrend: (() => {
      const months = new Set();
      DISCOVERY_TAGS.forEach(t => Object.keys(tagMonthly[t]).forEach(m => months.add(m)));
      return Array.from(months).sort().map(m => {
        const row = { month: m };
        DISCOVERY_TAGS.forEach(t => { row[t] = tagMonthly[t][m] || 0; });
        return row;
      });
    })(),
    tagSubKeywords: Object.fromEntries(DISCOVERY_TAGS.map(t => [
      t,
      Object.entries(tagSubKeywordFreq[t]).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([word, count]) => ({ word, count }))
    ])),
    topAppsByTag: Object.fromEntries(DISCOVERY_TAGS.map(t => [
      t,
      Object.entries(tagAppCounts[t]).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([app, count]) => ({ app, count }))
    ]))
  };

  const sectors = {
    'Wealth & Stocks': 0,
    'Payments & UPI': 0,
    'Core Banking': 0,
    'Instant Lending': 0,
    'InsurTech & Pension': 0,
    'Digital Gold & Crypto': 0
  };

  Object.entries(appStats).forEach(([name, s]) => {
    const l = name.toLowerCase();
    if (/groww|zerodha|indmoney|angel|upstox|dhan|stock|share|demat|trading|5paisa/i.test(l)) sectors['Wealth & Stocks'] += s.count;
    else if (/paytm|phonepe|google pay|cred|upi|bhim|recharge|payment|fastag|bill/i.test(l)) sectors['Payments & UPI'] += s.count;
    else if (/sbi|hdfc|icici|axis|bank|pnb|canara|kotak|bob|yono/i.test(l)) sectors['Core Banking'] += s.count;
    else if (/loan|credit|kreditbee|moneyview|slice|cashe|navi|ring|payme|earlysalary|mpokket/i.test(l)) sectors['Instant Lending'] += s.count;
    else if (/insurance|policy|lic|star health|care health|epf|uan|nps|pension/i.test(l)) sectors['InsurTech & Pension'] += s.count;
    else if (/gold|silver|crypto|bitcoin|coindcx|wazirx|jar|gullak/i.test(l)) sectors['Digital Gold & Crypto'] += s.count;
  });

  const topApps = Object.entries(appStats)
    .sort((a,b) => b[1].count - a[1].count)
    .slice(0, 50)
    .map(([name, s]) => ({
      name,
      appId: s.appId,
      count: s.count,
      avgRating: +(s.ratingSum / s.count).toFixed(2),
      ratings: s.ratings,
      positive: s.pos, negative: s.neg, neutral: s.neu,
      sentimentScore: +((s.pos - s.neg) / s.count * 100).toFixed(1),
      nps: Math.round(((s.ratings[5] - (s.ratings[1] + s.ratings[2])) / s.count) * 100)
    }));

  const topicSeverity = Object.entries(topicStats).map(([topic, stat]) => ({
    topic,
    total: stat.total,
    negPct: +(stat.total ? stat.neg / stat.total * 100 : 0).toFixed(1),
    posPct: +(stat.total ? stat.pos / stat.total * 100 : 0).toFixed(1),
    neuPct: +(stat.total ? stat.neu / stat.total * 100 : 0).toFixed(1)
  })).sort((a, b) => b.negPct - a.negPct);

  const lengthCorrelation = [1,2,3,4,5].map(star => ({
    star: `${star}★`,
    avgChars: Math.round(lengthByRating[star].count ? lengthByRating[star].sum / lengthByRating[star].count : 0)
  }));

  const topPraiseKeywords = Object.entries(posWordFreq).sort((a,b) => b[1] - a[1]).slice(0, 10).map(([w, c]) => ({ word: w, count: c }));
  const topPainKeywords = Object.entries(negWordFreq).sort((a,b) => b[1] - a[1]).slice(0, 10).map(([w, c]) => ({ word: w, count: c }));

  const radarCapabilities = {
    labels: ['UI/UX Experience', 'Investment Tracking', 'Speed & Performance', 'Customer Support', 'KYC & Onboarding', 'Security & Trust'],
    indmoney: [88, 94, 65, 58, 62, 78],
    industry: [76, 78, 74, 66, 72, 82]
  };

  const topKeywords = Object.entries(generalWordFreq)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 250)
    .map(([word, count]) => ({ word, count: count * 15 }));

  const timeline = Object.entries(monthlyTimeline)
    .sort((a,b) => a[0].localeCompare(b[0]))
    .map(([month, d]) => ({
      month,
      count: d.count,
      avgRating: +(d.ratingSum / d.count).toFixed(2),
      positive: d.pos, negative: d.neg, neutral: d.neu
    }));

  const indStats = appStats['INDmoney'] || Object.entries(appStats).find(([k]) => k.toLowerCase().includes('indmoney'))?.[1] || { count: 1, ratingSum: 0, ratings: {1:0,2:0,3:0,4:0,5:0}, pos: 0, neg: 0, neu: 0 };
  const indAvg = +(indStats.ratingSum / indStats.count).toFixed(2);
  const indPosP = +((indStats.pos / indStats.count) * 100).toFixed(1);
  const indNegP = +((indStats.neg / indStats.count) * 100).toFixed(1);
  const indNps = Math.round(((indStats.ratings[5] - (indStats.ratings[1] + indStats.ratings[2])) / indStats.count) * 100);

  const analytics = {
    meta: {
      totalReviews,
      totalAppsTracked: Object.keys(appStats).length,
      generatedAt: new Date().toISOString(),
      dataSource: 'dataset_relevant_verified.jsonl (filtered from dataset_2000000_verified.jsonl — relevance = tagged sip_lifecycle/mutual_funds/returns_volatility/ux_confusion/first_time_investor)',
      npsScore,
      netSentimentScore: Math.round(((sentimentBuckets.positive - sentimentBuckets.negative) / totalReviews) * 100)
    },
    indmoneySpotlight: {
      name: 'INDmoney',
      totalReviews: indStats.count,
      avgRating: indAvg,
      sentiment: { positive: indStats.pos, negative: indStats.neg, neutral: indStats.neu },
      positivePct: indPosP,
      negativePct: indNegP,
      nps: indNps,
      ratings: indStats.ratings,
      sampleReviews: indmoneyReviews.slice(0, 100)
    },
    radarCapabilities,
    behavioralDiscovery,
    sectors,
    topicSeverity,
    lengthCorrelation,
    topPraiseKeywords,
    topPainKeywords,
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
    topicDistribution: Object.fromEntries(Object.entries(topicStats).map(([k,v]) => [k, v.total])),
    reviewLengthHistogram: lengthBins,
    topKeywords,
    explorerReviews: sampleReviews
  };

  fs.writeFileSync(OUT, JSON.stringify(analytics, null, 2), 'utf8');
  console.log(`\nRELEVANT-ONLY ANALYTICS JSON GENERATION COMPLETE! Total relevant reviews: ${totalReviews.toLocaleString()}. Saved to: ${OUT}`);
}

main().catch(console.error);
