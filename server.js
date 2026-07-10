// HQ Ranch camel marketplace — Express server backed by Supabase (Postgres).
//
// Data access goes through the Supabase JS client (service-role key, RLS
// bypassed) built in lib/supabase.js. Image uploads are buffered in memory and
// streamed to a PUBLIC Supabase Storage bucket (see lib/storage.js) so the
// resulting absolute URLs resolve from every deploy target (GitHub Pages,
// Railway, direct Supabase reads) — we no longer write to local disk.
//
// Public JSON (camelCase, read directly by the static sites too):
//   GET    /api/camels              public  — active listings only
//   GET    /api/gallery             public  — all gallery photos
//
// Basic-auth JSON API (ADMIN_USER / ADMIN_PASSWORD):
//   GET    /api/admin/camels        admin   — all statuses
//   GET    /api/admin/camels/:id    admin
//   POST   /api/admin/camels        admin   — create
//   PUT    /api/admin/camels/:id    admin   — update
//   DELETE /api/admin/camels/:id    admin   — delete
//
// Browser admin console (session-cookie auth + CSRF, separate from the above):
//   GET/POST /admin/login        public  — password form (ADMIN_PASSWORD, rate-limited)
//   GET      /admin              session — the admin console SPA
//   GET      /admin/logout       session — clears the session + CSRF cookies
//   GET/POST/PUT/DELETE /admin/api/camels[/:id]   session + CSRF — listings CRUD (JSON)
//   GET/POST/DELETE     /admin/api/gallery[/:id]  session + CSRF — gallery manager (JSON)
//   POST     /admin/camels       session + CSRF — legacy full-page create (kept for compat)

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { getSupabase, getHouseSellerId } from './lib/supabase.js';
import {
  imageFileFilter,
  uploadImage,
  uploadImages,
  deleteManyByPublicUrl,
  MAX_FILE_BYTES,
} from './lib/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const VIEWS_DIR = path.join(__dirname, 'views');

// Allowed values mirror the DB CHECK constraints so we can return friendly
// 400s instead of opaque Postgres constraint-violation errors.
const BREEDS = ['Dromedary', 'Bactrian', 'Hybrid'];
const SEXES = ['male', 'female'];
const PAINT_COLORS = ['Paint', 'Chocolate', 'White'];

// --- Supabase client + house seller resolved once at boot (fail fast) --------
// Touch the client and the house seller id up front so a misconfigured
// environment crashes on startup with a clear message rather than on first use.
const supabase = getSupabase();
const HOUSE_SELLER_ID = getHouseSellerId();

// --- Uploads ----------------------------------------------------------------
// Files are buffered in memory (never written to local disk) and streamed to
// Supabase Storage — see lib/storage.js for why. The MIME allowlist + size cap
// are enforced here at the multer layer and again in the storage helper.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: imageFileFilter,
});
// Admin create/update accept an optional single main image + many extra images.
const uploadFields = upload.fields([
  { name: 'mainImage', maxCount: 1 },
  { name: 'additionalImages', maxCount: 20 },
]);
// Gallery accepts a batch of photos under a single field.
const uploadGallery = upload.array('photos', 30);

