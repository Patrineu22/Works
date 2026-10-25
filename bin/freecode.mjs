#!/usr/bin/env node
// FreeCode launcher - keeps the shebang on a tiny shim so Windows npm shims work.
import { main } from '../src/cli.mjs';

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    process.stderr.write(`\n✖ ${err?.stack || err?.message || err}\n`);
    process.exitCode = 1;
  });
