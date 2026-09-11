import { readFile } from 'node:fs/promises';

export interface NodeCliIO {
  readText(path: string): Promise<string>;
  out(message: string): void;
  err(message: string): void;
}

export const nodeCliIO: NodeCliIO = {
  readText: (path) => readFile(path, 'utf8'),
  out: (message) => console.log(message),
  err: (message) => console.error(message),
};