// --- App --------------------------------------------------------------------
const app = express();
// Railway terminates TLS at its edge and proxies HTTP to this process. Trust
// its single reverse-proxy hop so req.secure/req.ip reflect the real client
// (X-Forwarded-Proto/-For) instead of the internal HTTP connection — needed
// for correct `secure` cookies and per-IP login rate limiting.
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// --- Basic auth for /api/admin ----------------------------------------------
function requireAdmin(req, res, next) {
  const expectedUser = process.env.ADMIN_USER;
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedUser || !expectedPass) {
    return res
      .status(500)
      .json({ error: 'Admin credentials are not configured on the server.' });
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="HQ Ranch Admin"');
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const [user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
  if (!timingSafeEqual(user, expectedUser) || !timingSafeEqual(pass, expectedPass)) {
    res.set('WWW-Authenticate', 'Basic realm="HQ Ranch Admin"');
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  return next();
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// --- Session cookie auth for the browser-facing /admin/* pages --------------
// Separate from the Basic-auth-gated /api/admin/* JSON API above. Signs a
// short-lived expiry timestamp with HMAC-SHA256 rather than pulling in
// express-session — the only state is "was this issued by us and not yet
// expired", so a signed cookie is sufficient and avoids a new dependency.
// The signing key is derived from ADMIN_PASSWORD so no extra secret needs to
// be configured.
const SESSION_COOKIE = 'hq_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function sessionSigningKey() {
  const pass = process.env.ADMIN_PASSWORD || '';
  return crypto.createHash('sha256').update(`hq-admin-session:${pass}`).digest();
}

function createSessionCookieValue() {
  const expires = Date.now() + SESSION_TTL_MS;
  const sig = crypto.createHmac('sha256', sessionSigningKey()).update(String(expires)).digest('hex');
  return `${expires}.${sig}`;
}

function verifySessionCookieValue(value) {
  if (!value || typeof value !== 'string') return false;
  const [expiresStr, sig] = value.split('.');
  if (!expiresStr || !sig) return false;

  const expected = crypto.createHmac('sha256', sessionSigningKey()).update(expiresStr).digest('hex');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;

  const expires = Number(expiresStr);
  return Number.isFinite(expires) && expires > Date.now();
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function requireAdminSession(req, res, next) {
  const cookies = parseCookies(req);
  if (verifySessionCookieValue(cookies[SESSION_COOKIE])) return next();
  return res.redirect('/admin/login');
}

// Shared cookie attributes for both the session and CSRF cookies. `secure` is
// derived from the actual request (via `trust proxy`, see below) rather than
// NODE_ENV — Railway terminates TLS at its edge and forwards HTTP internally,
// so a NODE_ENV-gated flag silently drops `secure` if that var is ever unset.
// req.secure reflects X-Forwarded-Proto instead, so it's correct regardless.
function sessionCookieOptions(req, { httpOnly }) {
  return {
    httpOnly,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

// --- CSRF (double-submit cookie) for POST /admin/camels ---------------------
// Cookie-based session auth means the browser attaches the session cookie
// automatically to any POST to this origin, including one triggered by a
// form on another site — SameSite=Lax blocks that in modern browsers but not
// universally, so we also require a token that a cross-site page can't read.
// Issued alongside the session cookie at login; NOT httpOnly, since the
// static admin.html page needs to read it via JS and echo it back as a
// hidden form field.
const CSRF_COOKIE = 'hq_admin_csrf';

// Accepts the echoed token either as a form field (classic form POST) or as an
// X-CSRF-Token header (fetch-based JSON/multipart calls from the admin console).
// A cross-site page can neither read the cookie to forge the field nor set a
// custom request header cross-origin, so the double-submit guarantee holds for
// both. `json` controls whether a failure is a JSON 403 or a redirect.
function csrfTokenFromRequest(req) {
  if (req.body && typeof req.body.csrfToken === 'string' && req.body.csrfToken) {
    return req.body.csrfToken;
  }
  const header = req.get('x-csrf-token');
  return typeof header === 'string' ? header : '';
}

function checkCsrf(req) {
  const cookieToken = parseCookies(req)[CSRF_COOKIE];
  const submitted = csrfTokenFromRequest(req);
  return Boolean(cookieToken && submitted && timingSafeEqual(cookieToken, submitted));
}

function requireCsrf(req, res, next) {
  if (checkCsrf(req)) return next();
  return res.redirect(`/admin?error=${encodeURIComponent('Your session expired. Please reload the page and try again.')}`);
}

function requireCsrfJson(req, res, next) {
  if (checkCsrf(req)) return next();
  return res.status(403).json({ error: 'Invalid or missing CSRF token. Reload the page and try again.' });
}

// --- Login rate limiting -----------------------------------------------------
// In-memory per-IP fixed window — fine for a single small Railway instance;
// resets on restart and isn't shared across replicas, which is an accepted
// tradeoff for a small internal tool rather than pulling in a store/dependency.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map(); // ip -> { count, windowStart }

function isLoginRateLimited(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.windowStart > LOGIN_WINDOW_MS) return false;
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}

function recordLoginSuccess(ip) {
  loginAttempts.delete(ip);
}

// --- Serialization ----------------------------------------------------------
// Convert a DB camel row (+ joined camel_images) into the camelCase response
// shape the frontend expects. New fields are added additively; `type` is kept
// as an alias of `breed` for backward compatibility with the old contract.
function camelFromRecord(row) {
  const images = Array.isArray(row.camel_images) ? [...row.camel_images] : [];
  images.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  return {
    id: row.id,
    name: row.name,
    breed: row.breed,
    type: row.breed, // legacy alias
    sex: row.sex,
    paintColor: row.paint_color ?? null,
    ageYears: row.age_years === null || row.age_years === undefined ? null : Number(row.age_years),
    mainImage: row.main_image ?? null,
    additionalImages: images.map((img) => img.url),
    shortDescription: row.short_description,
    longDescription: row.long_description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_WITH_IMAGES = '*, camel_images(url, sort_order)';

// --- Input parsing ----------------------------------------------------------
function firstFile(files, field) {
  return files && files[field] && files[field][0] ? files[field][0] : null;
}

// Resolve the list of additional image URLs from a request. Any URLs passed in
// the body (e.g. existing images to keep on update) are preserved; newly
// uploaded files are streamed to Supabase Storage and their absolute public
// URLs are appended after them. Async because it performs the uploads.
async function resolveAdditionalImages(body, files) {
  const urls = [];

  const raw = body.additionalImages;
  if (raw !== undefined && raw !== null) {
    let parsed = raw;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('[')) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          parsed = [trimmed];
        }
      } else if (trimmed.length > 0) {
        parsed = [trimmed];
      } else {
        parsed = [];
      }
    }
    if (Array.isArray(parsed)) {
      for (const v of parsed) {
        if (typeof v === 'string' && v.trim()) urls.push(v.trim());
      }
    }
  }

  const uploaded = (files && files.additionalImages) || [];
  const newUrls = await uploadImages(supabase, uploaded, 'camels');
  for (const url of newUrls) urls.push(url);

  return urls;
}

async function resolveMainImage(body, files) {
  const file = firstFile(files, 'mainImage');
  if (file) return uploadImage(supabase, file, 'camels');
  if (typeof body.mainImage === 'string' && body.mainImage.trim()) return body.mainImage.trim();
  return undefined; // undefined => "not provided", null would mean "clear it"
}

function toNumberOrError(value, label) {
  const n = Number(value);
  if (Number.isNaN(n)) return { error: `${label} must be a number.` };
  return { value: n };
}

// Build the DB record for a create/update. `partial` allows PUT to touch only
// the fields that were actually sent. Returns { record, error }.
function buildCamelRecord(body, { partial }) {
  const record = {};
  const errors = [];
  const has = (k) => body[k] !== undefined && body[k] !== null && body[k] !== '';

  // breed accepts new `breed` or legacy `type`.
  const breedValue = has('breed') ? body.breed : has('type') ? body.type : undefined;
  if (breedValue !== undefined) {
    if (!BREEDS.includes(breedValue)) errors.push(`breed must be one of: ${BREEDS.join(', ')}.`);
    else record.breed = breedValue;
  } else if (!partial) {
    errors.push('breed is required.');
  }

  if (has('name')) record.name = String(body.name);
  else if (!partial) errors.push('name is required.');

  if (has('sex')) {
    if (!SEXES.includes(body.sex)) errors.push(`sex must be one of: ${SEXES.join(', ')}.`);
    else record.sex = body.sex;
  } else if (!partial) {
    errors.push('sex is required.');
  }

  if (has('shortDescription')) record.short_description = String(body.shortDescription);
  else if (!partial) errors.push('shortDescription is required.');

  if (has('longDescription')) record.long_description = String(body.longDescription);
  else if (!partial) errors.push('longDescription is required.');

  // Optional fields.
  if (has('ageYears')) {
    const r = toNumberOrError(body.ageYears, 'ageYears');
    if (r.error) errors.push(r.error);
    else if (r.value < 0 || r.value >= 60) errors.push('ageYears must be >= 0 and < 60.');
    else record.age_years = r.value;
  } else if (body.ageYears === null || body.ageYears === '') {
    record.age_years = null;
  }

  // Paint color is optional; an empty submission clears it.
  if (has('paintColor')) {
    if (!PAINT_COLORS.includes(body.paintColor)) errors.push(`paintColor must be one of: ${PAINT_COLORS.join(', ')}.`);
    else record.paint_color = body.paintColor;
  } else if (body.paintColor === null || body.paintColor === '') {
    record.paint_color = null;
  }

  if (errors.length > 0) return { error: errors.join(' ') };
  return { record };
}

// Replace the camel_images rows for a camel with the given ordered URLs.
async function replaceCamelImages(camelId, urls) {
  const { error: delErr } = await supabase.from('camel_images').delete().eq('camel_id', camelId);
  if (delErr) throw delErr;
  if (!urls || urls.length === 0) return;

  const rows = urls.map((url, i) => ({ camel_id: camelId, url, sort_order: i }));
  const { error: insErr } = await supabase.from('camel_images').insert(rows);
  if (insErr) throw insErr;
}

function asyncHandler(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`[${req.method} ${req.originalUrl}]`, err);
    res.status(500).json({ error: 'Internal server error.', detail: err.message });
  });
}

