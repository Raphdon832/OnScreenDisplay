const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const isProduction = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));

const publicDir = path.join(__dirname, 'public');
const bundledDataDir = path.join(__dirname, 'data');
const persistentRoot = process.env.PERSISTENT_ROOT || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const usePersistentRoot = Boolean(process.env.PERSISTENT_ROOT || process.env.RAILWAY_VOLUME_MOUNT_PATH);
const dataDir = usePersistentRoot ? path.join(persistentRoot, 'data') : bundledDataDir;
const mediaDir = usePersistentRoot
  ? path.join(persistentRoot, 'uploads', 'media')
  : path.join(__dirname, 'uploads', 'media');
const mediaLibraryPath = path.join(dataDir, 'media.json');
const displayStatePath = path.join(dataDir, 'display-state.json');
const adminPassword = process.env.ADMIN_PASSWORD || (isProduction ? '' : 'screen');
const authSecret = process.env.AUTH_SECRET || (isProduction ? '' : 'dev-auth-secret-change-me');
const authCookieName = 'onscreen_auth';
const authMaxAgeMs = 1000 * 60 * 60 * 24 * 30;
const loginAttempts = new Map();
const maxLoginAttempts = 10;
const loginWindowMs = 1000 * 60 * 15;

if (isProduction && (!process.env.ADMIN_PASSWORD || !process.env.AUTH_SECRET)) {
  console.error('ADMIN_PASSWORD and AUTH_SECRET must be set in production.');
  process.exit(1);
}

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, part) => {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) return cookies;

    try {
      cookies[rawName] = decodeURIComponent(rawValue.join('=') || '');
    } catch (err) {
      cookies[rawName] = rawValue.join('=') || '';
    }
    return cookies;
  }, {});
}

function signAuthValue(value) {
  return crypto
    .createHmac('sha256', authSecret)
    .update(value)
    .digest('hex');
}

function createAuthToken() {
  const value = `admin.${Date.now()}.${crypto.randomBytes(16).toString('hex')}`;
  return `${value}.${signAuthValue(value)}`;
}

function isValidAuthToken(token) {
  if (!token || typeof token !== 'string') return false;

  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return false;

  const value = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);
  const expected = signAuthValue(value);
  const [, rawCreatedAt] = value.split('.');
  const createdAt = Number(rawCreatedAt);

  if (!Number.isFinite(createdAt) || Date.now() - createdAt > authMaxAgeMs) {
    return false;
  }

  if (!/^[0-9a-f]{64}$/i.test(signature)) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

function passwordMatches(input) {
  if (!adminPassword || typeof input !== 'string') return false;

  const actual = crypto.createHash('sha256').update(adminPassword).digest();
  const provided = crypto.createHash('sha256').update(input).digest();
  return crypto.timingSafeEqual(actual, provided);
}

function getLoginAttemptKey(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function getLoginAttempt(req) {
  const key = getLoginAttemptKey(req);
  const attempt = loginAttempts.get(key);

  if (!attempt || Date.now() - attempt.firstAttempt > loginWindowMs) {
    return { key, count: 0, firstAttempt: Date.now() };
  }

  return { key, ...attempt };
}

function recordFailedLogin(req) {
  const attempt = getLoginAttempt(req);
  loginAttempts.set(attempt.key, {
    count: attempt.count + 1,
    firstAttempt: attempt.firstAttempt
  });
}

function clearLoginAttempts(req) {
  loginAttempts.delete(getLoginAttemptKey(req));
}

function isAuthenticatedRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return isValidAuthToken(cookies[authCookieName]);
}

function isAuthenticatedSocket(socket) {
  const cookies = parseCookies(socket.handshake.headers.cookie || '');
  return isValidAuthToken(cookies[authCookieName]);
}

function requireAuth(req, res, next) {
  if (isAuthenticatedRequest(req)) {
    return next();
  }

  if (!req.originalUrl.startsWith('/api/') && req.accepts('html')) {
    return res.redirect('/login.html');
  }

  return res.status(401).json({ error: 'Authentication required' });
}

