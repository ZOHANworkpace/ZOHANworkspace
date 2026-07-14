# ZOHANworkspace

A study workspace (dashboard, notes workspace, AI tutor, flashcard decks,
planner + gradebook, account) with a real backend behind it, styled in a
premium Glassmorphism / "Liquid Glass" theme.

## Design

Soft translucent cards with `backdrop-filter: blur`, a yellow / teal / lime
accent palette, squircle corner radii, subtle glossy gradients and specular
highlights, and a clean sans-serif system typeface (Inter). Buttons, tabs,
and hover states all carry fluid micro-interaction animations, click ripples,
and short synthesized sound/haptic feedback. The nav sidebar is a ghost rail —
just translucent icons — until you hover one, which pops it into a glass
squircle pill with its label; click to open that tab. The top bar (with the
ZOHANworkspace name) is now visible on every screen size, not just desktop.

### What's new in this pass
- **AI Recommendations** — a live, AI-generated study suggestion card on both
  the Dashboard and the Planner (refresh button, calls the Gemini proxy with
  your current tasks/decks/subjects as context).
- **AI Tutor quick-ask widget** — a floating button (bottom-right, visible on
  every tab) that opens a small chat panel for fast questions without leaving
  what you're doing.
- **Inline web search** — the Workspace "Quick Search" widget now searches
  server-side (`/api/search`, backed by DuckDuckGo's HTML endpoint) and shows
  results *inside the widget*, including an embedded page viewer — no more
  `window.open()` new tab. (Google's own result pages block iframe embedding
  via `X-Frame-Options`, so this uses a source that allows it; a small "↗"
  fallback link is there for the rare page that also refuses to embed.)
- Icon-based sidebar, plus real "+" and "back" icon glyphs on deck/add
  buttons instead of relying on text characters.
- Contrast pass: low-opacity text across the app was bumped up to stay
  legible on the glass surfaces.
- A labeled, percentage-readout progress bar in Memorize mode.

## Backend

- The Gemini API key lives only in `server.js`, read from `process.env` —
  the browser calls `/api/ai/chat` and never sees the key.
- Login/signup is backed by SQLite with `bcrypt` password hashing and JWT
  sessions.
- App data (decks, tasks, subjects, reminders, workspace notes, coin
  balance) round-trips through `/api/state`, stored server-side per
  account, with a debounced auto-save.
- Basic rate limiting on auth and AI routes.

## Run it locally

```bash
npm install
cp .env.example .env
# edit .env — paste in a Gemini key from https://aistudio.google.com/apikey
# and change JWT_SECRET to a long random string
npm start
```

Then open `http://localhost:3000`. Sign up once to create an account (data
is stored in `zohan.sqlite`, created automatically on first run).

## Deploying

Any Node host works (Render, Railway, Fly.io, a VPS). Set `GEMINI_API_KEY`,
`JWT_SECRET`, and `PORT` as environment variables there instead of a `.env`
file. `zohan.sqlite` is a single file — back it up if you care about the
data, or swap `db.js` for a hosted Postgres later if you outgrow SQLite.

## Where things live

```
├─ server.js       — Express app: auth, /api/state, /api/ai/chat (Gemini proxy)
├─ db.js           — SQLite schema (users, app_state)
├─ package.json
├─ .env.example
└─ public/
   ├─ index.html   — the whole frontend (single file)
   └─ app.css      — Glassmorphism design system (colors, squircles, motion)
```

## Honest limitations / next steps

- `app_state` is one JSON blob per user rather than fully normalized tables.
  Fine at this scale; if decks get huge or you want multi-device conflict
  resolution, split it into real `decks` / `tasks` / `subjects` tables.
- No password-reset flow yet (forgot-password email, etc.) — only sign in /
  sign up / change password while signed in.
- The floating draggable widgets (Pomodoro, video, search, sticky note) are
  per-session only — they don't get saved into `/api/state`.
