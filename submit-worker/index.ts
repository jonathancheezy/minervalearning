// Minerva Firestore Submit + Migration Worker
// Handles all form submissions with automatic field normalization
// and provides migration endpoint for schema updates

interface Env {
  FIRESTORE_API_KEY: string;
}

const FIRESTORE_API_KEY = 'AIzaSyDX0P7xU6n_a9QcFcKuEnNMdWsafH-7PbCE';
const FIRESTORE_PROJECT = 'minerva-learning-a7eac';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents`;

// Wrap a value in Firestore format
function toFirestore(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return { integerValue: String(v) }; // Firestore REST uses string for int
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestore) } };
  return { stringValue: String(v) };
}

// Unwrap a Firestore value
function fromFirestore(v: any): any {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.doubleValue !== undefined) return parseFloat(v.doubleValue);
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue?.values) return v.arrayValue.values.map(fromFirestore);
  return v;
}

// Versioned field maps — CURRENT_VERSION always wins
const FIELD_MAPS: Record<number, Record<string, Record<string, string | undefined>>> = {
  0: {}, // v0: original schema
  1: {
    // v1: initial normalization (level→studentLevel, experience→yearsExperience)
    parent: {
      level: 'studentLevel',
    },
    teacher: {
      level: 'studentLevel',
      experience: 'yearsExperience',
    }
  },
  2: {
    // v2: enhanced form fields (no renames, just new fields)
    parent: {},
    teacher: {}
  }
};

const CURRENT_VERSION = 2;
const ADMIN_KEY = 'MinervaAdmin2026!';

type Role = 'parent' | 'teacher';

// Normalize client-side flat key-value pairs to Firestore document format
function normalizeFieldsClient(fields: Record<string, any>, role: Role): Record<string, any> {
  const map = FIELD_MAPS[CURRENT_VERSION]?.[role] || {};
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === '') continue;
    const newKey = map[key];
    if (newKey === null) continue; // explicitly removed field
    // Preserve already-Firestore-formatted values from client-side forms
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'stringValue' in value) {
      result[newKey || key] = value;
    } else {
      result[newKey || key] = toFirestore(value);
    }
  }

  return result;
}

// Submit a registration to Firestore
async function submitRegistration(fields: Record<string, any>, role: Role): Promise<Response> {
  const normalized = normalizeFieldsClient(fields, role);

  // Add system fields
  normalized.role = { stringValue: role };
  normalized.status = { stringValue: 'pending' };
  normalized.submittedAt = { timestampValue: new Date().toISOString() };
  normalized.userType = { stringValue: role };
  normalized.schemaVersion = { integerValue: CURRENT_VERSION };

  const url = `${FIRESTORE_BASE}/registrations?key=${FIRESTORE_API_KEY}`;

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: normalized })
  });
}

// List all registrations from Firestore
async function listRegistrations(pageSize = 200): Promise<any> {
  const url = `${FIRESTORE_BASE}/registrations?key=${FIRESTORE_API_KEY}&pageSize=${pageSize}`;
  return fetch(url).then(r => r.json());
}

// Update a single registration document (merging fields)
async function updateRegistration(docId: string, fields: Record<string, any>): Promise<Response> {
  const url = `${FIRESTORE_BASE}/registrations/${docId}?key=${FIRESTORE_API_KEY}&updateMask.fieldPaths=${Object.keys(fields).join('&updateMask.fieldPaths=')}`;
  return fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}

// Flatten a Firestore document to simple key-value pairs
function flattenDoc(doc: any): Record<string, any> {
  const result: Record<string, any> = {};
  const data = doc.fields || {};
  for (const [k, v] of Object.entries(data)) {
    result[k] = fromFirestore(v);
  }
  return result;
}

export default {
  async fetch(request: Request): Promise<Response> {
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
      // POST /api/submit — new registration
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

        return Response.json({
          success: true,
          id: data.name?.split('/').pop(),
          schemaVersion: CURRENT_VERSION
        }, { headers: corsHeaders });
      }

      // POST /api/migrate — batch migrate existing records to current schema
      if (path === '/api/migrate' && request.method === 'POST') {
        const body = await request.json() as { adminKey?: string };
        if (body.adminKey !== ADMIN_KEY) {
          return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
        }

        const { documents } = await listRegistrations(500);
        let migrated = 0, skipped = 0, errors = 0;

        for (const doc of documents) {
          const docId = doc.name?.split('/').pop();
          if (!docId) { skipped++; continue; }

          const flat = flattenDoc(doc);
          const role = (flat.role || 'parent') as Role;
          const existingVersion: number = flat.schemaVersion || 0;

          if (existingVersion >= CURRENT_VERSION) { skipped++; continue; }

          // Normalize: apply current field map (removes old names, adds new names)
          const map = FIELD_MAPS[CURRENT_VERSION]?.[role] || {};
          const normalized: Record<string, any> = {};

          for (const [key, value] of Object.entries(flat)) {
            if (['schemaVersion', 'role', 'status', 'submittedAt', 'userType'].includes(key)) continue;
            const newKey = map[key];
            if (newKey === null) continue; // skip removed fields
            normalized[newKey || key] = toFirestore(value ?? '');
          }

          // Add system fields
          normalized.role = { stringValue: role };
          normalized.status = { stringValue: flat.status || 'pending' };
          normalized.submittedAt = { timestampValue: flat.submittedAt || new Date().toISOString() };
          normalized.userType = { stringValue: role };
          normalized.schemaVersion = { integerValue: CURRENT_VERSION };

          // Preserve any fields not in the map (custom/new fields)
          for (const [key, value] of Object.entries(flat)) {
            if (!(key in normalized) && !['schemaVersion', 'role', 'status', 'submittedAt', 'userType'].includes(key)) {
              normalized[key] = toFirestore(value ?? '');
            }
          }

          // Full document PATCH — replaces all fields (fine for migration)
          const patchUrl = `${FIRESTORE_BASE}/registrations/${docId}?key=${FIRESTORE_API_KEY}`;
          const res = await fetch(patchUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: normalized })
          });

          if (res.ok) migrated++;
          else { errors++; console.error(`Migrate ${docId}: ${res.status}`); }
        }

        return Response.json({
          success: true, migrated, skipped, errors,
          schemaVersion: CURRENT_VERSION,
          message: `Migrated ${migrated}. ${skipped} already current. ${errors} errors.`
        }, { headers: corsHeaders });
      }

      // GET /api/schema
      if (path === '/api/schema' && request.method === 'GET') {
        return Response.json({
          currentVersion: CURRENT_VERSION,
          description: 'v0: original. v1: level→studentLevel, experience→yearsExperience',
          fieldMaps: FIELD_MAPS
        }, { headers: corsHeaders });
      }

      return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
    } catch (err) {
      console.error('Worker error:', err);
      return Response.json({ error: 'Server error' }, { status: 500, headers: corsHeaders });
    }
  }
};
