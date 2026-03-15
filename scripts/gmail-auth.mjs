#!/usr/bin/env node
/**
 * Gmail OAuth authorization helper.
 * Reads ~/.gmail-mcp/gcp-oauth.keys.json, starts a local callback server,
 * opens the authorization URL, captures the code, and saves tokens to
 * ~/.gmail-mcp/credentials.json.
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { google } from 'googleapis';

const credDir = join(homedir(), '.gmail-mcp');
const keysPath = join(credDir, 'gcp-oauth.keys.json');
const tokensPath = join(credDir, 'credentials.json');

const keys = JSON.parse(readFileSync(keysPath, 'utf-8'));
const { client_id, client_secret } = keys.installed || keys.web || keys;

// Pick a free port for the loopback redirect
const PORT = 4567;
const REDIRECT_URI = `http://localhost:${PORT}`;

const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // force refresh_token to be returned
});

console.log('\nOpen this URL in your browser to authorize Gmail access:\n');
console.log(authUrl);
console.log('\nWaiting for authorization callback on port', PORT, '...\n');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Authorization failed: ${error}`);
    console.error('Authorization failed:', error);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
    console.log('Tokens saved to', tokensPath);
    console.log('Gmail authorization complete!');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Gmail authorized successfully!</h2><p>You can close this tab.</p></body></html>');
  } catch (err) {
    console.error('Failed to exchange code for tokens:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Token exchange failed: ' + err.message);
  }

  server.close();
});

server.listen(PORT, '127.0.0.1');
