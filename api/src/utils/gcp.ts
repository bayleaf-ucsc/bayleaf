// GCP Service Account JWT Authentication for Cloudflare Workers (Web Crypto API)

interface GCPTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

let cachedToken: string | null = null;
let tokenExpiration: number = 0;

function encodeBase64Url(buffer: ArrayBuffer | string): string {
  const bytes = typeof buffer === 'string' 
    ? new TextEncoder().encode(buffer) 
    : new Uint8Array(buffer);
  
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function getGCPAccessToken(clientEmail: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  
  // Return cached token if valid for at least 5 more minutes
  if (cachedToken && tokenExpiration > now + 300) {
    return cachedToken;
  }

  // 1. Build the JWT Header & Payload
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, // 1 hour max
    iat: now
  };

  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  // 2. Import the Private Key via Web Crypto
  const keyBuffer = pemToArrayBuffer(privateKeyPem);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // 3. Sign the JWT
  const signatureBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const encodedSignature = encodeBase64Url(signatureBuffer);
  const signedJwt = `${unsignedToken}.${encodedSignature}`;

  // 4. Exchange JWT for Google Cloud Access Token
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`GCP OAuth Error: ${response.status} ${err}`);
  }

  const data = await response.json() as GCPTokenResponse;
  
  // Cache the new token
  cachedToken = data.access_token;
  tokenExpiration = now + data.expires_in;

  return cachedToken;
}
