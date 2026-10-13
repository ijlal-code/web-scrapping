import * as cheerio from 'cheerio';

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|aiff|aif)(?:$|[?#])/i;
const VIDEO_EXT = /\.(mp4|webm|gif|mov|m4v|ogv)(?:$|[?#])/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?)(?:$|[?#])/i;

const CODE_EXT = /\.(css|[cm]?js|json|map|xml|txt|webmanifest|wasm|woff2?|ttf|otf|eot)(?:$|[?#])/i;
const CODE_TYPES = new Set(['html', 'css', 'js', 'json', 'xml', 'text', 'font', 'wasm', 'map', 'data']);
function codeType(value, hint = 'data') {
  const extension = value.match(CODE_EXT)?.[1].toLowerCase();
  if (extension === 'css') return 'css';
  if (['js', 'mjs', 'cjs'].includes(extension)) return 'js';
  if (['json', 'webmanifest'].includes(extension)) return 'json';
  if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(extension)) return 'font';
  if (extension === 'txt') return 'text';
  return extension || hint;
}

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
  const images = new Set(), audios = new Set(), videos = new Set();
  function add(set, raw) {
    if (!raw || typeof raw !== 'string') return;
    try {
      const cleaned = raw.trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
      const resolved = publicUrl(new URL(cleaned, base).href).href;
      // GIF dikelompokkan bersama video, meskipun berasal dari tag img/CSS.
      (set === images && VIDEO_EXT.test(resolved) ? videos : set).add(resolved);
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

  $('video, video source').each((_, el) => {
    for (const attr of ['src', 'data-src', 'data-lazy-src']) add(videos, $(el).attr(attr));
  });
  $('video[poster]').each((_, el) => add(images, $(el).attr('poster')));
  $('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]').each((_, el) => {
    const value = $(el).attr('content');
    // Jangan perlakukan halaman embed YouTube/Vimeo sebagai file video.
    if (VIDEO_EXT.test(value || '')) add(videos, value);
  });
  $('a[href], [data-video], [data-video-src], [data-src]').each((_, el) => {
    for (const attr of ['href', 'data-video', 'data-video-src', 'data-src']) {
      const value = $(el).attr(attr);
      if (VIDEO_EXT.test(value || '')) add(videos, value);
    }
  });
  for (const match of normalizedHtml.matchAll(/(?:https?:\/\/|\/\/)[^\s"'<>\\]+\.(?:mp4|webm|gif|mov|m4v|ogv)(?:\?[^\s"'<>\\]*)?/gi)) add(videos, match[0]);

  // File yang tersedia bagi browser saja: tidak mencoba mengambil source backend.
  const codeFiles = [{
    id: 'page-html', name: 'index.html', type: 'html', mime: 'text/html',
    sourceUrl: finalUrl, content: html, inline: false,
    description: 'Snapshot HTML awal halaman'
  }];
  const codeUrls = new Set();
  function addCode(raw, hint = 'data') {
    if (!raw || typeof raw !== 'string') return;
    try {
      const source = publicUrl(new URL(raw.trim().replace(/&amp;/g, '&').replace(/\\\//g, '/'), base).href).href;
      if (codeUrls.has(source) || source === finalUrl) return;
      const type = codeType(source, hint);
      if (!CODE_TYPES.has(type)) return;
      codeUrls.add(source);
      const name = codeDownloadName(source, type, 'application/octet-stream');
      codeFiles.push({ id: 'asset-' + codeFiles.length, name, type, url: source, sourceUrl: source, inline: false, description: 'Aset eksternal yang dirujuk halaman' });
    } catch { /* abaikan URL nonpublik, data URI, dan blob */ }
  }
  function cssDependencies(text) {
    for (const match of text.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/gi)) addCode(match[1], 'css');
    for (const match of text.matchAll(/url\(\s*['"]?([^'"()]+?)['"]?\s*\)/gi)) if (CODE_EXT.test(match[1])) addCode(match[1]);
  }
  $('link[href]').each((_, el) => {
    const rel = ($(el).attr('rel') || '').toLowerCase().split(/\s+/);
    const as = ($(el).attr('as') || '').toLowerCase(), value = $(el).attr('href');
    if (rel.includes('stylesheet')) addCode(value, 'css');
    else if (rel.includes('modulepreload')) addCode(value, 'js');
    else if (rel.includes('manifest')) addCode(value, 'json');
    else if (rel.includes('preload') && ['script', 'style', 'font'].includes(as)) addCode(value, {script: 'js', style: 'css', font: 'font'}[as]);
    else if (CODE_EXT.test(value || '')) addCode(value);
  });
  let inlineScript = 0, inlineStyle = 0;
  $('script').each((_, el) => {
    const node = $(el);
    for (const attr of ['src', 'data-src']) addCode(node.attr(attr), 'js');
    if (node.attr('src')) return;
    const text = node.html() || '';
    if (!text.trim()) return;
    const declared = (node.attr('type') || '').trim().toLowerCase();
    const type = declared.includes('json') || ['importmap', 'speculationrules'].includes(declared) ? 'json' : !declared || declared === 'module' || /javascript|ecmascript/.test(declared) ? 'js' : 'text';
    const extension = { js: 'js', json: 'json', text: 'txt' }[type];
    inlineScript++;
    codeFiles.push({ id: 'inline-script-' + inlineScript, name: 'inline-script-' + String(inlineScript).padStart(3, '0') + '.' + extension, type, mime: type === 'json' ? 'application/json' : type === 'js' ? 'text/javascript' : 'text/plain', sourceUrl: finalUrl, content: text, inline: true, description: 'Diekstrak dari script inline dalam HTML' });
    if (type === 'js') {
      for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]((?:\.{1,2}\/|\/|https?:\/\/)[^'"\s]+)['"]/g)) addCode(match[1], 'js');
    }
  });
  $('style').each((_, el) => {
    const text = $(el).html() || '';
    if (!text.trim()) return;
    inlineStyle++;
    codeFiles.push({ id: 'inline-style-' + inlineStyle, name: 'inline-style-' + String(inlineStyle).padStart(3, '0') + '.css', type: 'css', mime: 'text/css', sourceUrl: finalUrl, content: text, inline: true, description: 'Diekstrak dari style inline dalam HTML' });
    cssDependencies(text);
  });
  $('[style]').each((_, el) => cssDependencies($(el).attr('style') || ''));
  // Aset pendukung eksplisit (JSON, map, font, WASM, dsb.), bukan crawler rekursif.
  $('[src], [href], [data-src], [data-href]').each((_, el) => {
    for (const attr of ['src', 'href', 'data-src', 'data-href']) {
      const value = $(el).attr(attr);
      if (CODE_EXT.test(value || '')) addCode(value);
    }
  });

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
    videos: [...videos],
    codeFiles,
    codeNotice: 'HTML awal, CSS/JS inline, dan aset publik yang dirujuk HTML dikumpulkan. Aset eksternal diambil saat Download/ZIP. Ini bukan salinan offline lengkap dan tidak mencakup kode backend/private.',
    notice: 'Teks dan media diambil dari HTML awal. Konten yang hanya muncul setelah JavaScript dijalankan, login, atau dari CSS eksternal mungkin tidak terambil. Preview dan download bergantung pada izin server sumber. Batas download: 100 MB per file.'
  };
}

function downloadFilename(source, contentType, kind) {
  const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/flac': 'flac', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov', 'text/html': 'html', 'application/xhtml+xml': 'html', 'text/css': 'css', 'application/javascript': 'js', 'text/javascript': 'js', 'application/json': 'json', 'application/manifest+json': 'webmanifest', 'text/xml': 'xml', 'application/xml': 'xml', 'text/plain': 'txt', 'application/wasm': 'wasm', 'font/woff': 'woff', 'font/woff2': 'woff2', 'font/ttf': 'ttf', 'font/otf': 'otf' };
  let name = new URL(source).pathname.split('/').pop() || kind;
  try { name = decodeURIComponent(name); } catch { /* pertahankan nama */ }
  name = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 160) || kind;
  if (!/\.[a-z0-9]{2,12}$/i.test(name)) name += '.' + (extensions[contentType] || (kind === 'image' ? 'img' : kind === 'video' ? 'video' : kind === 'code' ? 'txt' : 'audio'));
  return name;
}

function codeDownloadName(source, expectedType, mime) {
  const name = downloadFilename(source, mime, 'code');
  const urlExtension = new URL(source).pathname.match(/\.([a-z0-9]{2,12})$/i);
  if (urlExtension) return name;
  const suffix = { html: 'html', css: 'css', js: 'js', json: 'json', xml: 'xml', text: 'txt', map: 'map', wasm: 'wasm', font: 'font', data: 'bin' }[expectedType];
  return name.replace(/\.[a-z0-9]{2,12}$/i, '') + '.' + suffix;
}

async function download(url) {
  const target = publicUrl(url.searchParams.get('url')).href;
  const kind = url.searchParams.get('kind');
  if (!['image', 'audio', 'video', 'code'].includes(kind)) throw new HttpError('Jenis download harus image, video, audio, atau code.');
  const expectedCodeType = url.searchParams.get('fileType') || codeType(target, /\.html?(?:$|[?#])/i.test(target) ? 'html' : 'data');
  if (kind === 'code' && !CODE_TYPES.has(expectedCodeType)) throw new HttpError('Tipe file kode tidak didukung.');
  const { response, finalUrl } = await publicFetch(target, { referer: url.searchParams.get('referer') || undefined, timeout: 60000 });
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(`Sumber file menolak download (HTTP ${response.status}).`, 502); }
  const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const extension = kind === 'image' ? IMAGE_EXT : kind === 'video' ? VIDEO_EXT : AUDIO_EXT;
  let matches = type.startsWith(kind + '/') || kind === 'video' && type === 'image/gif' || (!type || type === 'application/octet-stream') && extension.test(finalUrl);
  if (kind === 'code') {
    const codeMime = /^(?:text\/(?:css|javascript|ecmascript|plain|xml)|application\/(?:javascript|x-javascript|ecmascript|json|manifest\+json|ld\+json|xml|wasm|vnd\.ms-fontobject|font-woff|x-font-[a-z0-9-]+)|font\/[a-z0-9-]+)$/i;
    const htmlMime = /^(?:text\/html|application\/xhtml\+xml)$/i;
    // Jangan menyimpan halaman login/anti-bot HTML sebagai file .css atau .js.
    matches = expectedCodeType === 'html' ? htmlMime.test(type) || type === 'text/plain' : codeMime.test(type);
    if (!type || type === 'application/octet-stream') matches = CODE_EXT.test(finalUrl) || expectedCodeType !== 'data';
  }
  if (!matches) { await response.body?.cancel(); throw new HttpError('Sumber tidak mengirim jenis file yang sesuai (mungkin halaman login atau anti-bot).', 415); }
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
    'Content-Disposition': `attachment; filename="${kind === 'code' ? codeDownloadName(finalUrl, expectedCodeType, type) : downloadFilename(finalUrl, type, kind)}"`,
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
