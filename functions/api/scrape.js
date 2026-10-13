// Kompatibilitas untuk mode Pages Functions. Dalam advanced mode,
// Cloudflare menggunakan public/_worker.js dan mengabaikan folder functions.
import { handleApi } from '../../public/_worker.js';

export function onRequest({ request }) {
  return handleApi(request);
}
