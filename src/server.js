import { execFileSync } from 'node:child_process';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { rateLimit } from 'express-rate-limit';
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
// Trust exactly one upstream hop (cloudflared, the only proxy in front of
// this process) so the rate limiter keys off the real client IP from
// X-Forwarded-For. `true` (trust any number of hops) is unsafe here —
// express-rate-limit refuses to start with it, since it'd let a client
// spoof its own rate-limit key.
app.set('trust proxy', 1);

// The caller is a static site calling this directly from browser JS, so a
// CORS allowlist is what actually applies here (unlike an API key, which
// would just be public too). This only affects browser-enforced requests —
// it doesn't stop a direct curl/script — so it's one layer among several,
// not the real access control.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: config.jsonBodyLimit }));

app.use(
  '/run',
  rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { was_ok: false, errors: ['Too many requests, slow down.'] },
  }),
);

// Each request compiles and runs native code — real CPU/memory cost no
// matter how many distinct IPs it's spread across — so cap how many run
// concurrently regardless of the per-IP rate limit above.
let inFlight = 0;

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

  if (inFlight >= config.maxConcurrentRuns) {
    res.status(503).json({ was_ok: false, errors: ['Server busy, try again shortly.'] });
    return;
  }

  inFlight++;
  try {
    const result = await runYapProgram(request);
    res.status(200).json(result);
  } catch (err) {
    console.error('Unexpected error running yap program:', err);
    res.status(500).json({ was_ok: false, errors: ['Internal error while running the program.'] });
  } finally {
    inFlight--;
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
