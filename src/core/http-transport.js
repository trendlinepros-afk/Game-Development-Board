'use strict';
/**
 * Minimal MCP Streamable HTTP transport (JSON responses, no SSE streams).
 * Bound to 127.0.0.1 only. Endpoint: POST http://127.0.0.1:<port>/mcp
 */
const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = 47821;

function isLocalOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return origin === 'null' ? false : false;
  }
}

function startHttpServer(mcp, { port = DEFAULT_PORT, host = '127.0.0.1', log = () => {} } = {}) {
  const sessions = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);
    res.setHeader('Cache-Control', 'no-store');

    if (!isLocalOrigin(req.headers.origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden origin');
      return;
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'game-development-board', version: mcp.version }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found. MCP endpoint is /mcp');
      return;
    }

    if (req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id'];
      if (sid) sessions.delete(sid);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET') {
      // We don't offer a server-initiated SSE stream.
      res.writeHead(405, { Allow: 'POST, DELETE' });
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' });
      res.end();
      return;
    }

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const messages = Array.isArray(body) ? body : [body];
      const responses = [];
      let initSession = null;
      for (const m of messages) {
        if (m && m.method === 'initialize') {
          initSession = crypto.randomUUID();
          sessions.add(initSession);
        }
        try {
          const r = await mcp.handle(m);
          if (r) responses.push(r);
        } catch (err) {
          log('mcp handler error', err);
          responses.push({ jsonrpc: '2.0', id: m && m.id, error: { code: -32603, message: String(err.message || err) } });
        }
      }
      const headers = { 'Content-Type': 'application/json' };
      if (initSession) headers['Mcp-Session-Id'] = initSession;
      if (!responses.length) {
        res.writeHead(202, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { startHttpServer, DEFAULT_PORT };
