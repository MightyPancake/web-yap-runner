import path from 'node:path';
import { config } from './config.js';

export class ValidationError extends Error {}

// Only compiler/backend/frontend tuning flags are allowed through. Anything
// that changes the compile mode (-o, -g, -r, -c, -C, -h, -s) or targets an
// arbitrary output/component path is rejected: -o is meaningless here (we
// always choose the output path ourselves), -g switches to C-binding
// generation instead of compiling a program, -s lets a caller pick an
// arbitrary "components/<name>/lib*.so" to dlopen (path traversal into
// arbitrary shared libraries), and -bc emits C instead of a binary (caught
// separately after compilation, since it exits 0 with no binary produced).
//
// This is an exact-match allowlist of complete flag tokens, deliberately NOT a
// value pattern. An earlier version allowed any metacharacter-free value after
// -b/-f/--backend-flag=/--frontend-flag=, but yap forwards those verbatim to
// the backend C compiler, so that still admitted gcc flags that are themselves
// code-execution or file primitives — -fplugin=<so>, -specs=<file>,
// -wrapper=<prog>, -B<path>, -o<path>, -imacros<file> — none of which contain
// shell syntax. (The raw-shell forwarding is also why `-bf=$(cat${IFS}/…)`
// worked at all.) A public playground only needs to pick an optimization level
// and the backend C compiler, so only those exact tokens are accepted; anything
// that forwards an arbitrary flag to gcc is gone.
const ALLOWED_FLAGS = new Set([
  '-bO0',
  '-bO1',
  '-bO2',
  '-bO3',
  '-bOs',
  '-bcc=gcc',
  '-bcc=clang',
  '-bcc=tcc',
]);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Every file is written under one temp root; reject anything that could
// resolve outside of it (absolute paths, `..` segments).
function sanitizeRelativePath(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ValidationError('Each file needs a non-empty string "name".');
  }
  if (path.isAbsolute(name)) {
    throw new ValidationError(`File name must be relative: "${name}"`);
  }
  const normalized = path.normalize(name);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) {
    throw new ValidationError(`File name may not escape the project directory: "${name}"`);
  }
  return normalized;
}

export function validateRunRequest(body) {
  if (!isPlainObject(body)) {
    throw new ValidationError('Request body must be a JSON object.');
  }

  const { files, input, flags, entry } = body;

  if (!Array.isArray(files) || files.length === 0) {
    throw new ValidationError('"files" must be a non-empty array.');
  }
  if (files.length > config.maxFiles) {
    throw new ValidationError(`"files" may contain at most ${config.maxFiles} entries.`);
  }

  const seen = new Set();
  const normalizedFiles = files.map((f) => {
    if (!isPlainObject(f)) {
      throw new ValidationError('Each entry in "files" must be an object with "name" and "content".');
    }
    const name = sanitizeRelativePath(f.name);
    if (typeof f.content !== 'string') {
      throw new ValidationError(`File "${name}" needs a string "content".`);
    }
    if (seen.has(name)) {
      throw new ValidationError(`Duplicate file name: "${name}"`);
    }
    seen.add(name);
    return { name, content: f.content };
  });

  let entryName;
  if (entry !== undefined) {
    if (typeof entry !== 'string') {
      throw new ValidationError('"entry" must be a string file name.');
    }
    const normalizedEntry = path.normalize(entry);
    if (!seen.has(normalizedEntry)) {
      throw new ValidationError(`"entry" ("${entry}") does not match any file in "files".`);
    }
    entryName = normalizedEntry;
  } else {
    const mainFile = normalizedFiles.find((f) => f.name === 'main.yp');
    entryName = mainFile ? mainFile.name : normalizedFiles[0].name;
  }

  let stdin = '';
  if (input !== undefined) {
    if (typeof input !== 'string') {
      throw new ValidationError('"input" must be a string.');
    }
    if (Buffer.byteLength(input, 'utf8') > config.maxInputBytes) {
      throw new ValidationError(`"input" exceeds the ${config.maxInputBytes}-byte limit.`);
    }
    stdin = input;
  }

  let normalizedFlags = [];
  if (flags !== undefined) {
    if (!Array.isArray(flags)) {
      throw new ValidationError('"flags" must be an array of strings.');
    }
    if (flags.length > config.maxFlags) {
      throw new ValidationError(`"flags" may contain at most ${config.maxFlags} entries.`);
    }
    for (const flag of flags) {
      if (typeof flag !== 'string') {
        throw new ValidationError('Every entry in "flags" must be a string.');
      }
      if (!ALLOWED_FLAGS.has(flag)) {
        throw new ValidationError(
          `Flag not allowed: "${flag}". Accepted flags: optimization level ` +
            '(-bO0, -bO1, -bO2, -bO3, -bOs) or backend C compiler ' +
            '(-bcc=gcc, -bcc=clang, -bcc=tcc).',
        );
      }
    }
    normalizedFlags = flags;
  }

  return { files: normalizedFiles, entry: entryName, input: stdin, flags: normalizedFlags };
}
