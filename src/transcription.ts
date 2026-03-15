import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execAsync = promisify(exec);

const WHISPER_CLI = '/opt/homebrew/bin/whisper-cli';
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const WHISPER_MODEL = '/opt/homebrew/share/whisper-cpp/models/ggml-base.en.bin';
const FALLBACK_MESSAGE = '[Voice Message - transcription unavailable]';

/**
 * Transcribe an audio buffer using local whisper-cpp.
 * Returns the transcript text, or a fallback message on failure.
 */
export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  if (!audioBuffer || audioBuffer.length === 0) {
    return FALLBACK_MESSAGE;
  }

  const tmpOgg = path.join(os.tmpdir(), `voice-${Date.now()}.ogg`);
  const tmpWav = tmpOgg.replace('.ogg', '.wav');

  try {
    fs.writeFileSync(tmpOgg, audioBuffer);

    // Convert OGG Opus (Telegram format) to 16kHz mono WAV for whisper-cpp
    await execAsync(
      `${FFMPEG} -y -i ${tmpOgg} -ar 16000 -ac 1 -c:a pcm_s16le ${tmpWav}`,
    );

    const { stdout } = await execAsync(
      `${WHISPER_CLI} -m ${WHISPER_MODEL} -f ${tmpWav} --no-timestamps -np`,
    );

    const transcript = stdout.trim();
    if (!transcript) {
      logger.error({ tmpWav }, 'whisper-cpp returned empty output');
      return FALLBACK_MESSAGE;
    }

    return transcript;
  } catch (err) {
    logger.error({ err }, 'whisper-cpp transcription failed');
    return FALLBACK_MESSAGE;
  } finally {
    fs.rmSync(tmpOgg, { force: true });
    fs.rmSync(tmpWav, { force: true });
  }
}
