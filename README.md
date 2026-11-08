# INDmoney Review Engine

Public academic research dashboard covering verified fintech reviews, first-time SIP investor survey results, interview transcripts, and a grounded no-investment-advice RAG data assistant.

## Run

```bash
npm start
```

Open `http://localhost:8099`.

## Deploy on Vercel

Import this repository with the repository root selected. Vercel uses `npm run build` and publishes `dist/` automatically from `vercel.json`.

The public repository contains the dashboard application and aggregate analytics. Raw review data, survey responses, and interview transcript files are intentionally excluded. Place authorized local research files in their documented paths to enable the grounded retrieval API. The assistant does not provide investment advice.
