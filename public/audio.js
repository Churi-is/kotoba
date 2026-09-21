// Japanese audio: neural TTS from the Worker when a key is configured, the browser's
// own ja-JP synthesis otherwise. Both paths are exposed identically to callers, because
// the app must never depend on a paid model being present to be usable.

import { api } from './api.js';

let ctx;
let currentSource;
let currentUtterance;

export function audioContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

export const ttsAvailable = () => 'speechSynthesis' in window;
export const jaVoice = () => (speechSynthesis.getVoices() || []).find((v) => /^ja/i.test(v.lang));
if (ttsAvailable()) speechSynthesis.onvoiceschanged = () => {};

function browserSpeak(text, rate = 1) {
  return new Promise((resolve) => {
    if (!ttsAvailable()) return resolve(false);
    const u = new SpeechSynthesisUtterance(text);
    const v = jaVoice();
    if (v) u.voice = v;
    u.lang = 'ja-JP';
    u.rate = rate;
    u.onend = () => resolve(true);
    u.onerror = () => resolve(false);
    currentUtterance = u;
    speechSynthesis.speak(u);
  });
}

/** Speak Japanese. Tries the model voice first (better pitch and mora timing — it is
 *  what we are actually teaching), then falls back silently. */
export async function speak(text, { rate = 1, onStart, onEnd } = {}) {
  stop();
  onStart?.();
  try {
    const r = await api('/api/tools/tts', { body: { text, speed: rate } });
    if (r?.audioBase64) {
      await playPcmBase64(r.audioBase64, r.mimeType, rate);
      onEnd?.();
      return 'model';
    }
  } catch { /* fall through */ }
  await browserSpeak(text, rate);
  onEnd?.();
  return 'browser';
}

async function playPcmBase64(b64, mime = 'audio/L16;rate=24000', rate = 1) {
  const ac = audioContext();
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const m = /rate=(\d+)/.exec(mime);
  const sampleRate = m ? Number(m[1]) : 24000;
  const isPcm = /L16|pcm/i.test(mime);

  let buffer;
  if (isPcm) {
    const view = new DataView(bytes.buffer);
    const frames = Math.floor(bytes.length / 2);
    buffer = ac.createBuffer(1, frames, sampleRate);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
  } else {
    buffer = await ac.decodeAudioData(bytes.buffer.slice(0));
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  src.connect(ac.destination);
  currentSource = src;
  return new Promise((resolve) => { src.onended = () => resolve(); src.start(); });
}

export function stop() {
  try { currentSource?.stop(); } catch {}
  currentSource = null;
  if (ttsAvailable()) speechSynthesis.cancel();
  currentUtterance = null;
}

// ---------------------------------------------------------------- recording

/** Record from the mic. Returns a blob + object URL; callers decide what to do with it
 *  (send to the voice session, or keep it locally in IndexedDB for "listen to yourself"). */
export class Recorder {
  constructor() { this.chunks = []; this.media = null; this.stream = null; this.startedAt = 0; }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.media = new MediaRecorder(this.stream);
    this.chunks = [];
    this.media.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.media.start(250);
    this.startedAt = Date.now();
    return this;
  }

  async stop() {
    if (!this.media) return null;
    await new Promise((r) => { this.media.onstop = r; this.media.stop(); });
    this.stream?.getTracks().forEach((t) => t.stop());
    const blob = new Blob(this.chunks, { type: this.media.mimeType || 'audio/webm' });
    return { blob, url: URL.createObjectURL(blob), ms: Date.now() - this.startedAt };
  }
}

export function canRecord() {
  return Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext !== false;
}

/** Raw 16-bit PCM mono @16kHz stream — what the Live API wants. */
export async function openMicPcm(onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const ac = audioContext();
  const source = ac.createMediaStreamSource(stream);
  const node = ac.createScriptProcessor(4096, 1, 1);
  const target = 16000;
  const ratio = ac.sampleRate / target;
  source.connect(node);
  node.connect(ac.destination);
  let frames = 0;
  node.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const outLen = Math.floor(input.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    frames++;
    onChunk(new Uint8Array(out.buffer), frames);
  };
  return {
    stop: () => {
      try { node.disconnect(); } catch {}
      try { source.disconnect(); } catch {}
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/** Simple pitch trace from a recorded blob: rough visual for the pronunciation tool.
 *  We are not measuring F0 properly — this shows loudness contour, which is enough to
 *  make mora timing and phrase-final fall visible. The narrative explanation from the
 *  model is what actually drives improvement (visual alone underperforms). */
export async function contour(blob, buckets = 48) {
  const ac = audioContext();
  const buf = await ac.decodeAudioData(await blob.arrayBuffer());
  const data = buf.getChannelData(0);
  const size = Math.floor(data.length / buckets);
  const out = [];
  let peak = 0.0001;
  for (let b = 0; b < buckets; b++) {
    let sum = 0;
    for (let i = 0; i < size; i += 4) sum += Math.abs(data[b * size + i] || 0);
    const v = sum / (size / 4 || 1);
    peak = Math.max(peak, v);
    out.push(v);
  }
  return out.map((v) => Math.round((v / peak) * 100));
}
