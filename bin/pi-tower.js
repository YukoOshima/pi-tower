#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import module from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

function stripTypes(source) {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning).includes('stripTypeScriptTypes')) return;
    emitWarning.call(process, warning, ...rest);
  };
  try {
    return module.stripTypeScriptTypes(source);
  } finally {
    process.emitWarning = emitWarning;
  }
}

if (/[\\/]node_modules[\\/]/.test(fileURLToPath(root)) || !process.features.typescript) {
  if (typeof module.registerHooks !== 'function' || typeof module.stripTypeScriptTypes !== 'function') {
    process.stderr.write(`pi-tower: Node ${process.version} cannot load the pi-tower TypeScript sources — use Node 22.19 or newer\n`);
    process.exit(4);
  }
  module.registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith(root.href) || !url.endsWith('.ts')) return nextLoad(url, context);
      return { format: 'module', source: stripTypes(readFileSync(new URL(url), 'utf8')), shortCircuit: true };
    },
  });
}

const { main } = await import('../src/headless/cli.ts');
process.exitCode = await main(process.argv.slice(2));
