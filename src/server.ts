import { createServer, type IncomingMessage } from 'node:http';
import type { SunnyConfig } from './config/index.js';
import type { Gateway } from './gateway/types.js';
import { logger } from './logger.js';

const log = logger('server');

/**
 * HTTP webhook listener for inbound iMessage events (messaging-gateway D-MG7,
 * task 2.2). Sendblue POSTs inbound messages here; in dev the
 * `devbox` skill exposes this port at a public URL (task 1.3). In prod the home
 * server's own reachable endpoint replaces the devbox URL (D-PS6).
 */
export function startHttpServer(config: SunnyConfig, gateway: Gateway): void {
  // Honor $PORT when set (devbox/systemd controls it); else config (D-PS5).
  const port = process.env.PORT ? Number(process.env.PORT) : config.server.port;
  const { webhookPath } = config.server;

  const server = createServer((req, res) => {
    void handle(req).then(
      ({ status, headers, body }) => {
        res.writeHead(status, headers);
        res.end(body);
      },
      (err) => {
        log.error('request handler crashed', { err: String(err) });
        res.writeHead(500);
        res.end('internal error');
      },
    );
  });

  async function handle(
    req: IncomingMessage,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer | string }> {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' };
    }
    if (url.pathname !== webhookPath) {
      return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' };
    }

    const request = await toWebRequest(req, url);
    const response = await gateway.handleWebhook(request);
    const body = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
    };
  }

  server.listen(port, () => {
    log.info(`webhook listener up on :${port}${webhookPath}`, { health: `:${port}/health` });
  });
}

/** Convert a Node IncomingMessage into a Web Request for the Chat SDK webhook. */
async function toWebRequest(req: IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }

  const method = req.method ?? 'GET';
  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks);
  }

  return new Request(url, {
    method,
    headers,
    body: body && body.length > 0 ? body : undefined,
  });
}
