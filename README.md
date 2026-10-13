# Web Scraper Undangan — Cloudflare Pages

Proyek ini menggunakan **Pages advanced mode**: `public/_worker.js` sebagai API dan `public/index.html` sebagai antarmuka. Tidak ada dependensi runtime, Cheerio, Tailwind CDN, atau proses bundling. Parser memakai `HTMLRewriter` bawaan Cloudflare.

## Deploy paling mudah: Direct Upload

1. Ekstrak ZIP ini.
2. Buat proyek **Cloudflare Pages** dengan **Direct Upload / drag-and-drop**, bukan Worker biasa.
3. Unggah **folder `public`**, bukan folder root proyek. Pastikan `index.html`, `_worker.js`, `_routes.json`, dan `_headers` berada langsung di root file yang diunggah.
4. Deploy, lalu buka alamat Pages yang diberikan Cloudflare.
5. Masukkan URL halaman publik dan klik **Scrape**.

Jika ingin unggah ZIP langsung ke dashboard, gunakan arsip yang berisi empat file dari `public/` langsung di root ZIP. ZIP proyek ini berisi source lengkap; ekstrak dan unggah folder `public` agar tidak ada folder pembungkus yang salah.

Direct Upload mendukung `_worker.js`. Folder `functions/` saja tidak dikompilasi oleh drag-and-drop. Karena itu versi ini menyertakan worker self-contained di `public/`.

## Alternatif: Git integration

Unggah seluruh isi proyek ke repository. Gunakan konfigurasi:

| Pengaturan | Nilai |
| --- | --- |
| Framework preset | None |
| Build command | `node scripts/build.mjs` |
| Build output directory | `public` |
| Root directory | Folder yang berisi `package.json` |

Tidak membutuhkan `npm install`, environment variable, API key, atau `nodejs_compat`. Proyek Direct Upload dan Git integration adalah pilihan berbeda; pilih metode yang diinginkan saat membuat proyek.

## Alternatif: Wrangler / lokal

Gunakan Node.js versi yang didukung Wrangler 4. Dari root proyek jalankan `npm run dev` (menjalankan `npx wrangler@4 pages dev public`), lalu buka alamat lokal yang dicetak Wrangler. Jangan membuka `index.html` lewat `file://` atau server statis saja karena API memerlukan runtime Cloudflare.

Untuk deploy lewat CLI: `npm run deploy`. Wrangler dapat meminta login dan pemilihan/pembuatan proyek Pages. Sesuaikan `name` di `wrangler.toml` jika memilih nama proyek lain. `npm run build` hanya memeriksa file/sintaks; folder `public` sudah siap pakai. `npx` memerlukan akses internet untuk mengunduh Wrangler pertama kali.

## API

Endpoint: `POST /api/scrape`. Gunakan `Content-Type: application/json` dengan body berupa objek yang memiliki properti `url` (string HTTP/HTTPS).

Respons berhasil mempertahankan `success`, `title`, `audio`, `maps`, `calendar`, `images` dan menambahkan `sourceUrl` serta `warnings`. URL media relatif dijadikan absolut, gambar dideduplikasi, dan atribut gambar lazy-load/srcset ikut diperiksa. Semua gambar HTML dikembalikan, bukan hanya yang namanya mengandung `gallery`/`images`. Media/tautan yang tidak ditemukan bernilai `null`; gambar yang tidak ditemukan berupa array kosong. Ini bukan error deploy.

## Perubahan dari file awal

- `package.json` kosong diganti manifest JSON valid.
- Operator JavaScript rusak dan import `cheerio` tanpa dependensi dihapus.
- API memakai `HTMLRewriter` bawaan Cloudflare, bukan Node parser.
- Advanced mode ditambahkan agar upload langsung tetap menjalankan API.
- UI menangani status HTTP, JSON error, timeout, dan klik ganda; CSS lokal menggantikan CDN.
- Body JSON dibatasi 4 KiB, HTML target 2 MiB, akses target 15 detik, redirect maksimal 5.
- URL target dan tiap redirect divalidasi; IP literal, host lokal, kredensial, dan port nonstandar ditolak.
- `functions/api/scrape.js` dipertahankan sebagai wrapper kompatibilitas. Cloudflare mengabaikan folder `functions/` saat `_worker.js` ada; jangan menghapus `_worker.js` untuk Direct Upload.

## Batasan penting

Ini scraper **HTML awal**, bukan browser/headless renderer. Tidak menjalankan JavaScript target, tidak menembus CAPTCHA/proteksi anti-bot, dan tidak mengambil halaman yang membutuhkan login. Audio/gambar yang hanya ada dalam script atau dimuat setelah interaksi bisa tidak ditemukan. URL gambar dikembalikan sebagai daftar, bukan diunduh.

Validasi host adalah perlindungan dasar, bukan jaminan terhadap seluruh teknik DNS rebinding. Sebelum membuka layanan untuk banyak pengguna, tambahkan autentikasi/rate limiting yang sesuai. Gunakan hanya pada halaman yang Anda berhak akses dan patuhi ketentuan situs. Kuota dan batas Cloudflare tetap berlaku.

Pemeriksaan lokal mencakup sintaks serta skenario API dengan mock jaringan/parser. Hasil tidak berarti deploy nyata telah dilakukan. Pengujian akhir parser Cloudflare dan akses situs target harus dilakukan setelah deploy atau melalui Wrangler.

## Dokumentasi Cloudflare yang diperiksa

- https://developers.cloudflare.com/pages/functions/advanced-mode/
- https://developers.cloudflare.com/pages/get-started/direct-upload/
- https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/
