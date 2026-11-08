const fs = require('fs');
const path = require('path');

const root = __dirname;
const out = path.join(root, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const file of ['index.html', 'analytics_data.json']) {
  fs.copyFileSync(path.join(root, file), path.join(out, file));
}

// Publish the aggregate survey data, which contains no respondent-level rows.
fs.copyFileSync(
  path.join(root, 'primary_research_data.json'),
  path.join(out, 'primary_research_data.json')
);

// The local interview file contains participant names. The public build keeps
// the research evidence but replaces identities before it ever reaches Vercel.
const interviews = JSON.parse(fs.readFileSync(path.join(root, 'interview_data.json'), 'utf8'));
const aliases = [
  { name: 'Participant A', role: 'Early SIP investor', income: 'Self-employed' },
  { name: 'Participant B', role: 'Early SIP investor', income: 'Salaried' }
];
const replacements = interviews.participants.map((participant, index) => ({
  full: participant.name,
  first: participant.name.split(' ')[0],
  alias: aliases[index]?.name || `Participant ${index + 1}`
}));
const anonymize = value => {
  if (typeof value === 'string') {
    return replacements.reduce((text, item) =>
      text.replaceAll(item.full, item.alias).replaceAll(item.first, item.alias), value);
  }
  if (Array.isArray(value)) return value.map(anonymize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, anonymize(item)]));
  }
  return value;
};
const publicInterviews = anonymize(interviews);
publicInterviews.participants = publicInterviews.participants.map((participant, index) => ({
  ...participant,
  name: aliases[index]?.name || `Participant ${index + 1}`,
  role: aliases[index]?.role || 'SIP investor',
  income: aliases[index]?.income || 'Not disclosed'
}));
fs.writeFileSync(
  path.join(out, 'interview_data.json'),
  JSON.stringify(publicInterviews, null, 2)
);

// Vercel serves index.html automatically at `/`. Keep a matching fallback so
// direct navigation never lands on a generic platform 404 page.
fs.copyFileSync(path.join(root, 'index.html'), path.join(out, '404.html'));

console.log('Vercel static dashboard built in dist/');
