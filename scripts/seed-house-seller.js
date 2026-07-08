// One-off: create the "house" seller for HQ Ranch.
//
// camels.seller_id is NOT NULL and references profiles.id, which in turn
// references auth.users.id. So the server needs a real auth user + profile to
// attribute every listing to. This script creates that user via the admin API,
// ensures a matching profiles row exists, and prints the profile id.
//
// Copy the printed id into your environment as HOUSE_SELLER_ID.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:house-seller
//
// Optional overrides:
//   HOUSE_SELLER_EMAIL         (default: house@hq-ranch.example)
//   HOUSE_SELLER_DISPLAY_NAME  (default: HQ Ranch)
//   HOUSE_SELLER_PHONE         (optional)
//
// Idempotent: re-running finds the existing auth user by email instead of
// failing, and upserts the profile.

import 'dotenv/config';
import crypto from 'node:crypto';
import { getSupabase } from '../lib/supabase.js';

const EMAIL = (process.env.HOUSE_SELLER_EMAIL || 'house@hq-ranch.example').trim().toLowerCase();
const DISPLAY_NAME = (process.env.HOUSE_SELLER_DISPLAY_NAME || 'HQ Ranch').trim();
const PHONE = process.env.HOUSE_SELLER_PHONE ? process.env.HOUSE_SELLER_PHONE.trim() : null;

const supabase = getSupabase();

async function findExistingUserByEmail(email) {
  // Page through admin users until we find a match (small user base expected).
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const match = data.users.find((u) => (u.email || '').toLowerCase() === email);
    if (match) return match;
    if (data.users.length < perPage) break; // last page
  }
  return null;
}

async function ensureAuthUser() {
  const { data, error } = await supabase.auth.admin.createUser({
    email: EMAIL,
    // Throwaway password: the house seller never logs in interactively; the
    // server acts on its behalf with the service-role key. Not printed.
    password: crypto.randomBytes(24).toString('base64url'),
    email_confirm: true,
    user_metadata: { role: 'house_seller', display_name: DISPLAY_NAME },
  });

  if (!error) {
    console.log(`Created auth user for ${EMAIL}`);
    return data.user;
  }

  // Already exists -> look it up and reuse it (idempotent re-run).
  const alreadyExists =
    /already|registered|exists|duplicate/i.test(error.message || '') || error.status === 422;
  if (alreadyExists) {
    const existing = await findExistingUserByEmail(EMAIL);
    if (existing) {
      console.log(`Reusing existing auth user for ${EMAIL}`);
      return existing;
    }
  }
  throw error;
}

async function ensureProfile(userId) {
  // A DB trigger may already create a profile on user signup; upsert makes this
  // safe either way. display_name is NOT NULL.
  const { data, error } = await supabase
    .from('profiles')
    .upsert(
      { id: userId, display_name: DISPLAY_NAME, email: EMAIL, phone: PHONE },
      { onConflict: 'id' }
    )
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function main() {
  const user = await ensureAuthUser();
  const profileId = await ensureProfile(user.id);

  console.log('\nHQ Ranch house seller is ready.');
  console.log('----------------------------------------------------------------');
  console.log('Set this in your environment (Railway variables / .env):\n');
  console.log(`HOUSE_SELLER_ID=${profileId}`);
  console.log('----------------------------------------------------------------');
}

main().catch((err) => {
  console.error('Failed to seed house seller:', err.message || err);
  process.exit(1);
});
