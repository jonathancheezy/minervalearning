// Minerva Admin Auth Worker
// Uses Web Crypto API (fully async, no Node.js crypto needed)

const ADMIN_EMAIL = 'admin@minerva.ai';
const ADMIN_PASSWORD = 'Minerva888';
const SECRET = 'minerva-admin-2026-hmac-secret-key';
const SESSION_TTL = 24 * 60 * 60 * 1000;

async function hmacSign(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function base64url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createToken(email: string): Promise<string> {
  const expiry = Date.now() + SESSION_TTL;
  const payload = `${email}:${expiry}`;
  const sig = await hmacSign(payload, SECRET);
  return base64url(`${email}:${expiry}:${sig}`);
}

async function verifyToken(token: string): Promise<{ email: string; valid: boolean }> {
  try {
    const decoded = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
    const lastColon = decoded.lastIndexOf(':');
    const sig = decoded.substring(lastColon + 1);
    const beforeSig = decoded.substring(0, lastColon);
    const lastColon2 = beforeSig.lastIndexOf(':');
    const expiryStr = beforeSig.substring(lastColon2 + 1);
    const email = beforeSig.substring(0, lastColon2);
    const expiry = parseInt(expiryStr);
    if (isNaN(expiry) || Date.now() > expiry) return { email, valid: false };
    const expectedSig = await hmacSign(`${email}:${expiryStr}`, SECRET);
    if (sig !== expectedSig) return { email, valid: false };
    return { email, valid: true };
  } catch {
    return { email: '', valid: false };
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://minervalearning.minerva-ai-learning.workers.dev',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path === '/api/auth/login') {
        const body = await request.json() as { email: string; password: string };
        const { email, password } = body;
        if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
          return Response.json({ error: 'Invalid credentials' }, { status: 401, headers: corsHeaders });
        }
        const token = await createToken(email);
        return Response.json({ success: true, token, email }, { headers: corsHeaders });
      }

      if (path === '/api/auth/verify') {
        const body = await request.json() as { token: string };
        const result = await verifyToken(body.token);
        return Response.json({ valid: result.valid, email: result.email }, { headers: corsHeaders });
      }


      if (path === '/api/notify/rejection') {
        const body = await request.json() as { to: string; name: string; reason: string };
        const { to, name, reason } = body;
        if (!to || !reason) {
          return Response.json({ error: 'Missing required fields' }, { status: 400, headers: corsHeaders });
        }
        // TODO: Integrate with email service (SendGrid, Mailgun, WhatsApp Business API)
        // For now, logs the notification — implement email sending in production
        console.log('[Notify] Rejection to', to, 'name:', name, 'reason:', reason);
        return Response.json({ success: true }, { headers: corsHeaders });
      }

      return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
    } catch (err) {
      return Response.json({ error: 'Server error: ' + String(err) }, { status: 500, headers: corsHeaders });
    }
  }
};

