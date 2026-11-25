// Copies the browser builds of the client libraries into public/vendor.
import { mkdirSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkgDir = name => dirname(require.resolve(name + '/package.json'));
const out = new URL('../public/vendor/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const files = [
  ['pdfjs-dist', 'build/pdf.min.js'],
  ['pdfjs-dist', 'build/pdf.worker.min.js'],
  ['jsqr', 'dist/jsQR.js'],
  ['qrcode-generator', 'qrcode.js'],
  ['jszip', 'dist/jszip.min.js'],
];
for (const [pkg, file] of files) {
  copyFileSync(join(pkgDir(pkg), file), join(out, file.split('/').pop()));
}
// The signing code also runs in the browser for test-signed passes.
copyFileSync(new URL('../src/cms.js', import.meta.url).pathname, join(out, 'cms.js'));
console.log('vendor files copied to public/vendor');
