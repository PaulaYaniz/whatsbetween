const SDOW_API_URL_DEV = import.meta.env.VITE_SDOW_API_URL || 'http://127.0.0.1:5000';
// Production uses the same-origin Worker API (no upstream host).
const SDOW_API_URL_PROD = '';

export const SDOW_API_URL = import.meta.env.PROD ? SDOW_API_URL_PROD : SDOW_API_URL_DEV;

export const WIKIPEDIA_API_URL = 'https://en.wikipedia.org/w/api.php';

export const SDOW_USER_AGENT =
  "What's Between/1.0 (https://whatsbetween.us/)";
