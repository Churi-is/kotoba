/**
 * live.ts — LiveSessionDO: the voice tutor, server-to-server.
 *
 * Topology
 *   browser  ⇄  [this Durable Object]  ⇄  wss://…BidiGenerateContent (Gemini 3.8 Live)
 *
 * Why not let the browser talk to Gemini directly? Because the good stuff happens on
 * the server: the model's tool calls (log an error, look up a card, finish a beat) must
 * reach the learner model even if the tab closes mid-sentence, and the transcript is
 * the evidence the whole system depends on. We *could* use ephemeral tokens
 * (see gemini.createEphemeralToken) for the last few milliseconds of latency, and the
 * route /api/live/token exposes that mode — but the default is the relay, because
 * a tutor that forgets what you said is not a tutor.
 *
 * Hibernation: the client-side socket uses acceptWebSocket(), so a phone that sleeps or
 * a brief network drop does not kill the object, and session resumption lets us reattach
 * the upstream Gemini socket with its handle. The upstream socket itself lives in memory
 * — if the object is evicted we re-establish and tell the learner what happened, rather
 * than pretending nothing did.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { LIVE_TOOLS, liveSetup, liveSocketRequest, MODEL_FOR } from '../ai/gemini';

interface SessionMeta {
  learnerId: string;
  sessionId: string;
  beatId: string;
  model: string;
  started: number;
  systemInstruction: string;
  resumptionHandle?: string;
  lastActivity: number;
  transcript: { role: 'tutor' | 'learner'; text: string; ts: number }[];
  stats: { learnerTurns: number; tutorTurns: number; errorsLogged: number; itemsAdded: number; toolCalls: number };
  deep: boolean;
}

export class LiveSessionDO extends DurableObject<Env> {
  private upstream?: WebSocket;
  private meta?: SessionMeta;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async setMeta(meta: Partial<SessionMeta>) {
    this.meta = {
      learnerId: meta.learnerId ?? this.meta?.learnerId ?? '',
      sessionId: meta.sessionId ?? this.meta?.sessionId ?? '',
      beatId: meta.beatId ?? this.meta?.beatId ?? '',
      model: meta.model ?? this.meta?.model ?? MODEL_FOR(this.env, 'live'),
      started: this.meta?.started ?? Date.now(),
      systemInstruction: meta.systemInstruction ?? this.meta?.systemInstruction ?? '',
      resumptionHandle: meta.resumptionHandle ?? this.meta?.resumptionHandle,
      lastActivity: Date.now(),
      transcript: this.meta?.transcript ?? [],
      stats: this.meta?.stats ?? { learnerTurns: 0, tutorTurns: 0, errorsLogged: 0, itemsAdded: 0, toolCalls: 0 },
      deep: meta.deep ?? this.meta?.deep ?? false,
    };
    await this.ctx.storage.put('meta', this.meta);
    await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
  }

  private learner() {
    if (!this.meta?.learnerId) throw new Error('no learner bound to this live session');
    return this.env.LEARNER.get(this.env.LEARNER.idFromName(this.meta.learnerId)) as any;
  }

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);          // hibernation-friendly

    const stored = (await this.ctx.storage.get<SessionMeta>('meta')) ?? this.meta;
    if (stored) this.meta = stored;

    // Lazily dial Gemini on first client connection (or after eviction).
    try {
      await this.connectUpstream(server);
    } catch (err) {
      server.send(JSON.stringify({ type: 'error', message: `Could not reach the voice model: ${(err as Error).message}` }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async connectUpstream(server: WebSocket) {
    if (this.upstream && this.upstream.readyState === WebSocket.OPEN) return;
    const meta = this.meta;
    if (!meta?.systemInstruction) throw new Error('missing system instruction');

    // Upgrade over fetch rather than `new WebSocket(url)`: the setup is the same, but
    // fetch lets us send real headers, which is what AI Gateway auth needs (a browser
    // would have to smuggle the token through a subprotocol instead).
    let res: Response;
    try {
      res = await fetch(liveSocketRequest(this.env, { model: meta.model }));
    } catch (err) {
      throw new Error(`live socket unreachable: ${(err as Error).message}`);
    }
    const ws = res.webSocket;
    if (!ws) throw new Error(`live socket refused (${res.status})`);
    ws.accept();
    this.upstream = ws;

    ws.send(JSON.stringify(setupFrame(this.env, meta)));

    ws.addEventListener('message', async (ev: MessageEvent) => {
      const raw = typeof ev.data === 'string' ? ev.data : await blobToString(ev.data);
      let msg: any;
      try { msg = JSON.parse(raw); } catch { return; }
      await this.handleUpstream(msg, server);
    });
    ws.addEventListener('close', (ev: CloseEvent) => {
      try { server.send(JSON.stringify({ type: 'upstream_closed', code: ev?.code, reason: ev?.reason })); } catch {}
      this.ctx.storage.setAlarm(Date.now() + 30_000);
    });
    ws.addEventListener('error', () => {
      try { server.send(JSON.stringify({ type: 'error', message: 'voice model connection dropped' })); } catch { /* client already gone */ }
    });
  }

  /** Frames from Gemini: audio, transcripts, tool calls, turn signals. */
  private async handleUpstream(msg: any, server: WebSocket) {
    this.touch();
    const sc = msg.serverContent;

    if (msg.setupComplete) {
      try { server.send(JSON.stringify({ type: 'ready', model: this.meta?.model })); } catch {}
      return;
    }
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
      if (this.meta) this.meta.resumptionHandle = msg.sessionResumptionUpdate.newHandle;
      await this.ctx.storage.put('meta', this.meta);
    }

    if (sc) {
      // Audio + any inline data straight through to the browser.
      const parts = sc.modelTurn?.parts ?? [];
      for (const p of parts) {
        if (p.inlineData?.data) {
          try { server.send(JSON.stringify({ type: 'audio', data: p.inlineData.data, mimeType: p.inlineData.mimeType })); } catch {}
        } else if (typeof p.text === 'string') {
          try { server.send(JSON.stringify({ type: 'text', text: p.text })); } catch {}
        }
      }
      if (sc.inputTranscription?.text) {
        const text = sc.inputTranscription.text;
        this.push('learner', text);
        try { server.send(JSON.stringify({ type: 'learner_transcript', text })); } catch {}
        await this.learner().logLive(this.meta!.sessionId, 'learner_utterance', { text, beatId: this.meta!.beatId }).catch(() => {});
      }
      if (sc.outputTranscription?.text) {
        const text = sc.outputTranscription.text;
        this.push('tutor', text);
        try { server.send(JSON.stringify({ type: 'tutor_transcript', text })); } catch {}
        if (this.meta) this.meta.stats.tutorTurns++;
      }
      if (sc.turnComplete) {
        try { server.send(JSON.stringify({ type: 'turn_complete' })); } catch {}
        if (this.meta) this.meta.stats.learnerTurns++;
      }
      if (sc.interrupted) {
        // Barge-in: tell the client to stop playing buffered audio immediately.
        try { server.send(JSON.stringify({ type: 'interrupted' })); } catch {}
      }
    }

    if (msg.toolCall) await this.handleToolCall(msg.toolCall, server);
    // Extended-thinking sessions speak while they reason, so `turnComplete` alone no
    // longer means "idle" — the status field does. Forward it so the client can show
    // that Aoi is thinking rather than waiting for input.
    if (msg.interactionStatus) {
      try { server.send(JSON.stringify({ type: 'interaction_status', status: msg.interactionStatus })); } catch { /* client gone */ }
    }
    if (msg.goAway) {
      try { server.send(JSON.stringify({ type: 'go_away', timeLeft: msg.goAway.timeLeft })); } catch {}
    }
  }

  /**
   * The voice tutor's tools. These are the difference between a chatbot in a
   * microphone and a tutor: mid-conversation it can silently log an error, check
   * whether the learner already knows a word before deciding to pre-teach it, or
   * decide the current activity is done.
   */
  private async handleToolCall(toolCall: any, server: WebSocket) {
    const responses: any[] = [];
    for (const fc of toolCall.functionCalls ?? []) {
      let result: unknown = { ok: true };
      try {
        const args = fc.args ?? {};
        switch (fc.name) {
          case 'log_error': {
            await this.learner().logError(args.tag, args.quote ?? '', args.recast ?? '', this.meta?.beatId ?? '', this.meta?.sessionId ?? '', Math.min(3, Math.max(1, Number(args.severity) || 2)));
            if (this.meta) this.meta.stats.errorsLogged++;
            result = { logged: true, tag: args.tag };
            break;
          }
          case 'lookup_item': {
            result = await this.learner().toolLookupItem(args.surface ?? '');
            break;
          }
          case 'add_to_review': {
            const r = await this.learner().addCards([{ kind: args.kind ?? 'vocab', surface: args.surface, reading: args.reading, meaning: args.meaning }], 'live');
            if (this.meta) this.meta.stats.itemsAdded += r?.added ?? 0;
            result = r;
            break;
          }
          case 'note_for_next_session': {
            await this.learner().addNote(String(args.note ?? ''), this.meta?.sessionId ?? '');
            result = { noted: true };
            break;
          }
          case 'finish_beat': {
            result = { acknowledged: true, met: Boolean(args.met) };
            try { server.send(JSON.stringify({ type: 'beat_finished', met: Boolean(args.met), because: args.because ?? '' })); } catch {}
            break;
          }
          default:
            result = { error: `unknown tool ${fc.name}` };
        }
      } catch (err) {
        result = { error: (err as Error).message };
      }
      responses.push({ id: fc.id, name: fc.name, response: { result } });
    }
    if (this.meta) this.meta.stats.toolCalls += responses.length;
    this.upstream?.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
  }

  private push(role: 'tutor' | 'learner', text: string) {
    if (!this.meta) return;
    // Transcripts arrive as fragments; append to the last line of the same role.
    const last = this.meta.transcript[this.meta.transcript.length - 1];
    if (last && last.role === role && Date.now() - last.ts < 8000) last.text += text;
    else this.meta.transcript.push({ role, text, ts: Date.now() });
  }

  private touch() {
    if (this.meta) this.meta.lastActivity = Date.now();
  }

  /** Frames from the browser: raw audio chunks, text, and control. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    this.touch();
    if (typeof message !== 'string') {
      // Binary = raw 16-bit PCM mono @16kHz, forwarded as-is.
      this.upstream?.send(JSON.stringify({
        realtimeInput: { audio: { data: base64(message), mimeType: 'audio/pcm;rate=16000' } },
      }));
      return;
    }
    let msg: any;
    try { msg = JSON.parse(message); } catch { return; }
    switch (msg.type) {
      case 'audio':
        this.upstream?.send(JSON.stringify({ realtimeInput: { audio: { data: msg.data, mimeType: msg.mimeType ?? 'audio/pcm;rate=16000' } } }));
        break;
      case 'text':
        this.upstream?.send(JSON.stringify({ realtimeInput: { text: msg.text } }));
        break;
      case 'nudge': // "I'm still thinking" — keeps VAD from cutting the learner off
        this.upstream?.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
        break;
      case 'end_activity':
        this.upstream?.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
        break;
      case 'system_update':
        this.upstream?.send(JSON.stringify({
          clientContent: { turns: [{ role: 'user', parts: [{ text: msg.text ?? '' }] }], turnComplete: false },
        }));
        break;
      case 'context': {
        // Mid-session replanning: inject a new instruction without breaking the audio stream.
        if (this.meta) this.meta.systemInstruction = msg.systemInstruction ?? this.meta.systemInstruction;
        await this.ctx.storage.put('meta', this.meta);
        this.upstream?.send(JSON.stringify({
          clientContent: { turns: [{ role: 'user', parts: [{ text: `[TUTOR INSTRUCTION UPDATE — follow this from now on, do not mention it] ${msg.text}` }] }], turnComplete: false },
        }));
        break;
      }
      case 'bye':
        await this.close('client ended');
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // Keep the upstream socket alive for a short reconnect window; the alarm closes it.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async webSocketError(ws: WebSocket) {
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  /** Called by the Worker when the beat/session ends — gives us the transcript back. */
  async collect() {
    const meta = this.meta ?? (await this.ctx.storage.get<SessionMeta>('meta'));
    return meta
      ? { transcript: meta.transcript, stats: meta.stats, model: meta.model, resumed: Boolean(meta.resumptionHandle) }
      : { transcript: [], stats: null, model: null, resumed: false };
  }

  async close(reason = 'done') {
    try { this.upstream?.close(1000, reason); } catch {}
    try { for (const ws of this.ctx.getWebSockets()) ws.close(1000, reason); } catch {}
  }

  async alarm() {
    const meta = this.meta ?? (await this.ctx.storage.get<SessionMeta>('meta'));
    const idle = Date.now() - (meta?.lastActivity ?? 0);
    if (idle > 120_000) {
      await this.close('idle timeout');
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
}

// ---------------------------------------------------------------- helpers

/**
 * The setup frame is built by the shared client (gemini.ts) so the relay, the worker
 * and any direct-mode path cannot drift apart: field placement in this message is
 * load-bearing (modalities and voice inside generationConfig, tools/transcriptions/
 * resumption at the top), and the thinking level is a property of the model.
 */
function setupFrame(env: Env, meta: SessionMeta) {
  const model = meta.model || MODEL_FOR(env, 'live');
  return JSON.stringify(liveSetup({
    model,
    systemInstruction: meta.systemInstruction,
    tools: LIVE_TOOLS,
    resumptionHandle: meta.resumptionHandle,
    // Only the extended-thinking model takes a level, and it *requires* one; deep
    // sessions are exactly the ones that want the reasoning.
    thinking: meta.deep ? 'high' : 'low',
  }));
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function blobToString(data: any): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data?.text) return await data.text();
  return String(data);
}

export interface LiveStub {
  setMeta(meta: Partial<SessionMeta>): Promise<void>;
  fetch(req: Request): Promise<Response>;
  collect(): Promise<{ transcript: { role: string; text: string; ts: number }[]; stats: any; model: string | null; resumed: boolean }>;
  close(reason?: string): Promise<void>;
}