// --- Routes -----------------------------------------------------------------

app.get('/health', (_req, res) => res.json({ ok: true }));

// Public: active listings only.
app.get('/api/camels', asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('camels')
    .select(SELECT_WITH_IMAGES)
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) throw error;
  res.json(data.map(camelFromRecord));
}));

// --- Gallery serialization + reads ------------------------------------------
function galleryFromRecord(row) {
  return {
    id: row.id,
    photoUrl: row.photo_url,
    caption: row.caption ?? null,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at,
  };
}

async function listGalleryPhotos() {
  const { data, error } = await supabase
    .from('gallery_photos')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(galleryFromRecord);
}

// Public: all gallery photos. (The static sites read Supabase directly via the
// anon key; this mirror endpoint exists for parity with /api/camels.)
app.get('/api/gallery', asyncHandler(async (_req, res) => {
  res.json(await listGalleryPhotos());
}));

// Admin: list all statuses.
app.get('/api/admin/camels', requireAdmin, asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('camels')
    .select(SELECT_WITH_IMAGES)
    .order('created_at', { ascending: false });
  if (error) throw error;
  res.json(data.map(camelFromRecord));
}));

// Admin: single record (any status).
app.get('/api/admin/camels/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('camels')
    .select(SELECT_WITH_IMAGES)
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Camel not found.' });
  res.json(camelFromRecord(data));
}));

