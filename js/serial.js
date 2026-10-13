/* serial.js — Web Serial transport (Chrome / Edge only).
 *
 * The Compact 5 talks plain ASCII at 300 baud. Mike's Free Interface uses
 * 8 data bits, 1 stop bit, no parity and no handshake, and those are our defaults.
 * The old controller has no input buffer to speak of, so the program is sent one line
 * at a time with an optional pause between lines (and optionally between characters).
 * Whatever the lathe sends back is read continuously and handed to `onData`, which the
 * UI shows in the log; that is also how a program is received from the lathe.
 */
(function (global) {
  'use strict';
  const Serial = {
    supported: typeof navigator !== 'undefined' && 'serial' in navigator,
    port: null, reader: null, reading: false, onData: null, onStatus: null, sending: false, abort: false,

    /** Tell the UI about a state change ('connected' / 'disconnected'). */
    status(s) { if (this.onStatus) this.onStatus(s); },

    /**
     * Ask the browser for a port (shows the port picker) and open it with the given
     * settings { baud, dataBits, stopBits, parity, flow, dtr, rts }. DTR/RTS are
     * asserted when requested because some cables are powered from those lines.
     * Reading starts immediately so incoming data is never missed.
     */
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

    /** Stop reading, abort any transfer and close the port. */
    async disconnect() {
      this.abort = true;
      this.reading = false;
      try { if (this.reader) { await this.reader.cancel(); } } catch (e) { /* ignore */ }
      try { if (this.port) await this.port.close(); } catch (e) { /* ignore */ }
      this.port = null; this.reader = null;
      this.status('disconnected');
    },

    /**
     * Background read loop. Bytes are decoded as Latin-1 (the lathe only sends ASCII)
     * and passed to onData(text, bytes). Read errors (e.g. a cable pulled out) are
     * reported through the same callback and the loop retries while still connected.
     */
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

    /**
     * Send program text line by line. The line ending already present in the text is
     * preserved. cfg: { charDelay (ms between characters, 0 = whole line at once),
     * lineDelay (ms after each line) }. onProgress(sentLines, totalLines) is called
     * after every line. Throws 'Transfer cancelled.' if cancel() was called.
     */
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

    /** Request that a running send() stops after the current line. */
    cancel() { this.abort = true; }
  };
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  global.Serial = Serial;
})(typeof window !== 'undefined' ? window : globalThis);