function setAuthCookie(res) {
  const secure = isProduction ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${authCookieName}=${encodeURIComponent(createAuthToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${authMaxAgeMs / 1000}${secure}`);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${authCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

[dataDir, mediaDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

app.use('/media', express.static(mediaDir, {
  maxAge: '30d',
  immutable: true,
  setHeaders: (res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
}));

app.get('/login.html', (req, res) => {
  if (isAuthenticatedRequest(req)) {
    return res.redirect('/control.html');
  }

  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.get('/login', (req, res) => {
  res.redirect('/login.html');
});

app.get('/control.html', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'control.html'));
});

app.get('/control', requireAuth, (req, res) => {
  res.redirect('/control.html');
});

app.post('/api/auth/login', (req, res) => {
  const attempt = getLoginAttempt(req);
  if (attempt.count >= maxLoginAttempts) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }

  if (!passwordMatches(req.body && req.body.password)) {
    recordFailedLogin(req);
    return res.status(401).json({ error: 'Invalid password' });
  }

  clearLoginAttempts(req);
  setAuthCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: isAuthenticatedRequest(req) });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.use('/api/bible', requireAuth);
app.use('/api/media', requireAuth);
app.use(express.static(publicDir));

// Load Bible data
let bibleData = {};
try {
  bibleData = JSON.parse(fs.readFileSync(path.join(bundledDataDir, 'kjv.json'), 'utf8'));
  console.log('KJV Bible loaded successfully');
} catch (err) {
  console.log('Bible data not found, will use API fallback');
}

// Load Songs data
let songsLibrary = [];
const songsPath = path.join(dataDir, 'songs.json');

function loadSongs() {
  try {
    if (fs.existsSync(songsPath)) {
      songsLibrary = JSON.parse(fs.readFileSync(songsPath, 'utf8'));
      console.log(`Loaded ${songsLibrary.length} songs from library`);
    } else {
      // Create empty file if not exists
      fs.writeFileSync(songsPath, '[]', 'utf8');
      songsLibrary = [];
    }
  } catch (err) {
    console.error('Error loading songs:', err);
    songsLibrary = [];
  }
}

function saveSongs() {
  try {
    fs.writeFileSync(songsPath, JSON.stringify(songsLibrary, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving songs:', err);
  }
}

loadSongs();

// Load signage media library
let mediaLibrary = [];

function loadMediaLibrary() {
  try {
    if (fs.existsSync(mediaLibraryPath)) {
      mediaLibrary = JSON.parse(fs.readFileSync(mediaLibraryPath, 'utf8'));
      console.log(`Loaded ${mediaLibrary.length} media assets`);
    } else {
      fs.writeFileSync(mediaLibraryPath, '[]', 'utf8');
      mediaLibrary = [];
    }
  } catch (err) {
    console.error('Error loading media library:', err);
    mediaLibrary = [];
  }
}

function saveMediaLibrary() {
  try {
    fs.writeFileSync(mediaLibraryPath, JSON.stringify(mediaLibrary, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving media library:', err);
  }
}

function slugifyFilename(name) {
  const ext = path.extname(name).toLowerCase();
  const base = path.basename(name, ext)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'media';

  return `${base}-${Date.now()}${ext}`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, mediaDir),
    filename: (req, file, cb) => cb(null, slugifyFilename(file.originalname))
  }),
  limits: {
    fileSize: 500 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
      return;
    }

    cb(new Error('Only image and video files are supported'));
  }
});

const defaultDisplayState = {
  fontSize: 48,
  theme: 'dark'
};

function assetTypeFromMime(mimeType) {
  return mimeType && mimeType.startsWith('video/') ? 'video' : 'image';
}

function normalizePlaylistItem(item) {
  const asset = mediaLibrary.find((media) => media.id === item.id);
  if (!asset) return null;

  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    mimeType: asset.mimeType,
    url: asset.url,
    duration: Math.max(1, parseInt(item.duration || asset.duration || 10, 10)),
    fit: item.fit || asset.fit || 'contain'
  };
}

const supportedLayouts = new Set([
  'single',
  'split',
  'triple',
  'quad',
  'feature',
  'sidebar-left',
  'sidebar-right',
  'top-strip',
  'bottom-strip',
  'mosaic',
  'six',
  'portrait-duo',
  'portrait-trio',
  'portrait-hero',
  'portrait-stack',
  'portrait-grid'
]);

const supportedLogoPositions = new Set([
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
]);

function normalizeMediaLayout(layout) {
  return supportedLayouts.has(layout) ? layout : 'single';
}

function normalizeTicker(ticker = {}) {
  const styles = ticker.styles || {};
  const schedule = ticker.schedule || {};

  return {
    enabled: ticker.enabled === true,
    showTime: ticker.showTime !== false,
    label: String(ticker.label || 'Headlines').slice(0, 40),
    text: String(ticker.text || '').slice(0, 1000),
    speed: Math.max(8, Math.min(120, parseInt(ticker.speed || 28, 10))),
    schedule: {
      mode: ['permanent', 'show-window', 'hide-window'].includes(schedule.mode) ? schedule.mode : 'permanent',
      start: normalizeTime(schedule.start, '08:00'),
      end: normalizeTime(schedule.end, '18:00')
    },
    styles: {
      barBg: normalizeColor(styles.barBg, '#030712'),
      scrollBg: normalizeColor(styles.scrollBg, '#0f172a'),
      textColor: normalizeColor(styles.textColor, '#ffffff'),
      timeBg: normalizeColor(styles.timeBg, '#0f172a'),
      timeColor: normalizeColor(styles.timeColor, '#93c5fd'),
      labelBg: normalizeColor(styles.labelBg, '#2563eb'),
      labelColor: normalizeColor(styles.labelColor, '#ffffff')
    }
  };
}

function normalizeTime(value, fallback) {
  if (typeof value !== 'string') return fallback;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function normalizeColor(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : fallback;
}

function normalizeZoneItem(item, index) {
  if (!item || !item.id) return null;

  const normalized = normalizePlaylistItem(item);
  if (!normalized) return null;

  return {
    ...normalized,
    slot: index
  };
}

function normalizeZones(zones = []) {
  if (!Array.isArray(zones)) return [];
  return zones.map((item, index) => normalizeZoneItem(item, index));
}

function normalizeBackground(background = {}) {
  const type = ['none', 'color', 'image'].includes(background.type) ? background.type : 'color';
  const imageAsset = background.imageId
    ? mediaLibrary.find((asset) => asset.id === background.imageId && asset.type === 'image')
    : null;

  return {
    type,
    color: normalizeColor(background.color, '#000000'),
    imageId: imageAsset ? imageAsset.id : '',
    imageUrl: imageAsset ? imageAsset.url : '',
    imageFit: ['cover', 'contain', 'stretch'].includes(background.imageFit) ? background.imageFit : 'cover',
    opacity: Math.max(0, Math.min(1, Number(background.opacity ?? 1))),
    blur: Math.max(0, Math.min(24, parseInt(background.blur || 0, 10)))
  };
}

function normalizeLogoOverlay(overlay = {}) {
  const imageAsset = overlay.imageId
    ? mediaLibrary.find((asset) => asset.id === overlay.imageId && asset.type === 'image')
    : null;

  return {
    enabled: overlay.enabled === true && Boolean(imageAsset),
    imageId: imageAsset ? imageAsset.id : '',
    imageUrl: imageAsset ? imageAsset.url : '',
    position: supportedLogoPositions.has(overlay.position) ? overlay.position : 'top-right',
    size: Math.max(40, Math.min(360, parseInt(overlay.size || 140, 10))),
    opacity: Math.max(0.1, Math.min(1, Number(overlay.opacity ?? 1))),
    margin: Math.max(0, Math.min(96, parseInt(overlay.margin || 24, 10)))
  };
}

function getDefaultMediaState() {
  return {
    currentIndex: 0,
    playlist: [],
    zones: [],
    fit: 'contain',
    muted: true,
    layout: 'single',
    ticker: {
      enabled: false,
      showTime: true,
      label: 'Headlines',
      text: '',
      speed: 28,
      schedule: {
        mode: 'permanent',
        start: '08:00',
        end: '18:00'
      },
      styles: {
        barBg: '#030712',
        scrollBg: '#0f172a',
        textColor: '#ffffff',
        timeBg: '#0f172a',
        timeColor: '#93c5fd',
        labelBg: '#2563eb',
        labelColor: '#ffffff'
      }
    },
    background: {
      type: 'color',
      color: '#000000',
      imageId: '',
      imageUrl: '',
      imageFit: 'cover',
      opacity: 1,
      blur: 0
    },
    logoOverlay: {
      enabled: false,
      imageId: '',
      imageUrl: '',
      position: 'top-right',
      size: 140,
      opacity: 1,
      margin: 24
    }
  };
}

function normalizeMediaState(mediaData = {}, previousMedia = getDefaultMediaState()) {
  const playlist = Array.isArray(mediaData.playlist)
    ? mediaData.playlist.map(normalizePlaylistItem).filter(Boolean)
    : (previousMedia.playlist || []).map(normalizePlaylistItem).filter(Boolean);
  const zones = Array.isArray(mediaData.zones)
    ? normalizeZones(mediaData.zones)
    : normalizeZones(previousMedia.zones || []);
  const tickerInput = mediaData.ticker || {};
  const previousTicker = previousMedia.ticker || {};
  const mergedTicker = {
    ...previousTicker,
    ...tickerInput,
    styles: {
      ...(previousTicker.styles || {}),
      ...(tickerInput.styles || {})
    }
  };
  const requestedIndex = Object.prototype.hasOwnProperty.call(mediaData, 'currentIndex')
    ? parseInt(mediaData.currentIndex || 0, 10)
    : (previousMedia.currentIndex || 0);

  return {
    ...previousMedia,
    ...mediaData,
    playlist,
    zones,
    fit: ['contain', 'cover'].includes(mediaData.fit) ? mediaData.fit : (previousMedia.fit || 'contain'),
    muted: Object.prototype.hasOwnProperty.call(mediaData, 'muted') ? mediaData.muted !== false : previousMedia.muted !== false,
    layout: normalizeMediaLayout(mediaData.layout || previousMedia.layout),
    ticker: normalizeTicker(mergedTicker),
    background: normalizeBackground({
      ...(previousMedia.background || {}),
      ...(mediaData.background || {})
    }),
    logoOverlay: normalizeLogoOverlay({
      ...(previousMedia.logoOverlay || {}),
      ...(mediaData.logoOverlay || {})
    }),
    currentIndex: Math.min(
      Math.max(0, requestedIndex),
      Math.max(0, playlist.length - 1)
    )
  };
}

loadMediaLibrary();

// Bible books list
const bibleBooks = [
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy',
  'Joshua', 'Judges', 'Ruth', '1 Samuel', '2 Samuel',
  '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles',
  'Ezra', 'Nehemiah', 'Esther', 'Job', 'Psalms', 'Proverbs',
  'Ecclesiastes', 'Song of Solomon', 'Isaiah', 'Jeremiah',
  'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel',
  'Amos', 'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk',
  'Zephaniah', 'Haggai', 'Zechariah', 'Malachi',
  'Matthew', 'Mark', 'Luke', 'John', 'Acts',
  'Romans', '1 Corinthians', '2 Corinthians', 'Galatians',
  'Ephesians', 'Philippians', 'Colossians', '1 Thessalonians',
  '2 Thessalonians', '1 Timothy', '2 Timothy', 'Titus',
  'Philemon', 'Hebrews', 'James', '1 Peter', '2 Peter',
  '1 John', '2 John', '3 John', 'Jude', 'Revelation'
];

// Chapter counts for each book
const chapterCounts = {
  'Genesis': 50, 'Exodus': 40, 'Leviticus': 27, 'Numbers': 36, 'Deuteronomy': 34,
  'Joshua': 24, 'Judges': 21, 'Ruth': 4, '1 Samuel': 31, '2 Samuel': 24,
  '1 Kings': 22, '2 Kings': 25, '1 Chronicles': 29, '2 Chronicles': 36,
  'Ezra': 10, 'Nehemiah': 13, 'Esther': 10, 'Job': 42, 'Psalms': 150, 'Proverbs': 31,
  'Ecclesiastes': 12, 'Song of Solomon': 8, 'Isaiah': 66, 'Jeremiah': 52,
  'Lamentations': 5, 'Ezekiel': 48, 'Daniel': 12, 'Hosea': 14, 'Joel': 3,
  'Amos': 9, 'Obadiah': 1, 'Jonah': 4, 'Micah': 7, 'Nahum': 3, 'Habakkuk': 3,
  'Zephaniah': 3, 'Haggai': 2, 'Zechariah': 14, 'Malachi': 4,
  'Matthew': 28, 'Mark': 16, 'Luke': 24, 'John': 21, 'Acts': 28,
  'Romans': 16, '1 Corinthians': 16, '2 Corinthians': 13, 'Galatians': 6,
  'Ephesians': 6, 'Philippians': 4, 'Colossians': 4, '1 Thessalonians': 5,
  '2 Thessalonians': 3, '1 Timothy': 6, '2 Timothy': 4, 'Titus': 3,
  'Philemon': 1, 'Hebrews': 13, 'James': 5, '1 Peter': 5, '2 Peter': 3,
  '1 John': 5, '2 John': 1, '3 John': 1, 'Jude': 1, 'Revelation': 22
};

// API endpoint to get books list
app.get('/api/bible/books', (req, res) => {
  res.json(bibleBooks);
});

// API endpoint to get chapters for a book
app.get('/api/bible/chapters/:book', (req, res) => {
  const book = req.params.book;
  const count = chapterCounts[book] || 1;
  res.json({ book, chapters: count });
});

// API endpoint to get verse
app.get('/api/bible/verse/:book/:chapter/:verse', async (req, res) => {
  const { book, chapter, verse } = req.params;
  
  // Try local data first
  if (bibleData[book] && bibleData[book][chapter] && bibleData[book][chapter][verse]) {
    return res.json({
      book,
      chapter,
      verse,
      text: bibleData[book][chapter][verse]
    });
  }
  
  // Fallback to API
  try {
    const apiBook = book.replace(/ /g, '%20');
    const url = `https://bible-api.com/${apiBook}%20${chapter}:${verse}?translation=kjv`;
    
    https.get(url, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.text) {
            res.json({
              book,
              chapter,
              verse,
              text: result.text.trim()
            });
          } else {
            res.status(404).json({ error: 'Verse not found' });
          }
        } catch (e) {
          res.status(500).json({ error: 'Failed to parse response' });
        }
      });
    }).on('error', (e) => {
      res.status(500).json({ error: 'API request failed' });
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch verse' });
  }
});

