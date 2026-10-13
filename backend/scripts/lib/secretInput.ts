import readline from 'readline/promises';
import type { Readable, Writable } from 'stream';

/**
 * Terminal input for the admin command-line utility. Passwords are read either from a hidden
 * prompt (raw mode, nothing echoed) or from piped standard input — never from arguments.
 */

export class InputCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'InputCancelled';
  }
}

export interface RawTtyInput extends Readable {
  isTTY?: boolean;
  setRawMode(mode: boolean): unknown;
}

/** Reads one line without echoing it. Backspace edits; Ctrl-C or Ctrl-D cancels. */
export function readHidden(prompt: string, input: RawTtyInput, output: Writable): Promise<string> {
  output.write(prompt);
  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error: Error | null) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish(null);
        if (char === '\u0003' || char === '\u0004') return finish(new InputCancelled());
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ') value += char; // other control characters are ignored
      }
    };
    input.on('data', onData);
  });
}

/** Reads one visible line (used for the confirmation step). */
export async function readLine(prompt: string, input: Readable, output: Writable): Promise<string> {
  const rl = readline.createInterface({ input, output, terminal: false });
  output.write(prompt);
  try {
    const line = await new Promise<string | null>((resolve) => {
      rl.once('line', resolve);
      rl.once('close', () => resolve(null));
    });
    if (line === null) throw new InputCancelled();
    return line;
  } finally {
    rl.close();
  }
}

/**
 * Reads a password piped to standard input (e.g. from a secret manager), like `docker login
 * --password-stdin`. Exactly one trailing line break is removed; nothing else is trimmed.
 */
export async function readPasswordFromStdin(input: Readable & { isTTY?: boolean }): Promise<string> {
  if (input.isTTY) throw new Error('--password-stdin expects the password to be piped in, not typed');
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  let text = Buffer.concat(chunks).toString('utf8');
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n')) text = text.slice(0, -1);
  if (/[\r\n]/.test(text)) throw new Error('--password-stdin expects a single line');
  if (text.length === 0) throw new Error('No password received on standard input');
  return text;
}
