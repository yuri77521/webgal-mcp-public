import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { open, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateRelativePath } from '../filesystem.js';
import { fileFingerprint, within, type Tree } from './tree.js';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
};

export interface LocalPreview {
  server: Server;
  url: string;
}

export async function openPreview(root: string, snapshot: Tree): Promise<LocalPreview> {
  const server = createServer(async (request, response) => {
    if (request.headers.host !== host || request.headers['sec-fetch-site'] === 'cross-site') {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const rawPath = (request.url ?? '').split('?')[0];
      if (!rawPath.startsWith('/')) throw new Error('Missing request path');
      const relative = validateRelativePath(decodeURIComponent(rawPath.slice(1)) || 'index.html');
      const expected = snapshot.get(relative)?.fingerprint;
      if (!expected) throw new Error('File is not in the verified snapshot');
      const target = path.join(root, relative);
      const diskPath = await realpath(target);
      if (!within(root, diskPath) || path.relative(diskPath, target) !== '') throw new Error('Invalid path');
      const metadata = await lstat(target, { bigint: true });
      if (!metadata.isFile() || fileFingerprint(metadata) !== expected) throw new Error('Invalid file');
      file = await open(target, 'r');
      const opened = await file.stat({ bigint: true });
      if (!opened.isFile() || fileFingerprint(opened) !== expected) throw new Error('File changed');
      const size = Number(opened.size);
      let start = 0;
      let end = size - 1;
      const range = request.headers.range;
      if (range !== undefined) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        start = match ? Number(match[1]) : size;
        if (match?.[2]) end = Math.min(end, Number(match[2]));
        if (!Number.isSafeInteger(start) || start > end) {
          response.writeHead(416, { 'Content-Range': 'bytes */' + size }).end();
          return;
        }
        response.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
      }
      response.writeHead(range === undefined ? 200 : 206, {
        'Content-Type': contentTypes[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"
      });
      if (request.method === 'HEAD' || size === 0) {
        response.end();
        return;
      }
      const stream = file.createReadStream({ start, end });
      file = undefined; // Stream closes its own descriptor.
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(404).end();
    } finally {
      await file?.close().catch(() => {});
    }
  });
  let host = '';
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback preview did not bind.');
  host = '127.0.0.1:' + address.port;
  return { server, url: 'http://' + host + '/' };
}
