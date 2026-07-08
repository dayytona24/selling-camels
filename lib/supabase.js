// Supabase client for the HQ Ranch server.
//
// The server talks to Postgres through the Supabase JS client using the
// SERVICE ROLE key, which bypasses Row Level Security. This key must NEVER be
// exposed to the browser and must only ever come from the environment — never
// hardcode it.
//
// We fail fast at boot: if the required env vars are missing the process exits
// with a clear message instead of limping along and throwing opaque errors on
// the first request.

import { createClient } from '@supabase/supabase-js';

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

function readEnvOrThrow() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name] || !process.env[name].trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required Supabase environment variable(s): ${missing.join(', ')}.\n` +
        `Set them in your environment (see .env.example). The server needs the ` +
        `service-role key so it can bypass RLS for admin writes.`
    );
  }
  return {
    url: process.env.SUPABASE_URL.trim(),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  };
}

let cachedClient = null;

/**
 * Returns a singleton service-role Supabase client.
 * Throws (fails fast) if the required env vars are absent.
 */
export function getSupabase() {
  if (cachedClient) return cachedClient;

  const { url, serviceRoleKey } = readEnvOrThrow();

  cachedClient = createClient(url, serviceRoleKey, {
    auth: {
      // Server-side, stateless: no session persistence or token refresh.
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return cachedClient;
}

/**
 * The profile id that owns every listing this server creates.
 * camels.seller_id is NOT NULL, so the server must always have a valid
 * "house" profile to attribute listings to. Create it with
 * `npm run seed:house-seller` and copy the printed id into HOUSE_SELLER_ID.
 */
export function getHouseSellerId() {
  const id = process.env.HOUSE_SELLER_ID && process.env.HOUSE_SELLER_ID.trim();
  if (!id) {
    throw new Error(
      'Missing required environment variable HOUSE_SELLER_ID.\n' +
        'Run `npm run seed:house-seller` to create the HQ Ranch house profile, ' +
        'then set HOUSE_SELLER_ID to the printed profile id.'
    );
  }
  return id;
}
