// Image uploads to Supabase Storage (public `photos` bucket).
//
// We no longer write uploads to local disk. The public marketing site is served
// from GitHub Pages (a different origin than the Express/Railway server) and
// reads Supabase directly, so a relative `/uploads/...` path would 404 there.
// Uploading to a PUBLIC Storage bucket yields an absolute URL that resolves from
// every deploy target and from a direct Supabase read.
//
// Security notes:
//  - The bucket is created with a 5MB size limit + image MIME allowlist, but we
//    ALSO validate MIME + size here so a bad request is rejected before it ever
//    reaches Storage.
//  - The stored object name is a random hex string; the extension is derived
//    from the *sniffed/declared MIME type*, never from the client-supplied
//    filename or extension.
//  - Writes use the service-role client (RLS bypassed); the anon key can only
//    read. The service-role key never leaves the server.

import crypto from 'node:crypto';

export const BUCKET = 'photos';
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

// Map an allowed MIME type to the canonical extension we store it under. Any
// MIME not in this map is rejected — we do not trust client file extensions.
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function isAllowedImage(mimetype) {
  return Object.prototype.hasOwnProperty.call(MIME_EXT, mimetype);
}

// multer fileFilter — reject anything that isn't an allowed image MIME type up
// front so we never buffer a disallowed file.
export function imageFileFilter(_req, file, cb) {
  if (isAllowedImage(file.mimetype)) return cb(null, true);
  return cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: JPEG, PNG, WebP, GIF.`));
}

// Upload a single in-memory multer file to the given folder ("camels" |
// "gallery") in the public bucket. Returns the absolute public URL.
export async function uploadImage(supabase, file, folder) {
  if (!file || !file.buffer) throw new Error('No file provided.');
  if (!isAllowedImage(file.mimetype)) {
    throw new Error(`Unsupported file type: ${file.mimetype}.`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('File exceeds the 5MB limit.');
  }

  const ext = MIME_EXT[file.mimetype];
  const safeFolder = folder === 'gallery' ? 'gallery' : 'camels';
  const objectPath = `${safeFolder}/${crypto.randomBytes(16).toString('hex')}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(objectPath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
      cacheControl: '31536000',
    });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);
  return data.publicUrl;
}

// Upload many files, preserving order. Returns an array of absolute URLs.
export async function uploadImages(supabase, files, folder) {
  const list = Array.isArray(files) ? files : [];
  const urls = [];
  for (const f of list) urls.push(await uploadImage(supabase, f, folder));
  return urls;
}

// Best-effort delete of a previously uploaded object, given its public URL. Used
// when a gallery photo or camel is removed. Silently ignores URLs that aren't in
// our bucket (e.g. legacy or externally-hosted URLs) and never throws — a failed
// cleanup should not fail the request.
export async function deleteByPublicUrl(supabase, publicUrl) {
  const objectPath = objectPathFromPublicUrl(publicUrl);
  if (!objectPath) return;
  try {
    await supabase.storage.from(BUCKET).remove([objectPath]);
  } catch {
    /* best effort */
  }
}

export async function deleteManyByPublicUrl(supabase, urls) {
  const paths = (Array.isArray(urls) ? urls : [])
    .map(objectPathFromPublicUrl)
    .filter(Boolean);
  if (paths.length === 0) return;
  try {
    await supabase.storage.from(BUCKET).remove(paths);
  } catch {
    /* best effort */
  }
}

// Extract the in-bucket object path from a public URL, or null if the URL does
// not point at our bucket.
function objectPathFromPublicUrl(publicUrl) {
  if (typeof publicUrl !== 'string') return null;
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return null;
  const path = publicUrl.slice(idx + marker.length).split('?')[0];
  return path ? decodeURIComponent(path) : null;
}
