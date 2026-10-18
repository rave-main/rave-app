// The API is served from the same origin: Vite proxies /api in development (vite.config.js)
// and Vercel rewrites it to the Railway backend in production (vercel.json).
export async function api(path, { body, ...options } = {}) {
  const res = await fetch(`/api${path}`, {
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...options,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = data?.details ? `: ${data.details.join(', ')}` : '';
    const err = new Error(`${data?.error || `Request failed (${res.status})`}${details}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
