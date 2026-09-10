import { execFileSync } from 'node:child_process';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { ValidationError, validateRunRequest } from './validate.js';
import { runYapProgram } from './runner.js';

if (!fs.existsSync(config.yapBin)) {
  console.error(
    `yap binary not found at "${config.yapBin}". Set YAP_BIN to the path of the yap executable.`,
  );
  process.exit(1);
}
if (!fs.existsSync(path.join(config.yapHome, 'components'))) {
  console.error(
    `YAP_HOME ("${config.yapHome}") has no "components/" directory. ` +
      'Set YAP_HOME to a yap checkout/install that has been built (components/, modules/, lib/).',
  );
  process.exit(1);
}
if (config.sandboxEnabled) {
  try {
    execFileSync(config.bwrapBin, ['--version'], { stdio: 'ignore' });
  } catch {
    console.error(
      `Sandboxing is enabled but "${config.bwrapBin}" isn't runnable. ` +
        'Enter the project dev shell first (`nix develop` or `nix-shell`), or set YAP_SANDBOX=0 ' +
        'to run without sandboxing (not recommended: yap compiles+runs arbitrary code).',
    );
    process.exit(1);
  }
}

const app = express();
app.use(express.json({ limit: config.jsonBodyLimit }));

app.post('/run', async (req, res) => {
  let request;
  try {
    request = validateRunRequest(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ was_ok: false, errors: [err.message] });
      return;
    }
    throw err;
  }

  try {
    const result = await runYapProgram(request);
    res.status(200).json(result);
  } catch (err) {
    console.error('Unexpected error running yap program:', err);
    res.status(500).json({ was_ok: false, errors: ['Internal error while running the program.'] });
  }
});

// Malformed JSON bodies, oversized payloads, etc.
app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(400).json({ was_ok: false, errors: [err.message || 'Invalid request.'] });
});

app.listen(config.port, () => {
  console.log(`web-yap-runner listening on port ${config.port} (yap: ${config.yapBin})`);
});
