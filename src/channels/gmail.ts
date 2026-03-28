import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { TIMEZONE } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// Hours of day (local time) when Gmail is polled
const POLL_HOURS = [4, 10, 16, 21];

// Gmail label names applied by NanoClaw
const LABEL_NOTIFY = 'NanoClaw/Notify';
const LABEL_REVIEW = 'NanoClaw/Review';
const LABEL_TRASH = 'NanoClaw/Trash';

// Max emails processed per poll to avoid flooding
const MAX_EMAILS_PER_POLL = 30;

export interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendDirect: (jid: string, text: string) => Promise<void>;
}

interface TriagedEmail {
  id: string;
  threadId: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  snippet: string;
  timestamp: string;
  bucket: 'notify' | 'review' | 'trash';
  reason: string;
}

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  messageId: string; // RFC 2822 Message-ID for In-Reply-To
}

export class GmailChannel implements Channel {
  name = 'gmail';

  private oauth2Client: OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private opts: GmailChannelOpts;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private threadMeta = new Map<string, ThreadMeta>();
  private userEmail = '';
  private labelIds: Record<string, string> = {}; // labelName → gmail label id
  private gmailGroupName: string;
  private afterEpochSecs: number = 0; // loaded from disk or set to now on first run
  private readonly watermarkPath = path.join(
    os.homedir(),
    '.gmail-mcp',
    'watermark.json',
  );

  constructor(opts: GmailChannelOpts) {
    this.opts = opts;
    const env = readEnvFile(['GMAIL_GROUP_NAME']);
    this.gmailGroupName = env.GMAIL_GROUP_NAME || '';
  }

  async connect(): Promise<void> {
    const credDir = path.join(os.homedir(), '.gmail-mcp');
    const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(credDir, 'credentials.json');

    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.warn(
        'Gmail credentials not found in ~/.gmail-mcp/. Skipping Gmail channel. Run /add-gmail to set up.',
      );
      return;
    }

    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

