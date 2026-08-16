/**
 * Persistence worker — keeps the client alive while the tab is hidden.
 *
 * The engine tick is driven by Pixi's requestAnimationFrame ticker, and
 * browsers pause rAF when the page is hidden. That freezes `engine.tick()`
 * (timeouts, delays, net-message draining, frame scripts) and lets the server
 * drop the session. This module gives the engine a dedicated Worker that:
 *
 *  - owns the Multiuser WebSocket (worker IO/timers are exempt from the
 *    hidden-page throttling that hits the main thread), and
 *  - runs a 1 Hz clock while the page is hidden, posting `tick` messages that
 *    the engine uses to keep advancing FULL game logic (no rendering).
 *
 * The main thread keeps all game state; the worker holds only the socket and
 * the hidden-clock. When the page becomes visible the rAF ticker takes back
 * over and the worker's clock stops, so nothing double-ticks.
 *
 * The demo builds a single self-contained iife (spark.js), so the worker is
 * created from an inline Blob of this source rather than a separate chunk.
 *//** The worker's full program. Plain JS on purpose: it ships as a string and
 *  has no imports. */
export const PERSIST_WORKER_SOURCE = `
'use strict';
// One socket per Multiuser connection url — the client runs BOTH the main
// info connection (connection.info.*) and the MUS connection
// (connection.mus.*), each its own WebSocket, so the worker must not
// collapse them into a single socket.
var sockets = {};
var hidden = false;
var tickTimer = null;

function post(msg) { self.postMessage(msg); }

function openSocket(url) {
  closeSocket(url);
  try {
    var ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () { post({ type: 'ws-open', url: url }); };
    ws.onmessage = function (ev) {
      var d = ev.data;
      if (d instanceof ArrayBuffer) {
        // Structured-clone copies the buffer (no transfer list), so a
        // reconnect never races a detached buffer on the main thread.
        post({ type: 'ws-data', url: url, bytes: d });
      } else if (ArrayBuffer.isView(d)) {
        var b = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
        post({ type: 'ws-data', url: url, bytes: b });
      } else if (typeof d === 'string') {
        post({ type: 'ws-text', url: url, text: d });
      }
    };
    ws.onclose = function () { sockets[url] = null; post({ type: 'ws-close', url: url }); };
    ws.onerror = function (e) {
      post({ type: 'ws-error', url: url, message: e && e.message ? e.message : String(e) });
    };
    sockets[url] = ws;
  } catch (e) {
    post({ type: 'ws-error', url: url, message: String(e) });
  }
}

function closeSocket(url) {
  var ws = sockets[url];
  if (!ws) return;
  try {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.close();
  } catch (e) { /* already closed */ }
  sockets[url] = null;
}

function scheduleTicks() {
  if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
  if (hidden) {
    tickTimer = setInterval(function () { post({ type: 'tick' }); }, 1000);
  }
}

self.onmessage = function (ev) {
  var msg = ev.data;
  switch (msg.type) {
    case 'connect': openSocket(msg.url); break;
    case 'send': {
      var ws = sockets[msg.url];
      if (ws) { try { ws.send(msg.bytes); } catch (e) { /* noop */ } }
      break;
    }
    case 'close': closeSocket(msg.url); break;
    case 'hidden': hidden = !!msg.hidden; scheduleTicks(); break;
  }
};
`;

/** Messages the worker posts to the main thread. */
export type PersistWorkerMsg =
  | { type: 'ws-open'; url: string }
  | { type: 'ws-close'; url: string }
  | { type: 'ws-error'; url: string; message: string }
  | { type: 'ws-data'; url: string; bytes: ArrayBuffer }
  | { type: 'ws-text'; url: string; text: string }
  | { type: 'tick' };

/** The engine-facing surface of a persistence worker. Tests implement this
 *  with a fake so the routing logic runs without a real Worker. */
export interface PersistWorkerLike {
  /** Open (or re-open) the WebSocket at url. */
  connect(url: string): void;
  /** Ship bytes to the worker's socket at url (kepler wants binary frames).
   *  Multiple Multiuser connections live in the worker simultaneously (info +
   *  mus), so sends are routed by url. */
  send(url: string, bytes: Uint8Array): void;
  /** Close the socket at url. */
  closeSocket(url: string): void;
  /** Start/stop the 1 Hz hidden-clock. */
  setHidden(hidden: boolean): void;
  /** Register the engine's inbound message handler (single slot). */
  onMessage(cb: (msg: PersistWorkerMsg) => void): void;
  /** Tear the worker down. */
  terminate(): void;
}

/** Real Blob-worker implementation. The constructor is a no-op with
 *  `available = false` in headless environments (Node, strict CSP) — the
 *  embed host skips wiring then and the engine keeps its inline socket. */
export class PersistWorker implements PersistWorkerLike {
  private worker: Worker | null = null;
  private cb: ((msg: PersistWorkerMsg) => void) | null = null;
  /** False in Node/headless/CSP-blocked environments — skip wiring then. */
  readonly available: boolean;

  constructor() {
    let available = false;
    try {
      if (typeof Worker !== 'function' || typeof Blob === 'undefined') throw new Error('no worker env');
      const blob = new Blob([PERSIST_WORKER_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const w = new Worker(url);
      w.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as PersistWorkerMsg;
        if (msg && typeof msg === 'object') this.cb?.(msg);
      };
      this.worker = w;
      available = true;
    } catch {
      this.worker = null;
      available = false;
    }
    this.available = available;
  }

  connect(url: string): void {
    this.worker?.postMessage({ type: 'connect', url });
  }

  send(url: string, bytes: Uint8Array): void {
    this.worker?.postMessage({ type: 'send', url, bytes });
  }

  closeSocket(url: string): void {
    this.worker?.postMessage({ type: 'close', url });
  }

  setHidden(hidden: boolean): void {
    this.worker?.postMessage({ type: 'hidden', hidden });
  }

  onMessage(cb: (msg: PersistWorkerMsg) => void): void {
    this.cb = cb;
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
