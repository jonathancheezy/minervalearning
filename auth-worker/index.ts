// Minerva Admin Auth Worker
// Handles secure admin login with challenge-response

const ADMIN_EMAIL = 'admin@minerva.ai';
// Password: Minerva888 — stored as HMAC secret (hex-encoded key)
const ADMIN_PASSWORD_KEY = 'Minerva888';
const CHALLENGE_TTL = 5 * 60 * 1000; // 5 minutes

// In-memory challenge store (resets on Worker cold start, acceptable for low-volume admin)
const challenges = new Map<string, { email: string; expires: number }>();

// Generate random hex challenge
function generateChallenge(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Simple HMAC-SHA256 using Web Crypto
async function hmacSign(message: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const messageData = encoder.encode(message);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyHmac(message: string, signature: string, key: string): Promise<boolean> {
  const expected = await hmacSign(message, key);
  return expected === signature.toLowerCase();
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path === '/api/auth/challenge') {
        // Return a challenge for the given email
        const email = url.searchParams.get('email') || '';
        if (email !== ADMIN_EMAIL) {
          return Response.json({ error: 'Invalid email' }, { status: 401, headers: corsHeaders });
        }
        const challenge = generateChallenge();
        challenges.set(challenge, { email, expires: Date.now() + CHALLENGE_TTL });
        return Response.json({ challenge }, { headers: corsHeaders });
      }

      if (path === '/api/auth/login') {
        // Verify challenge-response and return session token
        const body = await request.json() as { email: string; response: string };
        const { email, response } = body;

        if (email !== ADMIN_EMAIL) {
          return Response.json({ error: 'Invalid credentials' }, { status: 401, headers: corsHeaders });
        }

        // Find valid challenge for this email
        let validChallenge: string | null = null;
        for (const [ch, data] of challenges.entries()) {
          if (data.email === email && data.expires > Date.now()) {
            validChallenge = ch;
            challenges.delete(ch);
            break;
          }
        }

        if (!validChallenge) {
          return Response.json({ error: 'Challenge expired. Please refresh and try again.' }, { status: 401, headers: corsHeaders });
        }

        // Verify HMAC: response should be HMAC-SHA256(challenge, password)
        const isValid = await verifyHmac(validChallenge, response, ADMIN_PASSWORD_KEY);
        if (!isValid) {
          return Response.json({ error: 'Invalid credentials' }, { status: 401, headers: corsHeaders });
        }

        // Generate session token (simple random string, signed)
        const sessionToken = crypto.randomUUID();
        const sessionData = { email, created: Date.now() };
        sessionTokens.set(sessionToken, sessionData);

        const resp = Response.json({ success: true, token: sessionToken }, { headers: corsHeaders });
        resp.headers.set('Access-Control-Allow-Origin', 'https://minervalearning.minerva-ai-learning.workers.dev');
        return resp;
      }

      if (path === '/api/auth/verify') {
        // Verify a session token
        const body = await request.json() as { token: string };
        const data = sessionTokens.get(body.token);
        if (!data || Date.now() - data.created > 24 * 60 * 60 * 1000) {
          return Response.json({ valid: false }, { headers: corsHeaders });
        }
        return Response.json({ valid: true, email: data.email }, { headers: corsHeaders });
      }

      return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
    } catch (err) {
      return Response.json({ error: 'Server error' }, { status: 500, headers: corsHeaders });
    }
  }
};

// In-memory session store
const sessionTokens = new Map<string, { email: string; created: number }>();