    const clientConfig = keys.installed || keys.web || keys;
    const { client_id, client_secret, redirect_uris } = clientConfig;
    this.oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris?.[0],
    );
    this.oauth2Client.setCredentials(tokens);

    // Persist refreshed tokens
    this.oauth2Client.on('tokens', (newTokens) => {
      try {
        const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
        Object.assign(current, newTokens);
        fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
        logger.debug('Gmail OAuth tokens refreshed');
      } catch (err) {
        logger.warn({ err }, 'Failed to persist refreshed Gmail tokens');
      }
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

    // Verify connection
    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    this.userEmail = profile.data.emailAddress || '';
    logger.info({ email: this.userEmail }, 'Gmail channel connected');

    // Load watermark (only process emails newer than last poll)
    this.loadWatermark();

    // Ensure NanoClaw labels exist
    await this.ensureLabels();

    // Initial poll, then schedule
    await this.pollAndSummarize();
    this.scheduleNextPoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.gmail) {
      logger.warn('Gmail not initialized');
      return;
    }

    const threadId = jid.replace(/^gmail:/, '');
    const meta = this.threadMeta.get(threadId);

    if (!meta) {
      logger.warn({ jid }, 'No thread metadata for reply, cannot send');
      return;
    }

    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    const headers = [
      `To: ${meta.sender}`,
      `From: ${this.userEmail}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${meta.messageId}`,
      `References: ${meta.messageId}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
    ].join('\r\n');

    const encodedMessage = Buffer.from(headers)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId,
        },
      });
      logger.info({ to: meta.sender, threadId }, 'Gmail reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Gmail reply');
    }
  }

  isConnected(): boolean {
    return this.gmail !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gmail:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.gmail = null;
    this.oauth2Client = null;
    logger.info('Gmail channel stopped');
  }

  // --- Private ---

  private findTargetJid(): string | null {
    const groups = this.opts.registeredGroups();

    if (this.gmailGroupName) {
      const entry = Object.entries(groups).find(
        ([, g]) => g.folder.toLowerCase() === this.gmailGroupName.toLowerCase(),
      );
      if (entry) return entry[0];
      logger.warn(
        { gmailGroupName: this.gmailGroupName },
        'GMAIL_GROUP_NAME not found in registered groups, falling back to main',
      );
    }

    const main = Object.entries(groups).find(([, g]) => g.isMain === true);
    return main ? main[0] : null;
  }

  /** Calculate ms until the next scheduled poll time (local timezone). */
  private getNextPollMs(): number {
    const nowLocal = new Date(
      new Date().toLocaleString('en-US', { timeZone: TIMEZONE }),
    );
    const currentHour = nowLocal.getHours();
    const currentMin = nowLocal.getMinutes();

    // Find the next poll hour that hasn't passed yet
    const nextHour =
      POLL_HOURS.find(
        (h) => h > currentHour || (h === currentHour && currentMin < 1),
      ) ?? null;

    const target = new Date(nowLocal);
    if (nextHour !== null) {
      target.setHours(nextHour, 0, 0, 0);
    } else {
      // All poll times passed today — schedule first slot tomorrow
      target.setDate(target.getDate() + 1);
      target.setHours(POLL_HOURS[0], 0, 0, 0);
    }

    return Math.max(target.getTime() - nowLocal.getTime(), 60_000);
  }

  private scheduleNextPoll(): void {
    const ms = this.getNextPollMs();
    const nextTime = new Date(Date.now() + ms).toLocaleTimeString('en-US', {
      timeZone: TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
    });
    logger.info({ nextTime, ms }, 'Gmail next poll scheduled');
    this.pollTimer = setTimeout(async () => {
      if (!this.gmail) return;
      await this.pollAndSummarize().catch((err) =>
        logger.error({ err }, 'Gmail poll error'),
      );
      this.scheduleNextPoll();
    }, ms);
  }

  private async pollAndSummarize(): Promise<void> {
    if (!this.gmail) return;

    const targetJid = this.findTargetJid();
    if (!targetJid) {
      logger.debug('Gmail poll: no target group registered, skipping');
      return;
    }

    let emails: TriagedEmail[];
    try {
      emails = await this.fetchAndTriageEmails();
    } catch (err) {
      logger.error({ err }, 'Gmail poll failed');
      return;
    }

    if (emails.length === 0) {
      logger.info('Gmail poll: no new emails');
      return;
    }

    // Apply Gmail labels
    await this.applyLabels(emails);

    // Send numbered summary directly to the user (bypasses agent so formatting is preserved)
    const summary = this.formatSummary(emails);
    const now = new Date().toLocaleString('en-US', {
      timeZone: TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    const fullSummary = `📬 Gmail check (${now}) — ${emails.length} new\n\n${summary}`;
    await this.opts.sendDirect(targetJid, fullSummary);

    // Inject a context message so the agent knows what was sent and can handle replies
    const contextLines = emails.map(
      (e, i) =>
        `${i + 1}. [${e.bucket.toUpperCase()}] From: ${e.fromName} <${e.from}> | Subject: ${e.subject} | threadId: ${e.threadId}`,
    );
    this.opts.onMessage(targetJid, {
      id: `gmail-context-${Date.now()}`,
      chat_jid: targetJid,
      sender: 'gmail-system',
      sender_name: 'Gmail',
      content: `[Gmail triage context — do not repeat this to the user]\n${contextLines.join('\n')}\n\nWhen the user replies with feedback (e.g. "3 is trash", "reply to 1 with yes"), act on it. Use the threadId to send email replies if asked.`,
      timestamp: new Date().toISOString(),
      is_from_me: false,
    });

    // Store thread metadata so replies can be sent
    for (const email of emails) {
      this.opts.onChatMetadata(
        `gmail:${email.threadId}`,
        email.timestamp,
        email.subject,
        'gmail',
        false,
      );
    }

    // Advance watermark so next poll only sees emails newer than this one
    this.afterEpochSecs = Math.floor(Date.now() / 1000);
    this.saveWatermark();

    logger.info(
      {
        total: emails.length,
        notify: emails.filter((e) => e.bucket === 'notify').length,
        review: emails.filter((e) => e.bucket === 'review').length,
        trash: emails.filter((e) => e.bucket === 'trash').length,
      },
      'Gmail poll complete',
    );
  }

  private async fetchAndTriageEmails(): Promise<TriagedEmail[]> {
    if (!this.gmail) return [];

    const res = await this.gmail.users.messages.list({
      userId: 'me',
      q: `is:unread in:inbox -label:NanoClaw after:${this.afterEpochSecs}`,
      maxResults: MAX_EMAILS_PER_POLL,
    });

    const stubs = res.data.messages || [];
    const newStubs = stubs.filter((s) => s.id && !this.processedIds.has(s.id!));

    if (newStubs.length === 0) return [];

    // Fetch full message data
    const fetched = await Promise.all(
      newStubs.map((s) => this.fetchEmail(s.id!)),
    );
    const valid = fetched.filter((e): e is TriagedEmail => e !== null);

    // Mark as processed
    for (const e of valid) this.processedIds.add(e.id);

    // Cap set size
    if (this.processedIds.size > 5000) {
      const ids = [...this.processedIds];
      this.processedIds = new Set(ids.slice(ids.length - 2500));
    }

    // Triage via Claude
    const triaged = await this.triageEmails(valid);
    return triaged;
  }

  private async fetchEmail(messageId: string): Promise<TriagedEmail | null> {
    if (!this.gmail) return null;

    const msg = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = msg.data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value || '';

    const from = getHeader('From');
    const to = getHeader('To') || getHeader('Delivered-To') || '';
    const subject = getHeader('Subject') || '(no subject)';
    const rfc2822MessageId = getHeader('Message-ID');
    const threadId = msg.data.threadId || messageId;
    const timestamp = new Date(
      parseInt(msg.data.internalDate || '0', 10),
    ).toISOString();

    const senderMatch = from.match(/^(.+?)\s*<(.+?)>$/);
    const senderName = senderMatch
      ? senderMatch[1].replace(/"/g, '').trim()
      : from;
    const senderEmail = senderMatch ? senderMatch[2] : from;

    // Skip emails from self
    if (senderEmail.toLowerCase() === this.userEmail.toLowerCase()) return null;

    const body = this.extractTextBody(msg.data.payload);
    const snippet = (msg.data.snippet || body || '').slice(0, 200).trim();

    // Cache thread metadata for potential replies
    this.threadMeta.set(threadId, {
      sender: senderEmail,
      senderName,
      subject,
      messageId: rfc2822MessageId,
    });

    return {
      id: messageId,
      threadId,
      from: senderEmail,
      fromName: senderName,
      to,
      subject,
      snippet,
      timestamp,
      bucket: 'review', // default, overwritten by triage
      reason: '',
    };
  }

  /** Use Claude to classify emails into notify / review / trash. */
  private async triageEmails(emails: TriagedEmail[]): Promise<TriagedEmail[]> {
    if (emails.length === 0) return emails;

    const emailList = emails
      .map(
        (e, i) =>
          `${i + 1}. From: ${e.fromName} <${e.from}>\n   To: ${e.to}\n   Subject: ${e.subject}\n   Snippet: ${e.snippet}`,
      )
      .join('\n\n');

    const prompt = `You are triaging email for Alfred Lorber, a software engineer in Albuquerque, NM.

Classify each email as:
- notify: Alfred needs to know now (family, friends, financial alerts, security alerts, health, work contacts, things he's actively waiting for)
- review: uncertain — Alfred should decide
- trash: clearly unimportant (newsletters, marketing, automated notifications from services he doesn't use, spam)

Alfred's email aliases (all legitimate, all forward to his Gmail):
- aalorber@gmail.com — his main Gmail
- Alfred@TheLorbers.com, Darla@TheLorbers.com — family domain (thelorbers.com)
- *@the-ls.com — shorter alias domain (e.g. dish@the-ls.com = Dish Network account)
- *@endoftheworldasweknowit.com — old catch-all domain, disposable addresses for services
- Random *@icloud.com addresses — Apple "Hide My Email" aliases
The "To:" address often indicates which service/account the email relates to.

Important people/things:
- Family: Darla (his wife, dklorber@gmail.com / darla@thelorbers.com), Marlene (daughter, Air Force pilot at Columbus AFB, mtlorber@gmail.com / marlene@thelorbers.com), Craig
- Financial: bank alerts, bills, major purchases, crypto
- Security: SimpliSafe, Comcast/Xfinity alerts, password/account alerts, home security
- Health: prescription ready (Walgreens), doctor/medical, PHS
- Work/professional: Sandia National Labs, Lockheed Martin, USAFA, LANL, Red Hat, kirtland.af.mil
- Tech projects: NanoClaw, Arduino, B-52 Museum lighting, Zwift, cycling gear
- Services he actively uses: Backblaze, Google calendar notifications, camelcamelcamel price alerts

Definitely trash: newsletters, social media digests (Facebook, Twitter), marketing from retailers, alumni association (PSU, etc.), Groupon, real estate spam, anything clearly a mass mailing.

Reply with ONLY a JSON array, one entry per email in order:
[{"bucket":"notify|review|trash","reason":"brief reason"}]

Emails to classify:
${emailList}`;

    try {
      const text = await this.callClaude(prompt);
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array in response');

      const results: { bucket: string; reason: string }[] = JSON.parse(
        jsonMatch[0],
      );

      for (let i = 0; i < Math.min(emails.length, results.length); i++) {
        const bucket = results[i].bucket;
        if (bucket === 'notify' || bucket === 'review' || bucket === 'trash') {
          emails[i].bucket = bucket;
          emails[i].reason = results[i].reason || '';
        }
      }
    } catch (err) {
      logger.error({ err }, 'Gmail triage failed, defaulting all to review');
      for (const e of emails) e.bucket = 'review';
    }

    return emails;
  }

  /**
   * Call the Anthropic API directly, using whichever auth is configured.
   * In API-key mode sends x-api-key; in OAuth mode sends Authorization: Bearer.
   */
  private async callClaude(prompt: string): Promise<string> {
    const env = readEnvFile([
      'GMAIL_ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
    ]);

    const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    if (env.GMAIL_ANTHROPIC_API_KEY) {
      headers['x-api-key'] = env.GMAIL_ANTHROPIC_API_KEY;
    } else {
      const token = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
      if (!token) throw new Error('No Claude auth credentials found in .env');
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      content: { type: string; text: string }[];
    };
    return data.content[0]?.text ?? '';
  }

  /** Apply NanoClaw/* labels to each email in Gmail. */
  private async applyLabels(emails: TriagedEmail[]): Promise<void> {
    if (!this.gmail) return;

    const bucketLabel: Record<string, string> = {
      notify: LABEL_NOTIFY,
      review: LABEL_REVIEW,
      trash: LABEL_TRASH,
    };

    for (const email of emails) {
      const labelName = bucketLabel[email.bucket];
      const labelId = this.labelIds[labelName];
      if (!labelId) continue;

      const addLabelIds = [labelId];
      const removeLabelIds: string[] = ['UNREAD'];

      // Trash-classified emails: archive out of inbox (not deleted yet — user reviews first)
      if (email.bucket === 'trash') {
        removeLabelIds.push('INBOX');
      }

      try {
        await this.gmail!.users.messages.modify({
          userId: 'me',
          id: email.id,
          requestBody: { addLabelIds, removeLabelIds },
        });
      } catch (err) {
        logger.warn({ messageId: email.id, err }, 'Failed to label email');
      }
    }
  }

  /** Format the numbered summary message. */
  private formatSummary(emails: TriagedEmail[]): string {
    const notify = emails.filter((e) => e.bucket === 'notify');
    const review = emails.filter((e) => e.bucket === 'review');
    const trash = emails.filter((e) => e.bucket === 'trash');

    const lines: string[] = [];
    let num = 1;

    if (notify.length > 0) {
      lines.push('🔔 Notify:');
      for (const e of notify) {
        lines.push(`${num++}. ${e.fromName} — "${e.subject}"`);
      }
    }

    if (review.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('🔍 Review (not sure):');
      for (const e of review) {
        lines.push(`${num++}. ${e.fromName} — "${e.subject}"`);
      }
    }

    if (trash.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('🗑️ Trash (labeled, still in Gmail for review):');
      for (const e of trash) {
        lines.push(`${num++}. ${e.fromName} — "${e.subject}"`);
      }
    }

    lines.push('');
    lines.push('Reply with feedback: "3 is trash", "1 reply yes", "2 keep"');

    return lines.join('\n');
  }

  /** Create NanoClaw/* labels if they don't exist, cache their IDs. */
  private async ensureLabels(): Promise<void> {
    if (!this.gmail) return;

    const needed = [LABEL_NOTIFY, LABEL_REVIEW, LABEL_TRASH];

    try {
      const res = await this.gmail.users.labels.list({ userId: 'me' });
      const existing = res.data.labels || [];

      for (const labelName of needed) {
        const found = existing.find((l) => l.name === labelName);
        if (found?.id) {
          this.labelIds[labelName] = found.id;
        } else {
          // Create it
          const created = await this.gmail.users.labels.create({
            userId: 'me',
            requestBody: {
              name: labelName,
              labelListVisibility: 'labelShow',
              messageListVisibility: 'show',
            },
          });
          if (created.data.id) {
            this.labelIds[labelName] = created.data.id;
            logger.info({ labelName }, 'Created Gmail label');
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to ensure Gmail labels');
    }
  }

  private loadWatermark(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.watermarkPath, 'utf-8'));
      this.afterEpochSecs =
        data.afterEpochSecs ?? Math.floor(Date.now() / 1000);
      logger.info(
        { afterEpochSecs: this.afterEpochSecs },
        'Gmail watermark loaded',
      );
    } catch {
      // First run — start from now, ignore backlog
      this.afterEpochSecs = Math.floor(Date.now() / 1000);
      this.saveWatermark();
      logger.info(
        { afterEpochSecs: this.afterEpochSecs },
        'Gmail watermark initialized (first run)',
      );
    }
  }

  private saveWatermark(): void {
    try {
      fs.writeFileSync(
        this.watermarkPath,
        JSON.stringify({ afterEpochSecs: this.afterEpochSecs }),
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to save Gmail watermark');
    }
  }

  private extractTextBody(
    payload: gmail_v1.Schema$MessagePart | undefined,
  ): string {
    if (!payload) return '';

    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
      for (const part of payload.parts) {
        const text = this.extractTextBody(part);
        if (text) return text;
      }
    }

    return '';
  }
}

registerChannel('gmail', (opts: ChannelOpts) => {
  const credDir = path.join(os.homedir(), '.gmail-mcp');
  if (
    !fs.existsSync(path.join(credDir, 'gcp-oauth.keys.json')) ||
    !fs.existsSync(path.join(credDir, 'credentials.json'))
  ) {
    logger.warn('Gmail: credentials not found in ~/.gmail-mcp/');
    return null;
  }
  return new GmailChannel(opts);
});