// Shared create logic for both the JSON API (POST /api/admin/camels) and the
// browser form (POST /admin/camels) — one code path writes to `camels`.
async function createCamelFromRequest(body, files) {
  const { record, error } = buildCamelRecord(body, { partial: false });
  if (error) return { error };

  const mainImage = await resolveMainImage(body, files);
  if (mainImage !== undefined) record.main_image = mainImage;
  record.seller_id = HOUSE_SELLER_ID;

  const { data, error: insErr } = await supabase
    .from('camels')
    .insert(record)
    .select('id')
    .single();
  if (insErr) return { error: insErr.message };

  const additional = await resolveAdditionalImages(body, files);
  await replaceCamelImages(data.id, additional);

  const { data: full, error: readErr } = await supabase
    .from('camels')
    .select(SELECT_WITH_IMAGES)
    .eq('id', data.id)
    .single();
  if (readErr) throw readErr;
  return { camel: camelFromRecord(full) };
}

// Admin: create.
app.post('/api/admin/camels', requireAdmin, uploadFields, asyncHandler(async (req, res) => {
  const { camel, error } = await createCamelFromRequest(req.body, req.files);
  if (error) return res.status(400).json({ error });
  res.status(201).json(camel);
}));

// Shared update logic (partial — only provided fields change) for both the
// Basic-auth API and the session admin console. Returns { camel } | { error } |
// { notFound }.
async function updateCamelFromRequest(id, body, files) {
  const { record, error } = buildCamelRecord(body, { partial: true });
  if (error) return { error };

  const mainImage = await resolveMainImage(body, files);
  if (mainImage !== undefined) record.main_image = mainImage;
  record.updated_at = new Date().toISOString();

  const { data: updated, error: updErr } = await supabase
    .from('camels')
    .update(record)
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (updErr) return { error: updErr.message };
  if (!updated) return { notFound: true };

  // Only touch images if the request actually carried image info.
  const sentImages =
    body.additionalImages !== undefined ||
    (files && files.additionalImages && files.additionalImages.length > 0);
  if (sentImages) {
    await replaceCamelImages(id, await resolveAdditionalImages(body, files));
  }

  const { data: full, error: readErr } = await supabase
    .from('camels')
    .select(SELECT_WITH_IMAGES)
    .eq('id', id)
    .single();
  if (readErr) throw readErr;
  return { camel: camelFromRecord(full) };
}

