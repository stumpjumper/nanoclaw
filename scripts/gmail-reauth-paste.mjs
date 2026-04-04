#!/usr/bin/env node
/**
 * Gmail OAuth re-authorization — SSH/ShellFish friendly.
 * No local callback server needed. You authorize in your phone's browser,
 * then paste the redirect URL (even if it shows an error) back here.
 */

import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import { google } from 'googleapis';

const credDir = join(homedir(), '.gmail-mcp');
const keysPath = join(credDir, 'gcp-oauth.keys.json');
const tokensPath = join(credDir, 'credentials.json');

const keys = JSON.parse(readFileSync(keysPath, 'utf-8'));
const { client_id, client_secret } = keys.installed || keys.web || keys;

// Must match what's registered in GCP console — keep it as localhost even though
// we won't actually run a server. We extract the code from the pasted URL.
const REDIRECT_URI = 'http://localhost:4567';

const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('\n=== Gmail Re-Authorization ===\n');
console.log('Step 1: Open this URL in your browser (copy and paste it):\n');
console.log(authUrl);
console.log('\nStep 2: Sign in with Google and click Allow.');
console.log('\nStep 3: Your browser will redirect to localhost:4567 and show an error.');
console.log('        That\'s expected! Copy the FULL URL from the address bar.\n');
console.log('Step 4: Paste that URL here and press Enter:\n');

const rl = createInterface({ input: process.stdin, output: process.stdout });

rl.question('> ', async (input) => {
  rl.close();
  const pasted = input.trim();

  // Extract code= from URL regardless of whether http:// prefix is present
  const codeMatch = pasted.match(/[?&]code=([^&\s]+)/);
  const code = codeMatch ? decodeURIComponent(codeMatch[1]) : pasted.trim();

  if (!code) {
    console.error('\nCould not find an authorization code in what you pasted.');
    console.error('Make sure you copied the full URL from the address bar.');
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
    console.log('\n✓ Tokens saved to', tokensPath);
    console.log('✓ Gmail authorization complete!');
    console.log('\nRestart NanoClaw to reconnect Gmail.');
  } catch (err) {
    console.error('\nFailed to exchange code for tokens:', err.message);
    console.error('The code may have expired (they last ~1 minute). Try again.');
    process.exit(1);
  }
});
