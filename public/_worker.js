// Cloudflare Pages advanced mode; tidak membutuhkan npm package.
const TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4096;

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

function validateTarget(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError('URL wajib diisi.');
  if (value.length > 2048) throw new ApiError('URL terlalu panjang.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new ApiError('URL tidak valid.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ApiError('URL harus menggunakan http atau https.');
  if (url.username || url.password) throw new ApiError('URL dengan username/password tidak didukung.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // Tolak host lokal serta semua literal IPv4/IPv6, termasuk bentuk numerik
  // yang dinormalisasi oleh URL. Setiap redirect diperiksa kembali.
  if (!host.includes('.') || host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      !/^[a-z0-9.-]+$/.test(host) || host.includes('..') ||
      /(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(host)) {
    throw new ApiError('Gunakan domain publik, bukan alamat IP atau host lokal.');
  }
  if (url.port && !['80', '443'].includes(url.port)) throw new ApiError('Hanya port HTTP/HTTPS standar yang didukung.');
  url.hash = '';
  return url;
}

async function readLimited(response, limit, status, message) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > limit) {
    if (response.body) await response.body.cancel();
    throw new ApiError(message, status);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(message, status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function fetchHtml(initialUrl, signal) {
  let target = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(target.href, {
      redirect: 'manual',
      signal,
      headers: { 'Accept': 'text/html,application/xhtml+xml;q=0.9', 'User-Agent': 'UndanganScraper/1.0' }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (response.body) await response.body.cancel();
      if (!location) throw new ApiError('Redirect target tidak memiliki lokasi.', 502);
      if (redirects === 5) throw new ApiError('Redirect target terlalu banyak.', 502);
      let next;
      try { next = new URL(location, target).href; } catch { throw new ApiError('Lokasi redirect tidak valid.', 502); }
      try { target = validateTarget(next); } catch (error) { throw new ApiError('Redirect ditolak: ' + error.message, 502); }
      continue;
    }
    if (!response.ok) {
      if (response.body) await response.body.cancel();
      throw new ApiError('Gagal mengakses target (HTTP ' + response.status + '). Situs mungkin memblokir bot atau membutuhkan login.', 502);
    }
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      if (response.body) await response.body.cancel();
      throw new ApiError('Target harus berupa halaman HTML, bukan JSON, PDF, atau media.', 415);
    }
    const bytes = await readLimited(response, MAX_HTML_BYTES, 413, 'HTML target melebihi batas 2 MiB.');
    return { bytes, contentType, finalUrl: target.href };
  }
  throw new ApiError('Redirect target terlalu banyak.', 502);
}

function resolveMedia(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

async function extractData(html) {
  let baseHref = null;
  let baseSeen = false;
  const titleChunks = [];
  const audioValues = [];
  const imageValues = [];
  const linkValues = [];
  const addAttr = (values, element, names) => {
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value) values.push(value);
    }
  };
  const rewriter = new HTMLRewriter()
    .on('base[href]', { element(element) {
      if (!baseSeen) { baseSeen = true; baseHref = element.getAttribute('href'); }
    } })
    .on('title', { text(chunk) { titleChunks.push(chunk.text); } })
    .on('audio', { element(element) { addAttr(audioValues, element, ['src', 'data-src']); } })
    .on('audio source', { element(element) { addAttr(audioValues, element, ['src', 'data-src']); } })
    .on('img', { element(element) {
      addAttr(imageValues, element, ['data-src', 'data-original', 'data-lazy-src', 'src']);
      for (const name of ['srcset', 'data-srcset']) {
        const value = element.getAttribute(name);
        if (value && !value.trim().startsWith('data:')) {
          for (const candidate of value.split(',')) {
            const src = candidate.trim().split(/\s+/)[0];
            if (src) imageValues.push(src);
          }
        }
      }
    } })
    .on('picture source', { element(element) {
      const value = element.getAttribute('srcset') || element.getAttribute('data-srcset');
      if (value && !value.trim().startsWith('data:')) {
        for (const candidate of value.split(',')) {
          const src = candidate.trim().split(/\s+/)[0];
          if (src) imageValues.push(src);
        }
      }
    } })
    .on('a[href]', { element(element) { addAttr(linkValues, element, ['href']); } })
    .on('iframe[src]', { element(element) { addAttr(linkValues, element, ['src']); } });
  // HTMLRewriter bersifat streaming; konsumsi body agar semua handler dijalankan.
  await rewriter.transform(new Response(html.bytes, { headers: { 'Content-Type': html.contentType } })).text();
  const base = resolveMedia(baseHref, html.finalUrl) || html.finalUrl;
  const images = [...new Set(imageValues.map(value => resolveMedia(value, base)).filter(Boolean))];
  const audio = audioValues.map(value => resolveMedia(value, base)).find(Boolean) || null;
  const links = linkValues.map(value => resolveMedia(value, base)).filter(Boolean);
  const maps = links.find(value => {
    const url = new URL(value);
    return (/(^|\.)google\.com$/.test(url.hostname) && /^\/maps(?:\/|$)/.test(url.pathname)) ||
      url.hostname === 'maps.google.com' || url.hostname === 'maps.app.goo.gl' ||
      (url.hostname === 'goo.gl' && /^\/maps(?:\/|$)/.test(url.pathname));
  }) || null;
  const calendar = links.find(value => {
    const url = new URL(value);
    return url.hostname === 'calendar.google.com' ||
      (url.hostname === 'www.google.com' && /^\/calendar(?:\/|$)/.test(url.pathname));
  }) || null;
  const warnings = [];
  if (!audio) warnings.push('Audio tidak ditemukan dalam HTML awal.');
  if (!images.length) warnings.push('Gambar tidak ditemukan dalam HTML awal.');
  return {
    success: true,
    title: titleChunks.join('').replace(/\s+/g, ' ').trim(),
    audio, maps, calendar, images,
    sourceUrl: html.finalUrl,
    warnings
  };
}

export async function handleApi(request) {
  if (request.method !== 'POST') return json({ success: false, error: 'Gunakan metode POST.' }, 405, { 'Allow': 'POST' });
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ success: false, error: 'Origin tidak diizinkan.' }, 403);
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    return json({ success: false, error: 'Gunakan Content-Type application/json.' }, 415);
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  try {
    const bytes = await readLimited(request, MAX_REQUEST_BYTES, 413, 'Body permintaan terlalu besar.');
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ApiError('Body JSON tidak valid.'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ApiError('Body harus berupa objek JSON.');
    const url = validateTarget(payload.url);
    if (url.origin === new URL(request.url).origin) throw new ApiError('Gunakan URL situs target lain, bukan URL aplikasi scraper.');
    const html = await fetchHtml(url, controller.signal);
    return json(await extractData(html));
  } catch (error) {
    if (timedOut || error.name === 'AbortError') return json({ success: false, error: 'Waktu akses target melebihi 15 detik.' }, 504);
    if (error instanceof ApiError) return json({ success: false, error: error.message }, error.status);
    console.error('Scraper error:', error);
    return json({ success: false, error: 'Gagal memproses target. Periksa URL atau coba situs lain.' }, 502);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/scrape' || path === '/api/scrape/') return handleApi(request);
    if (path.startsWith('/api/')) return json({ success: false, error: 'Endpoint tidak ditemukan.' }, 404);
    return env.ASSETS.fetch(request);
  }
};
