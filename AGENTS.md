# AGENTS.md — Minerva Workspace

## Deployment — ONE REPO

**`jonathancheezy/minervalearning`** — everything lives here.

Push to `minervalearning/main` → Cloudflare Pages auto-deploys to `https://minervalearning-admin.minerva-ai-learning.workers.dev/`

## Firebase
- Project: `minerva-learning-a7eac`
- Collection: `registrations`

## Forms
- `parent_registration.html` — Firebase Firestore form (parent/student registration)
- `admin_dashboard.html` — Firebase admin view (reads from `registrations`)
- `teacher_registration.html` — teacher onboarding