// API endpoint to get verse range
app.get('/api/bible/verses/:book/:chapter/:verseStart/:verseEnd', async (req, res) => {
  const { book, chapter, verseStart, verseEnd } = req.params;
  
  // Try local data first
  if (bibleData[book] && bibleData[book][chapter]) {
    const verses = [];
    for (let v = parseInt(verseStart); v <= parseInt(verseEnd); v++) {
      if (bibleData[book][chapter][v]) {
        verses.push(`${v}. ${bibleData[book][chapter][v]}`);
      }
    }
    if (verses.length > 0) {
      return res.json({
        book,
        chapter,
        verseStart,
        verseEnd,
        text: verses.join(' ')
      });
    }
  }
  
  // Fallback to API
  try {
    const apiBook = book.replace(/ /g, '%20');
    const url = `https://bible-api.com/${apiBook}%20${chapter}:${verseStart}-${verseEnd}?translation=kjv`;
    
    https.get(url, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.text) {
            res.json({
              book,
              chapter,
              verseStart,
              verseEnd,
              text: result.text.trim()
            });
          } else {
            res.status(404).json({ error: 'Verses not found' });
          }
        } catch (e) {
          res.status(500).json({ error: 'Failed to parse response' });
        }
      });
    }).on('error', (e) => {
      res.status(500).json({ error: 'API request failed' });
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch verses' });
  }
});

