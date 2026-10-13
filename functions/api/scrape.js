import * as cheerio from 'cheerio';

export async function onRequestPost({ request }) {
  try {
    const { url } = await request.json();

    if (!url) {
      return new Response(JSON.stringify({ error: "URL wajib diisi" }), { status: 400 });
    }

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Gagal mengakses target (${res.status})` }), { status: res.status });
    }

    const html = await res.text();
const $doc = cheerio.load(html);

// Ambil URL Audio background
const audioSrc = $doc('audio source').attr('src') || $doc('audio').attr('src') || null;

// Ambil semua gambar galeri
const galleryImages = [];
$doc('img').each((_, el) => {
  const src = $doc(el).attr('src');
  if (src && (src.includes('gallery') || src.includes('images'))) {
    galleryImages.push(src);
  }
});

// Ambil link Google Maps & Calendar
const mapsLink = $doc('a[href*="google.com/maps"]').attr('href') || null;
const calendarLink = $doc('a[href*="calendar.google.com"]').attr('href') || null;
const pageTitle = $doc('title').text().trim();

    return new Response(JSON.stringify({
      success: true,
      title: pageTitle,
      audio: audioSrc,
      maps: mapsLink,
      calendar: calendarLink,
      images: [...new Set(galleryImages)],
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}