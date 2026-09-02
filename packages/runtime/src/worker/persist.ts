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

export type PersistWorkerMsg =
  | { type: 'ws-open'; url: string }
  | { type: 'ws-close'; url: string }
  | { type: 'ws-error'; url: string; message: string }
  | { type: 'ws-data'; url: string; bytes: ArrayBuffer }
  | { type: 'ws-text'; url: string; text: string }
  | { type: 'tick' };

export interface PersistWorkerLike {
  connect(url: string): void;
  send(url: string, bytes: Uint8Array): void;
  closeSocket(url: string): void;
  setHidden(hidden: boolean): void;
  onMessage(cb: (msg: PersistWorkerMsg) => void): void;
  terminate(): void;
}

export class PersistWorker implements PersistWorkerLike {
  private worker: Worker | null = null;
  private cb: ((msg: PersistWorkerMsg) => void) | null = null;
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
