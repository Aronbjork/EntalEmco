/* serial.js — Web Serial transport (Chrome / Edge). Sends program text line by line
 * with optional per-character and per-line delays, and listens for anything the lathe sends.
 */
(function (global) {
  'use strict';
  const Serial = {
    supported: typeof navigator !== 'undefined' && 'serial' in navigator,
    port: null, reader: null, reading: false, onData: null, onStatus: null, sending: false, abort: false,

    status(s) { if (this.onStatus) this.onStatus(s); },

    async connect(cfg) {
      if (!this.supported) throw new Error('Web Serial is not available. Use Chrome or Edge, and open the page from a file or https:// (not plain http on another machine).');
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: cfg.baud, dataBits: cfg.dataBits, stopBits: cfg.stopBits, parity: cfg.parity, flowControl: cfg.flow === 'hardware' ? 'hardware' : 'none', bufferSize: 4096 });
      this.port = port;
      try { await port.setSignals({ dataTerminalReady: !!cfg.dtr, requestToSend: !!cfg.rts }); } catch (e) { /* some adapters refuse */ }
      this.status('connected');
      this.startReading();
      return port;
    },

    async disconnect() {
      this.abort = true;
      this.reading = false;
      try { if (this.reader) { await this.reader.cancel(); } } catch (e) { /* ignore */ }
      try { if (this.port) await this.port.close(); } catch (e) { /* ignore */ }
      this.port = null; this.reader = null;
      this.status('disconnected');
    },

    async startReading() {
      if (!this.port || !this.port.readable || this.reading) return;
      this.reading = true;
      const decoder = new TextDecoder('latin1');
      while (this.reading && this.port && this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value && this.onData) this.onData(decoder.decode(value, { stream: true }), value);
          }
        } catch (e) { if (this.onData) this.onData('', null, e); }
        finally { try { this.reader.releaseLock(); } catch (e) { /* ignore */ } }
        if (!this.reading) break;
        await new Promise(r => setTimeout(r, 200));
      }
      this.reading = false;
    },

    /** Send text. cfg: { charDelay (ms), lineDelay (ms) }. onProgress(sentLines, totalLines). */
    async send(text, cfg, onProgress) {
      if (!this.port || !this.port.writable) throw new Error('Not connected.');
      if (this.sending) throw new Error('Already sending.');
      this.sending = true; this.abort = false;
      const writer = this.port.writable.getWriter();
      const enc = new TextEncoder();
      const eol = text.includes('\r\n') ? '\r\n' : (text.includes('\r') ? '\r' : '\n');
      const lines = text.split(eol); if (lines[lines.length - 1] === '') lines.pop();
      try {
        for (let i = 0; i < lines.length; i++) {
          if (this.abort) throw new Error('Transfer cancelled.');
          const line = lines[i] + eol;
          if (cfg.charDelay > 0) {
            for (const ch of line) { await writer.write(enc.encode(ch)); await sleep(cfg.charDelay); }
          } else await writer.write(enc.encode(line));
          if (onProgress) onProgress(i + 1, lines.length);
          if (cfg.lineDelay > 0) await sleep(cfg.lineDelay);
        }
      } finally { writer.releaseLock(); this.sending = false; }
    },

    cancel() { this.abort = true; }
  };
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  global.Serial = Serial;
})(typeof window !== 'undefined' ? window : globalThis);
