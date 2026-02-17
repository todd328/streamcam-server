/**
 * StreamCam WebSocket Signaling Server
 * ─────────────────────────────────────
 * Handles WebRTC signaling between iPhone camera and dashboard.
 * No media passes through here — only offer/answer/ICE metadata.
 *
 * Deploy: Railway, Render, Fly.io, or run locally with:
 *   node server.js
 *
 * Required env vars (optional overrides):
 *   PORT          — defaults to 3000
 *   ALLOWED_ORIGIN — CORS origin, defaults to * (lock this down in prod)
 */

const http  = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT   = process.env.PORT || 3000;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ── In-memory session store ──────────────────────────────────────────────────
// sessions[pin] = { camera: WebSocket | null, dashboard: WebSocket | null }
const sessions = {};

function getOrCreateSession(pin) {
  if (!sessions[pin]) sessions[pin] = { camera: null, dashboard: null };
  return sessions[pin];
}

function cleanSession(pin) {
  const s = sessions[pin];
  if (!s) return;
  if (!s.camera && !s.dashboard) {
    delete sessions[pin];
    console.log(`[${pin}] Session cleaned up`);
  }
}

// ── HTTP server (health check + CORS preflight) ──────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/health') {
    const activeSessions = Object.keys(sessions).length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', activeSessions, uptime: process.uptime() }));
    return;
  }

  if (req.url === '/sessions') {
    // Returns list of active camera PINs (so dashboard can validate)
    const active = Object.entries(sessions)
      .filter(([, s]) => s.camera !== null)
      .map(([pin]) => pin);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pins: active }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[WS] New connection from ${ip}`);

  let role = null; // 'camera' | 'dashboard'
  let pin  = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return ws.send(JSON.stringify({ type: 'error', msg: 'Invalid JSON' })); }

    const { type } = msg;

    // ── REGISTER as camera broadcaster ──────────────────────────────────────
    if (type === 'camera:register') {
      pin  = String(msg.pin);
      role = 'camera';
      const session = getOrCreateSession(pin);

      if (session.camera && session.camera.readyState === WebSocket.OPEN) {
        return ws.send(JSON.stringify({ type: 'error', msg: 'PIN already in use by another camera' }));
      }

      session.camera = ws;
      console.log(`[${pin}] Camera registered`);
      ws.send(JSON.stringify({ type: 'camera:registered', pin }));

      // Notify any waiting dashboard
      if (session.dashboard?.readyState === WebSocket.OPEN) {
        session.dashboard.send(JSON.stringify({ type: 'camera:online', pin }));
      }
      return;
    }

    // ── REGISTER as dashboard viewer ────────────────────────────────────────
    if (type === 'dashboard:join') {
      pin  = String(msg.pin);
      role = 'dashboard';
      const session = getOrCreateSession(pin);
      session.dashboard = ws;
      console.log(`[${pin}] Dashboard joined`);

      if (session.camera?.readyState === WebSocket.OPEN) {
        // Camera already online — tell dashboard and prompt camera to send offer
        ws.send(JSON.stringify({ type: 'camera:online', pin }));
        session.camera.send(JSON.stringify({ type: 'dashboard:ready', pin }));
      } else {
        ws.send(JSON.stringify({ type: 'camera:offline', pin }));
      }
      return;
    }

    // ── RELAY: camera sends offer → dashboard ────────────────────────────────
    if (type === 'offer') {
      const session = sessions[pin];
      if (!session?.dashboard) return;
      console.log(`[${pin}] Relaying offer → dashboard`);
      session.dashboard.send(JSON.stringify({ type: 'offer', offer: msg.offer }));
      return;
    }

    // ── RELAY: dashboard sends answer → camera ───────────────────────────────
    if (type === 'answer') {
      const session = sessions[pin];
      if (!session?.camera) return;
      console.log(`[${pin}] Relaying answer → camera`);
      session.camera.send(JSON.stringify({ type: 'answer', answer: msg.answer }));
      return;
    }

    // ── RELAY: ICE candidates (bidirectional) ────────────────────────────────
    if (type === 'ice') {
      const session = sessions[pin];
      if (!session) return;
      const target = role === 'camera' ? session.dashboard : session.camera;
      if (target?.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ type: 'ice', candidate: msg.candidate }));
      }
      return;
    }

    ws.send(JSON.stringify({ type: 'error', msg: `Unknown message type: ${type}` }));
  });

  ws.on('close', () => {
    if (!pin) return;
    const session = sessions[pin];
    if (!session) return;

    if (role === 'camera') {
      console.log(`[${pin}] Camera disconnected`);
      session.camera = null;
      if (session.dashboard?.readyState === WebSocket.OPEN) {
        session.dashboard.send(JSON.stringify({ type: 'camera:offline', pin }));
      }
    }

    if (role === 'dashboard') {
      console.log(`[${pin}] Dashboard disconnected`);
      session.dashboard = null;
    }

    cleanSession(pin);
  });

  ws.on('error', (err) => {
    console.error(`[WS error] ${pin || 'unknown'}: ${err.message}`);
  });
});

// ── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n🎥 StreamCam Signaling Server`);
  console.log(`   Listening on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Active sessions: http://localhost:${PORT}/sessions\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down...');
  wss.close(() => httpServer.close(() => process.exit(0)));
});