// Admin: update (partial — only provided fields change).
app.put('/api/admin/camels/:id', requireAdmin, uploadFields, asyncHandler(async (req, res) => {
  const result = await updateCamelFromRequest(req.params.id, req.body, req.files);
  if (result.error) return res.status(400).json({ error: result.error });
  if (result.notFound) return res.status(404).json({ error: 'Camel not found.' });
  res.json(result.camel);
}));

// Shared delete logic: remove child images (FK) + the camel, then best-effort
// clean up the associated Storage objects. Returns { ok } or { notFound }.
async function deleteCamelById(id) {
  // Gather the object URLs first so we can clean Storage after the DB rows go.
  const { data: full } = await supabase
    .from('camels')
    .select('main_image, camel_images(url)')
    .eq('id', id)
    .maybeSingle();

  const { error: imgErr } = await supabase.from('camel_images').delete().eq('camel_id', id);
  if (imgErr) throw imgErr;

  const { data, error } = await supabase
    .from('camels')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) return { notFound: true };

  if (full) {
    const urls = [full.main_image, ...((full.camel_images || []).map((i) => i.url))].filter(Boolean);
    await deleteManyByPublicUrl(supabase, urls);
  }
  return { ok: true };
}

// Admin: delete.
app.delete('/api/admin/camels/:id', requireAdmin, asyncHandler(async (req, res) => {
  const result = await deleteCamelById(req.params.id);
  if (result.notFound) return res.status(404).json({ error: 'Camel not found.' });
  res.json({ ok: true, id: req.params.id });
}));

// --- Browser-facing admin pages (session-cookie auth, separate from the ------
// --- Basic-auth JSON API above) ----------------------------------------------

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'admin-login.html'));
});

app.post('/admin/login', (req, res) => {
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedPass) {
    return res.status(500).send('Admin credentials are not configured on the server.');
  }

  if (isLoginRateLimited(req.ip)) {
    return res.redirect('/admin/login?error=ratelimited');
  }

  const submitted = typeof req.body.password === 'string' ? req.body.password : '';
  if (!timingSafeEqual(submitted, expectedPass)) {
    recordLoginFailure(req.ip);
    return res.redirect('/admin/login?error=1');
  }
  recordLoginSuccess(req.ip);

  res.cookie(SESSION_COOKIE, createSessionCookieValue(), sessionCookieOptions(req, { httpOnly: true }));
  res.cookie(CSRF_COOKIE, crypto.randomBytes(32).toString('hex'), sessionCookieOptions(req, { httpOnly: false }));
  res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
  res.redirect('/admin/login');
});

app.get('/admin', requireAdminSession, (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'admin.html'));
});

