# INDmoney Review Engine

Public academic research dashboard covering verified fintech reviews, first-time SIP investor survey results, interview transcripts, and a grounded no-investment-advice RAG data assistant.

## Run

```bash
node local-server.js
```

Open `http://localhost:8099`.

The local grounded RAG server is `local-server.js`. It is deliberately not named `server.js`, because Vercel otherwise treats it as the production root function and ignores the static `dist/` dashboard.

## Deploy on Vercel

Import this repository with the repository root selected. Vercel uses `npm run build` and publishes `dist/` automatically from `vercel.json`.

The public repository contains the dashboard application and aggregate analytics. Raw review data, survey responses, and interview transcript files are intentionally excluded. Place authorized local research files in their documented paths to enable the grounded retrieval API. The assistant does not provide investment advice.