// API endpoint to get full chapter
app.get('/api/bible/chapter/:book/:chapter', async (req, res) => {
  const { book, chapter } = req.params;
  
  // Try local data first
  if (bibleData[book] && bibleData[book][chapter]) {
    const verses = Object.entries(bibleData[book][chapter])
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
      .map(([v, text]) => ({ verse: parseInt(v), text }));
    return res.json({ book, chapter, verses });
  }
  
  // Fallback to API
  try {
    const apiBook = book.replace(/ /g, '%20');
    const url = `https://bible-api.com/${apiBook}%20${chapter}?translation=kjv`;
    
    https.get(url, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.verses) {
            res.json({
              book,
              chapter,
              verses: result.verses.map(v => ({ verse: v.verse, text: v.text.trim() }))
            });
          } else {
            res.status(404).json({ error: 'Chapter not found' });
          }
        } catch (e) {
          res.status(500).json({ error: 'Failed to parse response' });
        }
      });
    }).on('error', (e) => {
      res.status(500).json({ error: 'API request failed' });
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch chapter' });
  }
});

app.get('/api/media', (req, res) => {
  res.json(mediaLibrary);
});

app.post('/api/media', upload.single('media'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No media file uploaded' });
  }

  const type = assetTypeFromMime(req.file.mimetype);
  const asset = {
    id: path.parse(req.file.filename).name,
    name: req.body.name || req.file.originalname,
    filename: req.file.filename,
    url: `/media/${encodeURIComponent(req.file.filename)}`,
    type,
    mimeType: req.file.mimetype,
    size: req.file.size,
    duration: type === 'image' ? 10 : 30,
    fit: 'contain',
    createdAt: new Date().toISOString()
  };

  mediaLibrary.push(asset);
  mediaLibrary.sort((a, b) => a.name.localeCompare(b.name));
  saveMediaLibrary();

  io.emit('media-list', mediaLibrary);
  res.status(201).json(asset);
});

