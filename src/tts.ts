import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execAsync = promisify(exec);

const SAY = '/usr/bin/say';
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const TTS_VOICE = 'Samantha';

/**
 * Strip emojis and tidy text for natural speech.
 */
function prepareForSpeech(text: string): string {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convert text to speech using macOS say, returning an OGG Opus buffer
 * suitable for sending as a Telegram voice message.
 */
export async function textToSpeech(text: string): Promise<Buffer> {
  const clean = prepareForSpeech(text);
  const tmpAiff = path.join(os.tmpdir(), `tts-${Date.now()}.aiff`);
  const tmpOgg = tmpAiff.replace('.aiff', '.ogg');

  try {
    await execAsync(
      `${SAY} -v "${TTS_VOICE}" -o "${tmpAiff}" "${clean.replace(/"/g, '\\"')}"`,
    );
    await execAsync(
      `${FFMPEG} -y -i "${tmpAiff}" -c:a libopus -b:a 32k "${tmpOgg}"`,
    );
    return fs.readFileSync(tmpOgg);
  } catch (err) {
    logger.error({ err }, 'TTS failed');
    throw err;
  } finally {
    fs.rmSync(tmpAiff, { force: true });
    fs.rmSync(tmpOgg, { force: true });
  }
}