app.post('/admin/camels', requireAdminSession, uploadFields, requireCsrf, asyncHandler(async (req, res) => {
  const { error } = await createCamelFromRequest(req.body, req.files);
  if (error) return res.redirect(`/admin?error=${encodeURIComponent(error)}`);
  res.redirect('/admin?success=1');
}));

// --- Session admin JSON API (the admin console fetches these) ----------------
// Same session-cookie gate as the pages above, plus CSRF on every mutation.
// Returns JSON (no redirects) so the SPA-style admin can add/edit/delete without
// a page reload. Distinct from the Basic-auth /api/admin/* API.

app.get('/admin/api/camels', requireAdminSession, asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('camels')
    .select(SELECT_WITH_IMAGES)
    .order('created_at', { ascending: false });
  if (error) throw error;
  res.json(data.map(camelFromRecord));
}));

app.post('/admin/api/camels', requireAdminSession, uploadFields, requireCsrfJson, asyncHandler(async (req, res) => {
  const { camel, error } = await createCamelFromRequest(req.body, req.files);
  if (error) return res.status(400).json({ error });
  res.status(201).json(camel);
}));

app.put('/admin/api/camels/:id', requireAdminSession, uploadFields, requireCsrfJson, asyncHandler(async (req, res) => {
  const result = await updateCamelFromRequest(req.params.id, req.body, req.files);
  if (result.error) return res.status(400).json({ error: result.error });
  if (result.notFound) return res.status(404).json({ error: 'Camel not found.' });
  res.json(result.camel);
}));

app.delete('/admin/api/camels/:id', requireAdminSession, requireCsrfJson, asyncHandler(async (req, res) => {
  const result = await deleteCamelById(req.params.id);
  if (result.notFound) return res.status(404).json({ error: 'Camel not found.' });
  res.json({ ok: true, id: req.params.id });
}));

app.get('/admin/api/gallery', requireAdminSession, asyncHandler(async (_req, res) => {
  res.json(await listGalleryPhotos());
}));

// Upload one or more gallery photos. They appear on the public gallery
// immediately (no separate publish step). New photos sort after existing ones.
app.post('/admin/api/gallery', requireAdminSession, uploadGallery, requireCsrfJson, asyncHandler(async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'Select at least one photo to upload.' });

  const { data: maxRow } = await supabase
    .from('gallery_photos')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  let next = (maxRow && Number.isFinite(maxRow.sort_order) ? maxRow.sort_order : 0) + 1;

  const urls = await uploadImages(supabase, files, 'gallery');
  const caption = typeof req.body.caption === 'string' && req.body.caption.trim()
    ? req.body.caption.trim()
    : null;
  const rows = urls.map((url) => ({ photo_url: url, caption, sort_order: next++ }));

  const { data, error } = await supabase.from('gallery_photos').insert(rows).select('*');
  if (error) {
    await deleteManyByPublicUrl(supabase, urls); // roll back orphaned objects
    return res.status(400).json({ error: error.message });
  }
  res.status(201).json(data.map(galleryFromRecord));
}));

app.delete('/admin/api/gallery/:id', requireAdminSession, requireCsrfJson, asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('gallery_photos')
    .delete()
    .eq('id', req.params.id)
    .select('photo_url')
    .maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Photo not found.' });
  await deleteManyByPublicUrl(supabase, [data.photo_url]);
  res.json({ ok: true, id: req.params.id });
}));

// Upload error surfacing. Covers both multer's own errors (e.g. file too large)
// and the plain Error our fileFilter throws for a disallowed MIME type.
app.use((err, req, res, next) => {
  const isUpload =
    err instanceof multer.MulterError ||
    (err instanceof Error && /Unsupported file type/.test(err.message));
  if (!isUpload) return next(err);

  const message = `Upload error: ${err.message}`;
  // The legacy full-page form redirects; everything else (JSON APIs) gets JSON.
  if (req.path === '/admin/camels') {
    return res.redirect(`/admin?error=${encodeURIComponent(message)}`);
  }
  return res.status(400).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`HQ Ranch server listening on http://localhost:${PORT}`);
});
