"use strict";
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const baileys = require('@whiskeysockets/baileys');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUTH_ROOT = process.env.AUTH_DIR || path.join(__dirname, 'kingmd_sessions');
const makeWASocket = baileys.default || baileys.makeWASocket;
const useMultiFileAuthState = baileys.useMultiFileAuthState;
const sessions = new Map();
const pending = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'KINGMD254 pairing' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'KINGMD254 pairing' }));

function cleanPhone(value) { return String(value || '').replace(/[^0-9]/g, ''); }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function createPairingCode(number) {
  if (sessions.has(number)) {
    const current = sessions.get(number);
    if (current.code && Date.now() - current.createdAt < 3 * 60 * 1000) return current.code;
  }
  if (pending.has(number)) return pending.get(number);

  const task = (async () => {
    fs.mkdirSync(AUTH_ROOT, { recursive: true });
    const authDir = path.join(AUTH_ROOT, number);
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    if (state.creds.registered) {
      throw new Error('This WhatsApp number is already linked to this KINGMD254 server.');
    }
    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['KINGMD254', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });
    const entry = { sock, code: null, createdAt: Date.now() };
    sessions.set(number, entry);
    sock.ev.on('creds.update', saveCreds);
    // Wait for the socket to initialize before asking WhatsApp for a phone-link code.
    await wait(2500);
    const code = await sock.requestPairingCode(number);
    entry.code = String(code).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    entry.createdAt = Date.now();
    return entry.code;
  })();
  pending.set(number, task);
  try { return await task; }
  catch (err) { sessions.delete(number); throw err; }
  finally { pending.delete(number); }
}

async function pairHandler(req, res) {
  const number = cleanPhone(req.body?.phoneNumber || req.body?.number || req.body?.phone);
  if (number.length < 8 || number.length > 15) {
    return res.status(400).json({ success: false, message: 'Enter a valid WhatsApp number with country code, digits only.' });
  }
  try {
    const code = await createPairingCode(number);
    return res.json({ success: true, code, message: 'Pairing code generated.' });
  } catch (error) {
    console.error('[KINGMD254 pairing]', error?.stack || error);
    const message = /already linked/i.test(error.message)
      ? error.message
      : 'Could not generate a pairing code. Check the Render logs and try again.';
    return res.status(500).json({ success: false, message });
  }
}
app.post('/pair', pairHandler);
app.post('/api/pair', pairHandler);
app.get('/pair', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use((req, res) => res.status(404).json({ success: false, message: 'Endpoint not found' }));

const server = app.listen(PORT, '0.0.0.0', () => console.log(`KINGMD254 pairing website listening on ${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
