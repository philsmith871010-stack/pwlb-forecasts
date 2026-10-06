// Copies the deal register reader from the pwlbtoday-tms repo, unchanged apart from an
// ES-module wrapper, so this tool reads a register exactly as PWLBreports does.
//
//   node scripts/sync-register.mjs /path/to/pwlbtoday-tms
//
// Then run `npm test`: tests/register.test.ts checks the schedules against the template.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const tms = process.argv[2];
if (!tms) { console.error('Usage: node scripts/sync-register.mjs /path/to/pwlbtoday-tms'); process.exit(1); }
const src = (f) => readFileSync(join(tms, 'register', f), 'utf8');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const head = (file, hash) => `// @ts-nocheck\n/* VENDORED from pwlbtoday-tms/register/${file} (sha256 ${hash}) by scripts/sync-register.mjs.\n   Do not edit here: change it there and re-sync, so both tools read registers identically. */\n`;

const xl = src('src/xlsx.js');
writeFileSync('src/lib/register/vendor/xlsx.js', head('src/xlsx.js', sha(xl)) + xl.replace(/if\s*\(typeof module[^\n]*\n?/g, '') + '\nexport default XL;\n');
const model = src('src/model.js');
writeFileSync('src/lib/register/vendor/model.js', head('src/model.js', sha(model)) + "import XL from './xlsx.js';\n" + model.replace(/if\s*\(typeof module[^\n]*\n?/g, '') + '\nexport default REG;\n');
copyFileSync(join(tms, 'register', 'template', 'pwlb-register.xlsx'), 'public/templates/pwlb-register.xlsx');
copyFileSync(join(tms, 'register', 'template', 'pwlb-register.xlsx'), 'tests/fixtures/pwlb-register.xlsx');
console.log(`Synced: xlsx.js ${sha(xl)}, model.js ${sha(model)}, template copied.`);
