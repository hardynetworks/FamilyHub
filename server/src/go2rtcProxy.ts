/**
 * WebSocket half of the go2rtc player proxy: /go2rtc/api/ws?src=cam_<id>
 * Only signed-in users, only same-origin pages, and only streams FamilyHub registered itself.
 */
import type { RequestHandler } from 'express';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import WebSocket, { WebSocketServer } from 'ws';
import { UserRow } from './auth';
import { one } from './db';
import { camerasConfig, isRegisteredStream } from './protect';

export function attachGo2rtcProxy(server: Server, sessionMiddleware: RequestHandler) {
  const wss = new WebSocketServer({ noServer: true });

  const reject = (socket: Duplex, code: number, text: string) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/go2rtc/api/ws') return reject(socket, 404, 'Not Found');
    const src = url.searchParams.get('src') ?? '';
    if (!isRegisteredStream(src)) return reject(socket, 404, 'Not Found');

    // Same-origin check (defence against cross-site WebSocket hijacking).
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    if (origin && host && new URL(origin).host !== String(host).split(',')[0].trim()) return reject(socket, 403, 'Forbidden');

    // Reuse the Express session to authenticate the upgrade request.
    sessionMiddleware(req as any, {} as any, async () => {
      const userId = (req as any).session?.userId;
      const user = userId ? await one<UserRow>('select * from users where id = $1 and can_login', [userId]).catch(() => null) : null;
      if (!user) return reject(socket, 401, 'Unauthorized');

      wss.handleUpgrade(req, socket, head, (client) => {
        const upstreamUrl = camerasConfig().go2rtcUrl.replace(/^http/i, 'ws') + `/api/ws?src=${encodeURIComponent(src)}`;
        const upstream = new WebSocket(upstreamUrl);
        const pending: { data: WebSocket.RawData; binary: boolean }[] = [];

        client.on('message', (data, binary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
          else pending.push({ data, binary });
        });
        upstream.on('open', () => {
          for (const m of pending.splice(0)) upstream.send(m.data, { binary: m.binary });
        });
        upstream.on('message', (data, binary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
        });
        const closeBoth = () => {
          if (client.readyState <= WebSocket.OPEN) client.close();
          if (upstream.readyState <= WebSocket.OPEN) upstream.terminate();
        };
        client.on('close', closeBoth);
        client.on('error', closeBoth);
        upstream.on('close', closeBoth);
        upstream.on('error', closeBoth);
      });
    });
  });
}
