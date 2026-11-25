# Dawa Dost · دوا دوست

Scan a medicine strip or a doctor's prescription, get the cheaper same-salt option in Rs, hear it in Urdu, set family reminders, and ask AI agents. Built for Pakistani families.

## Run locally
```
npm install
copy .env.example .env     # then fill in the free keys
npm run dev
```
Open http://localhost:3000 . Live Room (big screen with QR): `/live.html`.

## Free API keys
- `GEMINI_API_KEY` - aistudio.google.com/apikey (vision, agents, voice)
- `GROQ_API_KEY` - console.groq.com/keys (automatic backup)

## Deploy on Render
1. Push this repo to GitHub.
2. Render dashboard -> New -> Blueprint -> pick the repo (it reads `render.yaml`).
3. Paste `GEMINI_API_KEY` and `GROQ_API_KEY` when asked.
4. After deploy, open `/api/selftest?key=<ADMIN_KEY>` (ADMIN_KEY is shown in the service's Environment tab) to confirm which model and API style work.

Medicine prices in `public/meds.json` are approximate placeholders; verify before presenting. Information only, not medical advice.
