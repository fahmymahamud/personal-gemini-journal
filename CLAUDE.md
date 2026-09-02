## COMPETITION BUILD — Personal Gemini Journal
Deadline: 6 September 2026
GCP Project: elemental-component-27dgj

Stack (competition requirements):
- Firebase Auth (email + Google sign-in)
- Cloud Firestore (isolated per-user data storage)
- Gemini API via AI Studio (multi-turn AI interaction)
- Cloud Run (deployment)
- Secret Manager (API keys — never hardcoded)

Concept: RemindClient reframed as "Personal Gemini Journal"
- The "journal" = coach's record of students, payments, lessons
- The "Gemini" = AI chat that reads the journal and drafts reminders
- Multi-turn flow: coach picks student → Gemini drafts reminder
  → coach refines via chat ("make it shorter", "add PayNow number")
  → coach taps send (wa.me link) or queues for bot

Framework: vanilla JS + Express (Node.js) — Fahmy's natural style
Deploy: Cloud Run via Docker

Build order for this session:
1. Express server + Firebase Admin SDK setup
2. Firebase Auth (frontend login — email + Google)
3. Firestore: students collection with userId scoping
4. Gemini multi-turn chat panel
5. Wire: pick student → Gemini knows their data → drafts message
6. Dockerfile + Cloud Run deploy
7. Secret Manager for Gemini key + bot token
8. Telegram bot cron (Cloud Scheduler + Cloud Run Job) — if time permits

DO NOT use Vertex AI — use Gemini API via @google/genai package.
(@google/generative-ai is the deprecated predecessor; @google/genai is the
current SDK for the same AI Studio Gemini Developer API. Still not Vertex.)
DO NOT hardcode any keys anywhere.