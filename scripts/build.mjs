import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

for (const name of ['public/index.html', 'public/_worker.js', 'public/_routes.json']) {
  if (!existsSync(name)) throw new Error('File wajib tidak ditemukan: ' + name);
}
const routes = JSON.parse(readFileSync('public/_routes.json', 'utf8'));
if (routes.version !== 1 || !routes.include.includes('/api/*')) throw new Error('Konfigurasi routing API tidak valid.');
execFileSync(process.execPath, ['--check', 'public/_worker.js'], { stdio: 'inherit' });
console.log('Build selesai. Output Cloudflare Pages: public/ (tidak memerlukan dependensi).');
