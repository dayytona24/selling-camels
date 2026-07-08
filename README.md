# HQ Ranch — Camel Marketplace

Express API + minimal frontend for the HQ Ranch camel marketplace, backed by
**Supabase (Postgres)**. Deploys to **Railway**.

- Public browse page (`/`) lists **active** camels.
- Admin CRUD (`/api/admin/camels`) is protected by HTTP Basic auth.
- Images upload via `multer` to an on-disk `uploads/` directory (a Railway
  **volume** in production). We are intentionally **not** using Supabase Storage.

## Architecture

| Piece | File |
|-------|------|
| Supabase client (service role, fail-fast env) | [`lib/supabase.js`](lib/supabase.js) |
| Express server + all routes | [`server.js`](server.js) |
| House-seller seeding (one-off) | [`scripts/seed-house-seller.js`](scripts/seed-house-seller.js) |
| End-to-end smoke test | [`scripts/smoke-test.js`](scripts/smoke-test.js) |
| Public browse page | [`public/index.html`](public/index.html) |

The server uses the Supabase **service-role key**, which bypasses Row Level
Security — appropriate because admin writes are gated by Basic auth at the app
layer. The key is read from the environment and must never be hardcoded or sent
to the browser.

### Data model (already live — do not re-run DDL)

`camels` (uuid PK) with `seller_id` → `profiles.id`, plus child rows in
`camel_images` (`url`, `sort_order`). The old `additional_images` JSON array is
represented as `camel_images` rows. Field mapping from the legacy app:

| Legacy | Now |
|--------|-----|
| `type` | `breed` (`Dromedary` \| `Bactrian` \| `Hybrid`) |
| `additional_images` (JSON) | `camel_images` rows |
| — (new) | `sex` (`male` \| `female`) |
| — (new) | `age_years` (0–60, nullable) |
| — (new) | `price_cad` (≥ 0) |
| — (new) | `status` (`draft` \| `active` \| `pending_sale` \| `sold` \| `withdrawn`) |
| — (new) | `seller_id` (NOT NULL → the house profile) |

## Environment variables

Set these in Railway (or a local `.env` — copy from
[`.env.example`](.env.example), which lists **names only**):

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Project URL, `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (server-side only, bypasses RLS) |
| `DATABASE_URL` | Session-pooler Postgres URL (for migrations/tooling) |
| `HOUSE_SELLER_ID` | `profiles.id` that owns every listing (from the seed script) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | HTTP Basic credentials for `/api/admin/*` |
| `PORT` | Listen port (Railway injects this) |
| `HOUSE_SELLER_EMAIL` / `HOUSE_SELLER_DISPLAY_NAME` / `HOUSE_SELLER_PHONE` | Optional seed-script overrides |

> **Never commit real keys.** `.env` is gitignored.

## Setup

```bash
npm install

# 1. Create the "house" seller (auth user + profile). Prints HOUSE_SELLER_ID.
npm run seed:house-seller
#    -> copy the printed HOUSE_SELLER_ID into your env / Railway variables

# 2. Boot the server
npm start
```

On Railway: add the environment variables above, attach a **volume mounted at
`/app/uploads`** so uploaded images survive deploys, and use `npm start` as the
start command.

## API

All responses use the camelCase `camelFromRecord` shape:

```jsonc
{
  "id": "uuid",
  "name": "Sahara",
  "breed": "Dromedary",
  "type": "Dromedary",          // legacy alias of breed
  "sex": "female",
  "ageYears": 4,
  "priceCad": 12500,
  "status": "active",
  "mainImage": "/uploads/....jpg",
  "additionalImages": ["/uploads/a.jpg", "/uploads/b.jpg"],
  "shortDescription": "...",
  "longDescription": "...",
  "createdAt": "2026-07-08T...",
  "updatedAt": "2026-07-08T..."
}
```

| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/camels` | public | **active** listings only |
| `GET /api/admin/camels` | Basic | all statuses |
| `GET /api/admin/camels/:id` | Basic | single, any status |
| `POST /api/admin/camels` | Basic | create; JSON or `multipart/form-data` |
| `PUT /api/admin/camels/:id` | Basic | partial update; only sent fields change |
| `DELETE /api/admin/camels/:id` | Basic | removes camel + its images |

Create/update accept either JSON (image fields as URL strings) or
`multipart/form-data` with file fields `mainImage` (1) and `additionalImages`
(many). On update, `camel_images` are replaced (delete + reinsert) only if the
request includes image data; `sort_order` follows array order.

## Verification / smoke test

**Fail-fast check** (missing env → clear error, non-zero exit):

```bash
# no SUPABASE_* set -> exits immediately with an explanatory message
npm start
```

**Boots with stub env** (fake URL): the server starts and listens; data calls
return graceful `500`s rather than crashing:

```bash
SUPABASE_URL=https://stub.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=stub-key \
HOUSE_SELLER_ID=00000000-0000-0000-0000-000000000000 \
ADMIN_USER=admin ADMIN_PASSWORD=secret \
npm start
```

**Automated 5-route smoke test** (needs a real project + seeded house seller,
server running):

```bash
BASE_URL=http://localhost:3000 ADMIN_USER=admin ADMIN_PASSWORD=secret npm run smoke
```

### Manual curl checklist

```bash
BASE=http://localhost:3000
AUTH='-u admin:secret'

# 1. Public list (active only)
curl -s $BASE/api/camels | jq

# 2. Admin list is gated (expect 401 without auth, 200 with)
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/admin/camels          # 401
curl -s $AUTH $BASE/api/admin/camels | jq                                # 200

# 3. Create (draft)
curl -s $AUTH -H 'Content-Type: application/json' -X POST $BASE/api/admin/camels \
  -d '{"name":"Sahara","breed":"Dromedary","sex":"female","ageYears":4,
       "priceCad":12500,"status":"draft","shortDescription":"Gentle",
       "longDescription":"A calm, halter-trained dromedary.",
       "additionalImages":["/uploads/a.jpg"]}' | jq

# 4. Activate it (partial update) — replace :id
curl -s $AUTH -H 'Content-Type: application/json' -X PUT $BASE/api/admin/camels/<id> \
  -d '{"status":"active"}' | jq

# 5. Delete — replace :id
curl -s $AUTH -X DELETE $BASE/api/admin/camels/<id> | jq
```

## Notes

- No SQLite anywhere — this project was built directly against Supabase. (The
  originally-scoped `migrate-sqlite-to-supabase.js` was skipped because there
  was no source SQLite database to migrate.)
- The Supabase schema is managed separately; this app never runs DDL.
