// Minerva Firestore Submit + Migration Worker
// Handles all form submissions with automatic field normalization
// and provides migration endpoint for schema updates

interface Env {
  FIRESTORE_API_KEY: string;
  FIRESTORE_PROJECT: string;
  FIRESTORE_URL: string;
}

// Versioned field maps — add new versions as schema evolves
// version N+1 always includes all fields from N (no field removals, only additions/renames)
const FIELD_MAPS = [
  // v0: Initial schema (before any normalization)
  {
    version: 0,
    parent: ['level', 'experience'],
    teacher: ['level']
  },
  // v1: Current schema — field renames
  {
    version: 1,
    parent: {
      level: 'studentLevel',           // renamed
      experience: undefined,            // removed (was never parent field)
    },
    teacher: {
      level: 'studentLevel',           // renamed
      experience: 'yearsExperience',   // renamed
    }
  }
];

const CURRENT_VERSION = 1;
const FIRESTORE_API_KEY = 'AIzaSyDX0P7xU6n_a9QcFcKuEnNMdWsafH-7PbCE';
const FIRESTORE_PROJECT = 'minerva-learning-a7eac';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents`;

type Role = 'parent' | 'teacher';

// Normalize a document's fields according to current schema
function normalizeFields(fields: Record<string, any>, role: Role): Record<string, any> {
  const map = FIELD_MAPS[CURRENT_VERSION][role] || {};
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(fields)) {
    const newKey = map[key as keyof typeof map];
    if (newKey === undefined) continue; // skip removed fields
    result[newKey || key] = value;
  }

  // Always add schema version
  result.schemaVersion = { integerValue: CURRENT_VERSION };

  return result;
}

// Submit a registration to Firestore
async function submitRegistration(data: Record<string, any>, role: Role): Promise<Response> {
  const normalized = normalizeFields(data, role);
  normalized.role = { stringValue: role };
  normalized.status = { stringValue: 'pending' };
  normalized.submittedAt = { timestampValue: new Date().toISOString() };
  normalized.userType = { stringValue: role };

  const url = `${FIRESTORE_BASE}/registrations?key=${FIRESTORE_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: normalized })
  });

  return res;
}

// List all registrations from Firestore
async function listRegistrations(pageSize = 200): Promise<{ documents: any[] }> {
  const url = `${FIRESTORE_BASE}/registrations?key=${FIRESTORE_API_KEY}&pageSize=${pageSize}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firestore list failed: ${res.status}`);
  return res.json();
}

// Update a single registration document
async function updateRegistration(docId: string, fields: Record<string, any>): Promise<Response> {
  const url = `${FIRESTORE_BASE}/registrations/${docId}?key=${FIRESTORE_API_KEY}`;
  return fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}

// Convert Firestore document to flattened key-value object
function flattenDoc(doc: any): Record<string, any> {
  const result: Record<string, any> = {};
  const data = doc.fields || {};

  function unwrap(v: any): any {
    if (!v) return null;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.integerValue !== undefined) return parseInt(v.integerValue);
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.doubleValue !== undefined) return parseFloat(v.doubleValue);
    if (v.timestampValue !== undefined) return v.timestampValue;
    if (v.arrayValue?.values) return v.arrayValue.values.map(unwrap);
    return v;
  }

  for (const [k, vv] of Object.entries(data)) {
    result[k] = unwrap(vv);
  }
  return result;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // POST /api/submit — new registration submission
      if (path === '/api/submit' && request.method === 'POST') {
        const body = await request.json() as { fields: Record<string, any>; role: Role };

        if (!body.fields || !body.role) {
          return Response.json({ error: 'Missing fields or role' }, { status: 400, headers: corsHeaders });
        }

        const res = await submitRegistration(body.fields, body.role);
        const data = await res.json();

        if (!res.ok) {
          return Response.json({ error: 'Firestore error', detail: data }, { status: 502, headers: corsHeaders });
        }

        return Response.json({ success: true, id: data.name?.split('/').pop(), schemaVersion: CURRENT_VERSION }, { headers: corsHeaders });
      }

      // POST /api/migrate — batch migrate existing records to current schema
      if (path === '/api/migrate' && request.method === 'POST') {
        const body = await request.json() as { adminKey?: string };
        const ADMIN_KEY = 'MinervaAdmin2026!';

        if (body.adminKey !== ADMIN_KEY) {
          return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
        }

        const { documents } = await listRegistrations(500);
        let migrated = 0;
        let skipped = 0;
        let errors = 0;

        for (const doc of documents) {
          const docId = doc.name?.split('/').pop();
          if (!docId) { skipped++; continue; }

          const flat = flattenDoc(doc);
          const role = (flat.role || 'parent') as Role;
          const existingVersion = flat.schemaVersion || 0;

          if (existingVersion >= CURRENT_VERSION) {
            skipped++; continue; // already on current schema
          }

          // Normalize the existing fields
          const normalized = normalizeFields(flat, role);
          normalized.role = { stringValue: role };
          normalized.status = { stringValue: flat.status || 'pending' };
          normalized.submittedAt = { timestampValue: flat.submittedAt || new Date().toISOString() };
          normalized.userType = { stringValue: role };

          // Preserve original fields that normalization might have missed
          // (normalizeFields only removes/renames, doesn't add new fields)
          for (const [k, v] of Object.entries(flat)) {
            if (!(k in normalized) && !['schemaVersion', 'role', 'status', 'submittedAt', 'userType'].includes(k)) {
              normalized[k] = { stringValue: String(v) };
            }
          }

          const res = await updateRegistration(docId, normalized);
          if (res.ok) {
            migrated++;
          } else {
            errors++;
            console.error(`Failed to migrate ${docId}: ${res.status}`);
          }
        }

        return Response.json({
          success: true,
          migrated,
          skipped,
          errors,
          schemaVersion: CURRENT_VERSION,
          message: `Migrated ${migrated} documents. ${skipped} already current. ${errors} errors.`
        }, { headers: corsHeaders });
      }

      // GET /api/schema — return current schema version info
      if (path === '/api/schema' && request.method === 'GET') {
        return Response.json({
          currentVersion: CURRENT_VERSION,
          fieldMaps: FIELD_MAPS,
          description: 'v0: original schema. v1 (current): level→studentLevel, experience→yearsExperience'
        }, { headers: corsHeaders });
      }

      return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
    } catch (err) {
      console.error('Submit worker error:', err);
      return Response.json({ error: 'Server error' }, { status: 500, headers: corsHeaders });
    }
  }
};
