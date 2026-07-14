require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(cors());
app.use(express.json({ limit: '15mb' })); // generous limit: chat can carry attached photos as base64

// ---------- Rate limiting ----------
// The Gemini proxy is the expensive/abusable route, so it gets its own tighter limiter.
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

// ---------- Auth helpers ----------
function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
  }
}

function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name, school: row.school, age: row.age, grade: row.grade };
}

// ---------- Auth routes ----------
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const { email, password, name, school, age, grade } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'Email, password, and name are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: 'An account with that email already exists. Try signing in instead.' });

  const passwordHash = await bcrypt.hash(password, 10);
  const info = db.prepare(
    'INSERT INTO users (email, password_hash, name, school, age, grade) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(email.toLowerCase().trim(), passwordHash, name.trim(), school || '', age || null, grade || '');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  db.prepare('INSERT INTO app_state (user_id, state_json) VALUES (?, ?)').run(user.id, JSON.stringify(defaultState()));

  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'No account found with that email.' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Incorrect password.' });

  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  res.json({ user: publicUser(user) });
});

app.put('/api/me', requireAuth, (req, res) => {
  const { name, school, age, grade } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Display name cannot be blank.' });
  db.prepare('UPDATE users SET name = ?, school = ?, age = ?, grade = ? WHERE id = ?')
    .run(name.trim(), school || '', age || null, grade || '', req.user.uid);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  res.json({ user: publicUser(user) });
});

app.put('/api/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  const match = await bcrypt.compare(currentPassword || '', user.password_hash);
  if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });
  const newHash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.uid);
  res.json({ ok: true });
});

// ---------- App state (decks, tasks, subjects, reminders, workspace files, coins) ----------
function defaultState() {
  return {
    decks: [],
    tasks: [],
    subjects: [],
    reminders: [],
    workspaceFiles: [],
    coins: 250
  };
}

app.get('/api/state', requireAuth, (req, res) => {
  const row = db.prepare('SELECT state_json FROM app_state WHERE user_id = ?').get(req.user.uid);
  res.json({ state: row ? JSON.parse(row.state_json) : defaultState() });
});

app.put('/api/state', requireAuth, (req, res) => {
  const { state } = req.body || {};
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'Missing state payload.' });
  const existing = db.prepare('SELECT user_id FROM app_state WHERE user_id = ?').get(req.user.uid);
  if (existing) {
    db.prepare("UPDATE app_state SET state_json = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(JSON.stringify(state), req.user.uid);
  } else {
    db.prepare('INSERT INTO app_state (user_id, state_json) VALUES (?, ?)').run(req.user.uid, JSON.stringify(state));
  }
  res.json({ ok: true });
});

// ---------- Gemini proxy ----------
// The API key lives only here, server-side, in process.env. The browser never sees it.
app.post('/api/ai/chat', requireAuth, aiLimiter, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY. Ask the site owner to configure it in .env.' });
  }
  const { systemPrompt, message, images } = req.body || {};
  if (!message && !(images && images.length)) {
    return res.status(400).json({ error: 'Send a message or at least one image.' });
  }

  const parts = [];
  if (systemPrompt) parts.push({ text: systemPrompt });
  (images || []).slice(0, 6).forEach(img => {
    if (img && img.base64 && img.mimeType) parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
  });
  parts.push({ text: message || 'Please look at the attached image(s).' });

  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }] })
      }
    );
    const data = await upstream.json();
    if (!upstream.ok) {
      const detail = data && data.error && data.error.message ? data.error.message : 'Unknown upstream error.';
      return res.status(502).json({ error: `AI provider error: ${detail}` });
    }
    const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts.map(p => p.text || '').join('')) || '';
    res.json({ text });
  } catch (err) {
    console.error('Gemini proxy failure:', err);
    res.status(502).json({ error: 'Could not reach the AI provider. Please try again.' });
  }
});

// ---------- Search proxy ----------
// Runs the fetch server-side and returns parsed results, so the Quick Search
// widget can render results (and open pages in an in-app viewer) without ever
// doing window.open() to a new browser tab. Google's own result pages send an
// X-Frame-Options header that blocks iframe embedding on third-party sites, so
// this uses DuckDuckGo's HTML endpoint instead, which is iframe/embed-friendly.
const searchLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

app.get('/api/search', requireAuth, searchLimiter, async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'Missing search query.' });

  try {
    const upstream = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZOHANworkspace/1.0)' }
    });
    const html = await upstream.text();

    const results = [];
    const rowRegex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
    let match;
    while ((match = rowRegex.exec(html)) && results.length < 8) {
      let rawUrl = match[1];
      // DuckDuckGo wraps real URLs behind /l/?uddg=<encoded>
      const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
      const finalUrl = uddgMatch ? decodeURIComponent(uddgMatch[1]) : rawUrl;
      let displayUrl = finalUrl;
      try { displayUrl = new URL(finalUrl).hostname.replace(/^www\./, ''); } catch (e) {}
      results.push({
        title: stripTags(match[2]),
        url: finalUrl,
        displayUrl,
        snippet: stripTags(match[3]).slice(0, 140)
      });
    }
    res.json({ results });
  } catch (err) {
    console.error('Search proxy failure:', err);
    res.status(502).json({ error: 'Could not reach the search provider. Please try again.' });
  }
});

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`ZOHANworkspace server running: http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) console.warn('⚠️  GEMINI_API_KEY is not set — AI features will return an error until you add it to .env.');
});
