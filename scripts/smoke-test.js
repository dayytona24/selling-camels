// Quick end-to-end smoke test for the 5 API routes.
//
// Requires a RUNNING server pointed at a REAL Supabase project with the house
// seller seeded (HOUSE_SELLER_ID set). It exercises the full lifecycle:
//   public list -> admin auth gate -> create -> activate -> public visibility
//   -> update -> delete -> gone.
//
// Usage:
//   BASE_URL=http://localhost:3000 ADMIN_USER=... ADMIN_PASSWORD=... \
//     npm run smoke
//
// It creates a throwaway listing named "SMOKE TEST …" and deletes it at the end.

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_USER || !ADMIN_PASSWORD) {
  console.error('Set ADMIN_USER and ADMIN_PASSWORD to run the smoke test.');
  process.exit(1);
}

const authHeader = 'Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name} ${detail}`);
    failed++;
  }
}

async function json(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  const uniqueName = `SMOKE TEST ${Date.now()}`;

  // 1. Public list (active only)
  let res = await fetch(`${BASE_URL}/api/camels`);
  const publicList = await json(res);
  check('GET /api/camels -> 200 array', res.status === 200 && Array.isArray(publicList), `(status ${res.status})`);

  // 2. Admin list requires auth
  res = await fetch(`${BASE_URL}/api/admin/camels`);
  check('GET /api/admin/camels without auth -> 401', res.status === 401, `(status ${res.status})`);

  res = await fetch(`${BASE_URL}/api/admin/camels`, { headers: { Authorization: authHeader } });
  const adminList = await json(res);
  check('GET /api/admin/camels with auth -> 200 array', res.status === 200 && Array.isArray(adminList), `(status ${res.status})`);

  // 3. Create (draft), with additional images
  res = await fetch(`${BASE_URL}/api/admin/camels`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: uniqueName,
      breed: 'Dromedary',
      sex: 'female',
      ageYears: 4,
      priceCad: 12500,
      status: 'draft',
      shortDescription: 'Smoke test camel.',
      longDescription: 'Created by the smoke test. Should be deleted automatically.',
      mainImage: '/uploads/placeholder-main.jpg',
      additionalImages: ['/uploads/a.jpg', '/uploads/b.jpg'],
    }),
  });
  const created = await json(res);
  const id = created && created.id;
  check('POST /api/admin/camels -> 201 with id', res.status === 201 && !!id, `(status ${res.status})`);
  check('  created shape has breed+type alias', created && created.breed === 'Dromedary' && created.type === 'Dromedary');
  check('  created shape has priceCad + additionalImages', created && created.priceCad === 12500 && created.additionalImages.length === 2);

  // Draft should NOT appear in public list
  res = await fetch(`${BASE_URL}/api/camels`);
  let list = await json(res);
  check('draft hidden from public list', Array.isArray(list) && !list.some((c) => c.id === id));

  // 4. Update -> activate
  res = await fetch(`${BASE_URL}/api/admin/camels/${id}`, {
    method: 'PUT',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'active', priceCad: 11000 }),
  });
  const updated = await json(res);
  check('PUT /api/admin/camels/:id -> 200 active', res.status === 200 && updated.status === 'active' && updated.priceCad === 11000, `(status ${res.status})`);

  // Now visible publicly
  res = await fetch(`${BASE_URL}/api/camels`);
  list = await json(res);
  check('active listing visible in public list', Array.isArray(list) && list.some((c) => c.id === id));

  // 5. Delete
  res = await fetch(`${BASE_URL}/api/admin/camels/${id}`, {
    method: 'DELETE',
    headers: { Authorization: authHeader },
  });
  check('DELETE /api/admin/camels/:id -> 200', res.status === 200, `(status ${res.status})`);

  res = await fetch(`${BASE_URL}/api/admin/camels/${id}`, { headers: { Authorization: authHeader } });
  check('deleted listing -> 404', res.status === 404, `(status ${res.status})`);

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err.message || err);
  process.exit(1);
});