app.delete('/api/media/:id', (req, res) => {
  const asset = mediaLibrary.find((media) => media.id === req.params.id);
  if (!asset) {
    return res.status(404).json({ error: 'Media asset not found' });
  }

  mediaLibrary = mediaLibrary.filter((media) => media.id !== req.params.id);
  saveMediaLibrary();

  const filePath = path.join(mediaDir, asset.filename);
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error('Failed to delete media file:', err);
    }
  });

  if (currentState.media && Array.isArray(currentState.media.playlist)) {
    currentState.media.playlist = currentState.media.playlist.filter((item) => item.id !== req.params.id);
    currentState.media.zones = (currentState.media.zones || []).map((item) => (
      item && item.id === req.params.id ? null : item
    ));
    if (currentState.media.background && currentState.media.background.imageId === req.params.id) {
      currentState.media.background = {
        ...currentState.media.background,
        type: 'color',
        imageId: '',
        imageUrl: ''
      };
    }
    if (currentState.media.logoOverlay && currentState.media.logoOverlay.imageId === req.params.id) {
      currentState.media.logoOverlay = {
        ...currentState.media.logoOverlay,
        enabled: false,
        imageId: '',
        imageUrl: ''
      };
    }
    currentState.media.currentIndex = Math.min(
      currentState.media.currentIndex,
      Math.max(0, currentState.media.playlist.length - 1)
    );
    saveDisplayState();
    io.emit('state-update', currentState);
  }

  io.emit('media-list', mediaLibrary);
  res.json({ ok: true });
});

