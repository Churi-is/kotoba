// live.js — the hands-free voice session.
//
// Browser ⇄ Worker (Durable Object) ⇄ Gemini 3.8 Live. Audio is raw 16-bit PCM at
// 16kHz up and 24kHz down, exactly what the Live API expects. Barge-in is honoured:
// when the tutor is interrupted we stop playback immediately rather than talking over
// the learner. Turn-taking is tuned server-side (1.8s silence window) so a learner has
// room to assemble a sentence — the single biggest UX difference between a voice
// *tutor* and a voice *assistant*.

import { audioContext, openMicPcm } from './audio.js';

export async function startVoiceSession({ wsPath, model, onTutor, onLearner, onStatus, onError }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}${wsPath}`);
  ws.binaryType = 'arraybuffer';

  const ac = audioContext();
  if (ac.state === 'suspended') await ac.resume();
  const queue = [];
  let playing = false;
  let nextTime = 0;
  let mic;
  let closed = false;

  const panel = document.createElement('div');
  panel.className = 'card';
  panel.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:70;width:280px;background:var(--panel-2)';
  panel.innerHTML = `
    <div class="row between"><strong>Voice mode</strong><span class="chip ok" id="voState">connecting…</span></div>
    <div class="small muted" id="voModel" style="margin:6px 0 10px"></div>
    <div class="pitchviz" id="voMeter"></div>
    <div class="row gap">
      <button class="ghost small" id="voMute">mute mic</button>
      <button class="danger small" id="voEnd">end</button>
    </div>
    <div class="tiny muted" style="margin-top:8px">Speak naturally. Silences of 2–3 seconds are fine — Aoi will wait for you.</div>
  `;
  document.body.append(panel);
  panel.querySelector('#voModel').textContent = `${model} · ja-JP · barge-in on`;
  panel.querySelector('#voEnd').onclick = () => stop();
  panel.querySelector('#voMute').onclick = (e) => {
    muted = !muted;
    e.target.textContent = muted ? 'unmute mic' : 'mute mic';
  };
  let muted = false;

  const state = (t, ok = true) => {
    panel.querySelector('#voState').textContent = t;
    panel.querySelector('#voState').className = 'chip ' + (ok ? 'ok' : 'warn');
    onStatus?.(t);
  };

  ws.onopen = async () => {
    state('live');
    try {
      mic = await openMicPcm((pcm) => {
        if (muted || ws.readyState !== WebSocket.OPEN) return;
        ws.send(pcm.buffer);
      });
    } catch (e) {
      onError?.('Microphone blocked — you can still type to Aoi.');
    }
  };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : await blobText(ev.data)); } catch { return; }
    switch (msg.type) {
      case 'ready': state('live'); break;
      case 'interaction_status':
        // Extended-thinking sessions reason in the background between utterances;
        // IDLE is the only state where Aoi is actually waiting for the learner.
        if (msg.status === 'IDLE') state('live');
        else if (msg.status === 'IN_PROGRESS') state('thinking…');
        break;
      case 'audio': enqueue(msg.data, msg.mimeType); break;
      case 'tutor_transcript': onTutor?.(msg.text); break;
      case 'learner_transcript': onLearner?.(msg.text); break;
      case 'interrupted':
        queue.length = 0;
        playing = false;
        nextTime = 0;
        break;
      case 'beat_finished':
        state(msg.met ? 'activity complete' : 'moving on');
        break;
      case 'go_away': state(`reconnecting in ${msg.timeLeft ?? '?'}`, false); break;
      case 'upstream_closed': state('reconnecting…', false); break;
      case 'error':
        state('error', false);
        onError?.(msg.message ?? 'voice session error');
        break;
    }
  };

  ws.onerror = () => { state('connection lost', false); onError?.('Voice connection failed.'); };
  ws.onclose = () => { if (!closed) { state('ended', false); cleanup(); } };

  function enqueue(b64, mime) {
    const rate = Number(/rate=(\d+)/.exec(mime ?? '')?.[1] ?? 24000);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const frames = Math.floor(bytes.length / 2);
    const buf = ac.createBuffer(1, frames, rate);
    const ch = buf.getChannelData(0);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < frames; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    queue.push(buf);
    if (!playing) playNext();
    // crude output meter
    const meter = panel.querySelector('#voMeter');
    if (meter.children.length === 0) for (let i = 0; i < 24; i++) meter.append(document.createElement('i'));
    let peak = 0;
    for (let i = 0; i < frames; i += 64) peak = Math.max(peak, Math.abs(ch[i]));
    [...meter.children].forEach((b, i) => { b.style.height = Math.max(4, peak * 100 * (0.5 + 0.5 * Math.sin(i))) + '%'; });
  }

  function playNext() {
    const buf = queue.shift();
    if (!buf) { playing = false; return; }
    playing = true;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    const t = Math.max(ac.currentTime, nextTime);
    src.start(t);
    nextTime = t + buf.duration;
    setTimeout(playNext, Math.max(0, buf.duration * 1000 - 40));
  }

  function cleanup() {
    try { mic?.stop(); } catch {}
    panel.remove();
  }

  async function stop() {
    closed = true;
    try { ws.send(JSON.stringify({ type: 'bye' })); } catch {}
    try { ws.close(); } catch {}
    cleanup();
  }

  return { stop, sendText: (text) => ws.send(JSON.stringify({ type: 'text', text })) };
}

async function blobText(d) {
  if (typeof d === 'string') return d;
  if (d instanceof ArrayBuffer) return new TextDecoder().decode(d);
  return d.text ? await d.text() : String(d);
}
