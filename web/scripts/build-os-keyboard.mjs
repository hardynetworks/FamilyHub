// Bundles src/lib/touchKeyboard.ts as a plain script for FamilyHub OS's on-device setup screen.
//   npm run build:os-keyboard
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../src/lib/touchKeyboard.ts');
const out = resolve(here, '../../os/common/files/usr/share/familyhub/setup/keyboard.js');
const { outputText } = ts.transpileModule(readFileSync(src, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, removeComments: false },
});
writeFileSync(
  out,
  `// Generated from web/src/lib/touchKeyboard.ts by web/scripts/build-os-keyboard.mjs. Don't edit by hand.\n` +
    `(function () {\nvar exports = {};\n${outputText}\nwindow.FamilyHubKeyboard = exports;\n})();\n`,
);
console.log('Wrote', out);
