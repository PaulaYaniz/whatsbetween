import {readFileSync, writeFileSync, existsSync, chmodSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import {spawnSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const privateFile = new URL('../.dev.vars', import.meta.url);
const legacyFile = new URL('../../sdow/.env.local', import.meta.url);
const read = (file) => existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
const legacy = read(legacyFile);
const current = read(privateFile);
const names = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'MONGODB_URI', 'MONGODB_DATABASE', 'WOLFRAM_APP_ID', 'SESSION_SECRET'];
let changed = !existsSync(privateFile);
for (const name of names) {
  const value = process.env[name] || legacy[name];
  if (!current[name] && value) { current[name] = value; changed = true; }
}
if (!current.SESSION_SECRET) { current.SESSION_SECRET = randomBytes(32).toString('hex'); changed = true; }
const quote = (value) => {
  for (const delimiter of ["'", '"', '`']) {
    if (!value.includes(delimiter) && !/[\r\n]/.test(value)) return `${delimiter}${value}${delimiter}`;
  }
  throw new Error('A private configuration value cannot be written safely. Configure .dev.vars manually.');
};
if (changed) writeFileSync(privateFile, Object.entries(current).map(([name, value]) => `${name}=${quote(value)}`).join('\n') + '\n', {mode: 0o600});
chmodSync(privateFile, 0o600);
console.log(`Local Gemini: ${current.GEMINI_API_KEY ? 'configured' : 'missing'}. Atlas saving: ${current.MONGODB_URI ? 'configured' : 'not configured'}.`);
if (process.argv.includes('--configure-only')) process.exit(0);
const built = spawnSync('npm', ['run', 'build'], {cwd: root, stdio: 'inherit'});
if (built.status !== 0) process.exit(built.status || 1);
const preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '3000', '--strictPort'], {cwd: root, stdio: 'inherit'});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => preview.kill(signal));
preview.on('exit', (code) => process.exit(code || 0));
