import * as cheerio from 'cheerio';

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|aiff|aif)(?:$|[?#])/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?)(?:$|[?#])/i;

class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

// Hanya alamat web publik; periksa kembali setiap redirect.
export function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError('URL tidak valid. Gunakan https:// atau http://.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new HttpError('Hanya URL HTTP/HTTPS tanpa username atau password yang didukung.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.includes(':') || /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(host)) {
    throw new HttpError('Alamat lokal atau internal tidak diizinkan.');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224 || a === 198 && [18, 19].includes(b)) {
      throw new HttpError('Alamat IP privat tidak diizinkan.');
    }
  }
  if (url.port && !['80', '443'].includes(url.port)) throw new HttpError('Port URL tidak didukung.');
  url.hash = '';
  return url;
}

async function publicFetch(value, { referer, timeout = 25000 } = {}) {
  let url = publicUrl(value);
  for (let i = 0; i <= 5; i++) {
    const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; WebScraper/2.0)', 'Accept': '*/*' };
    if (referer) headers.Referer = publicUrl(referer).href;
    const response = await fetch(url.href, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      await response.body?.cancel();
      if (!location) throw new HttpError('Redirect target tidak valid.', 502);
      url = publicUrl(new URL(location, url).href);
      continue;
    }
    return { response, finalUrl: url.href };
  }
  throw new HttpError('Terlalu banyak redirect.', 502);
}

async function readHtml(response) {
  if (Number(response.headers.get('Content-Length')) > MAX_HTML_BYTES) throw new HttpError('HTML terlalu besar (maksimum 5 MB).', 413);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) throw new HttpError('HTML terlalu besar (maksimum 5 MB).', 413);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

export function extractPage(html, finalUrl) {
  const $ = cheerio.load(html);
  let base = finalUrl;
  try { base = publicUrl(new URL($('base[href]').first().attr('href') || finalUrl, finalUrl).href).href; } catch { /* gunakan URL akhir */ }
  const images = new Set(), audios = new Set();
  function add(set, raw) {
    if (!raw || typeof raw !== 'string') return;
    try {
      const cleaned = raw.trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
      set.add(publicUrl(new URL(cleaned, base).href).href);
    } catch { /* abaikan data:, blob:, javascript:, dan alamat privat */ }
  }
  function srcset(set, value) {
    if (value) value.split(',').forEach(part => add(set, part.trim().split(/\s+/)[0]));
  }
  $('img, picture source').each((_, el) => {
    for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-lazy']) add(images, $(el).attr(attr));
    for (const attr of ['srcset', 'data-srcset']) srcset(images, $(el).attr(attr));
  });
  $('meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]').each((_, el) => add(images, $(el).attr('content')));
  $('[style], [data-background], [data-background-image], [data-bg]').each((_, el) => {
    for (const attr of ['data-background', 'data-background-image', 'data-bg']) add(images, $(el).attr(attr));
    for (const match of ($(el).attr('style') || '').matchAll(/url\(\s*['"]?([^'"()]+?)['"]?\s*\)/gi)) add(images, match[1]);
  });
  $('style').each((_, el) => {
    for (const match of $(el).text().matchAll(/url\(\s*['"]?([^'"()]+?)['"]?\s*\)/gi)) if (IMAGE_EXT.test(match[1])) add(images, match[1]);
  });
  $('audio, audio source').each((_, el) => {
    for (const attr of ['src', 'data-src', 'data-lazy-src']) add(audios, $(el).attr(attr));
  });
  $('meta[property="og:audio"], meta[property="og:audio:secure_url"]').each((_, el) => add(audios, $(el).attr('content')));
  $('a[href]').each((_, el) => { const href = $(el).attr('href'); if (AUDIO_EXT.test(href || '')) add(audios, href); });
  // Fallback untuk URL audio yang ditulis dalam konfigurasi JavaScript/atribut.
  const normalizedHtml = html.replace(/\\\//g, '/');
  for (const match of normalizedHtml.matchAll(/(?:https?:\/\/|\/\/)[^\s"'<>\\]+\.(?:mp3|wav|ogg|oga|m4a|aac|flac|opus)(?:\?[^\s"'<>\\]*)?/gi)) add(audios, match[0]);

  const textDoc = cheerio.load(html);
  textDoc('script, style, noscript, svg, iframe, template, head').remove();
  textDoc('br').replaceWith('\n');
  textDoc('p, div, section, article, header, footer, main, nav, aside, h1, h2, h3, h4, h5, h6, li, ul, ol, blockquote, pre, table, tr, figure, figcaption, address, dl, dt, dd').each((_, el) => {
    textDoc(el).prepend('\n'); textDoc(el).append('\n');
  });
  textDoc('td, th').each((_, el) => textDoc(el).append('\t'));
  const fullText = textDoc('body').text().replace(/\r/g, '').replace(/\u00a0/g, ' ').split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
  return {
    success: true,
    title: $('title').text().trim() || 'Tanpa judul',
    sourceUrl: finalUrl,
    fullText,
    audio: [...audios][0] || null, // tetap kompatibel dengan respons versi sebelumnya
    audios: [...audios],
    images: [...images],
    notice: 'Teks dan media diambil dari HTML awal. Konten yang hanya muncul setelah JavaScript dijalankan, login, atau dari CSS eksternal mungkin tidak terambil. Preview dan download bergantung pada izin server sumber. Batas download: 100 MB per file.'
  };
}

function downloadFilename(source, contentType, kind) {
  const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/flac': 'flac' };
  let name = new URL(source).pathname.split('/').pop() || kind;
  try { name = decodeURIComponent(name); } catch { /* pertahankan nama */ }
  name = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 160) || kind;
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += '.' + (extensions[contentType] || (kind === 'image' ? 'img' : 'audio'));
  return name;
}

async function download(url) {
  const target = publicUrl(url.searchParams.get('url')).href;
  const kind = url.searchParams.get('kind');
  if (!['image', 'audio'].includes(kind)) throw new HttpError('Jenis download harus image atau audio.');
  const { response, finalUrl } = await publicFetch(target, { referer: url.searchParams.get('referer') || undefined, timeout: 60000 });
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(`Sumber media menolak download (HTTP ${response.status}).`, 502); }
  const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const matches = type.startsWith(kind + '/') || (!type || type === 'application/octet-stream') && (kind === 'image' ? IMAGE_EXT : AUDIO_EXT).test(finalUrl);
  if (!matches) { await response.body?.cancel(); throw new HttpError('Sumber tidak mengirim file gambar/audio yang sesuai.', 415); }
  if (Number(response.headers.get('Content-Length')) > MAX_DOWNLOAD_BYTES) { await response.body?.cancel(); throw new HttpError('File melebihi batas download 100 MB.', 413); }
  // Streaming: tidak menampung seluruh audio/gambar di memori Worker.
  let size = 0;
  const body = response.body?.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) throw new Error('File melebihi batas 100 MB.');
      controller.enqueue(chunk);
    }
  }));
  const headers = new Headers({
    'Content-Type': type || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${downloadFilename(finalUrl, type, kind)}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox"
  });
  // Jangan meneruskan Content-Length/Encoding upstream: fetch dapat mendekompresi body.
  return new Response(body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/scrape') {
        if (request.method !== 'POST') return json({ success: false, error: 'Gunakan metode POST.' }, 405);
        let body;
        try { body = await request.json(); } catch { throw new HttpError('Body JSON tidak valid.'); }
        if (!body || typeof body.url !== 'string' || !body.url.trim()) throw new HttpError('URL wajib diisi.');
        const { response, finalUrl } = await publicFetch(body.url.trim());
        if (!response.ok) { await response.body?.cancel(); throw new HttpError(`Gagal mengakses target (HTTP ${response.status}).`, 502); }
        const type = response.headers.get('Content-Type') || '';
        if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) { await response.body?.cancel(); throw new HttpError('URL target harus berupa halaman HTML.', 415); }
        return json(extractPage(await readHtml(response), finalUrl));
      }
      if (url.pathname === '/api/download') {
        if (request.method !== 'GET') return json({ success: false, error: 'Gunakan metode GET.' }, 405);
        return await download(url);
      }
      if (url.pathname.startsWith('/api/')) return json({ success: false, error: 'Endpoint tidak ditemukan.' }, 404);
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    } catch (error) {
      const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
      return json({ success: false, error: timeout ? 'Sumber terlalu lama merespons. Silakan coba lagi.' : error instanceof HttpError ? error.message : 'Gagal menghubungi atau memproses sumber. Silakan coba lagi.' }, timeout ? 504 : error.status || 502);
    }
  }
};