// Current state
let currentState = {
  mode: 'welcome', // 'welcome', 'bible', 'lyrics', 'program', 'media'
  bible: {
    book: '',
    chapter: '',
    verse: '',
    text: ''
  },
  lyrics: {
    title: '',
    currentSlide: 0,
    slides: []
  },
  program: {
    currentIndex: 0,
    events: []
  },
  media: getDefaultMediaState(),
  display: { ...defaultDisplayState }
};

function loadDisplayState() {
  try {
    if (!fs.existsSync(displayStatePath)) {
      saveDisplayState();
      return;
    }

    const savedState = JSON.parse(fs.readFileSync(displayStatePath, 'utf8'));
    currentState.media = normalizeMediaState(savedState.media || {}, currentState.media);
    currentState.display = {
      ...currentState.display,
      ...(savedState.display || {})
    };
    saveDisplayState();
    console.log('Loaded saved display settings');
  } catch (err) {
    console.error('Error loading display settings:', err);
  }
}

function saveDisplayState() {
  try {
    fs.writeFileSync(displayStatePath, JSON.stringify({
      media: currentState.media,
      display: currentState.display
    }, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving display settings:', err);
  }
}

loadDisplayState();

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.data.isAdmin = isAuthenticatedSocket(socket);

  function requireSocketAuth(action) {
    if (socket.data.isAdmin) return true;

    socket.emit('auth-required', { action });
    return false;
  }
  
  // Send current state to newly connected client
  socket.emit('state-update', currentState);
  
  // Handle state updates from control page
  socket.on('update-state', (newState) => {
    if (!requireSocketAuth('update-state')) return;

    currentState = { ...currentState, ...newState };
    io.emit('state-update', currentState);
  });
  
  // Handle Bible verse update
  socket.on('update-bible', (bibleData) => {
    if (!requireSocketAuth('update-bible')) return;

    currentState.mode = 'bible';
    currentState.bible = bibleData;
    io.emit('state-update', currentState);
  });
  
  // Handle lyrics update
  socket.on('update-lyrics', (lyricsData) => {
    if (!requireSocketAuth('update-lyrics')) return;

    currentState.mode = 'lyrics';
    currentState.lyrics = lyricsData;
    io.emit('state-update', currentState);
  });

  // ========== SONG LIBRARY EVENTS ==========
  
  // Send songs list to client
  socket.on('get-songs', () => {
    if (!requireSocketAuth('get-songs')) return;

    socket.emit('songs-list', songsLibrary);
  });

  // Save new song or update existing
  socket.on('save-song', (songData) => {
    if (!requireSocketAuth('save-song')) return;

    const existingIndex = songsLibrary.findIndex(s => s.id === songData.id);
    
    if (existingIndex >= 0) {
      songsLibrary[existingIndex] = songData; // Update
    } else {
      songData.id = songData.id || Date.now().toString();
      songsLibrary.push(songData); // Add new
    }
    
    // Sort alpha by title
    songsLibrary.sort((a, b) => a.title.localeCompare(b.title));
    
    saveSongs();
    io.emit('songs-list', songsLibrary); // Broadcast update to all controls
  });

  // Delete song
  socket.on('delete-song', (songId) => {
    if (!requireSocketAuth('delete-song')) return;

    songsLibrary = songsLibrary.filter(s => s.id !== songId);
    saveSongs();
    io.emit('songs-list', songsLibrary);
  });

  // ========================================

  // ========== SIGNAGE MEDIA EVENTS ==========

  socket.on('get-media', () => {
    if (!requireSocketAuth('get-media')) return;

    socket.emit('media-list', mediaLibrary);
  });

  socket.on('update-media', (mediaData) => {
    if (!requireSocketAuth('update-media')) return;

    currentState.mode = 'media';
    currentState.media = normalizeMediaState(mediaData, currentState.media);
    saveDisplayState();

    io.emit('state-update', currentState);
  });

  socket.on('media-navigate', (direction) => {
    if (!requireSocketAuth('media-navigate')) return;

    const playlist = currentState.media.playlist || [];
    if (playlist.length === 0) return;

    if (direction === 'next') {
      currentState.media.currentIndex = (currentState.media.currentIndex + 1) % playlist.length;
    } else if (direction === 'prev') {
      currentState.media.currentIndex = (currentState.media.currentIndex - 1 + playlist.length) % playlist.length;
    } else if (typeof direction === 'number') {
      currentState.media.currentIndex = Math.max(0, Math.min(direction, playlist.length - 1));
    }

    io.emit('state-update', currentState);
  });

  // ========================================
  
  // Handle next/previous slide for lyrics
  socket.on('lyrics-navigate', (direction) => {
    if (!requireSocketAuth('lyrics-navigate')) return;

    if (direction === 'next' && currentState.lyrics.currentSlide < currentState.lyrics.slides.length - 1) {
      currentState.lyrics.currentSlide++;
    } else if (direction === 'prev' && currentState.lyrics.currentSlide > 0) {
      currentState.lyrics.currentSlide--;
    } else if (typeof direction === 'number') {
      currentState.lyrics.currentSlide = direction;
    }
    io.emit('state-update', currentState);
  });
  
  // Handle program update
  socket.on('update-program', (programData) => {
    if (!requireSocketAuth('update-program')) return;

    currentState.mode = 'program';
    currentState.program = programData;
    io.emit('state-update', currentState);
  });
  
  // Handle program navigation
  socket.on('program-navigate', (direction) => {
    if (!requireSocketAuth('program-navigate')) return;

    if (direction === 'next' && currentState.program.currentIndex < currentState.program.events.length - 1) {
      currentState.program.currentIndex++;
    } else if (direction === 'prev' && currentState.program.currentIndex > 0) {
      currentState.program.currentIndex--;
    } else if (typeof direction === 'number') {
      currentState.program.currentIndex = direction;
    }
    io.emit('state-update', currentState);
  });
  
  // Handle display settings
  socket.on('update-display', (displayData) => {
    if (!requireSocketAuth('update-display')) return;

    currentState.display = { ...currentState.display, ...displayData };
    saveDisplayState();
    io.emit('state-update', currentState);
  });
  
  // Handle mode change
  socket.on('change-mode', (mode) => {
    if (!requireSocketAuth('change-mode')) return;

    currentState.mode = mode;
    io.emit('state-update', currentState);
  });
  
  // Handle clear display
  socket.on('clear-display', () => {
    if (!requireSocketAuth('clear-display')) return;

    currentState.mode = 'welcome';
    io.emit('state-update', currentState);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Display page: http://localhost:${PORT}/display.html`);
  console.log(`Control page: http://localhost:${PORT}/control.html`);
});
