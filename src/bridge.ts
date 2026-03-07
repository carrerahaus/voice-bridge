// Generic Twilio <-> Gemini Live API bridge
// Handles: codec conversion, heartbeat, interruptions, transcriptions

import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } from "@google/genai";
import { WebSocket } from "ws";
import { mulawToPcm16k, pcm24kToMulaw } from "./codec.js";
import type { AgentConfig, CallSession, BridgeCallbacks } from "./types.js";

const DEFAULT_MODEL = "gemini-2.5-flash-native-audio-latest";
const DEFAULT_VOICE = "Aoede";
const SILENT_CHUNK_B64 = Buffer.alloc(320).toString("base64"); // 10ms at 16kHz
const HEARTBEAT_INTERVAL = 5000;

export class VoiceBridge {
  private sessions: Map<string, CallSession> = new Map();
  private ai: GoogleGenAI;
  private callbacks: BridgeCallbacks;

  constructor(geminiApiKey: string, callbacks: BridgeCallbacks = {}) {
    this.ai = new GoogleGenAI({ apiKey: geminiApiKey });
    this.callbacks = callbacks;
  }

  private log(session: CallSession, event: string, data?: Record<string, unknown>): void {
    const info: Record<string, unknown> = {
      call: session.callSid,
      stream: session.streamSid,
      event,
      elapsed: Math.round((Date.now() - session.startTime.getTime()) / 1000),
      ...data,
    };
    console.log(`[voice-bridge]`, JSON.stringify(info));
  }

  async startSession(
    twilioWs: WebSocket,
    streamSid: string,
    callSid: string,
    agent: AgentConfig,
  ): Promise<void> {
    const session: CallSession = {
      streamSid,
      callSid,
      twilioWs,
      geminiSession: null,
      agent,
      startTime: new Date(),
      isClosing: false,
      isDraining: false,
      isSpeaking: false,
      heartbeatTimer: null,
      lastInputAt: 0,
    };

    this.sessions.set(streamSid, session);

    try {
      await this.connectGemini(session);
    } catch (error) {
      this.log(session, "gemini_connect_error", { error: String(error) });
      this.endSession(streamSid);
    }
  }

  private async connectGemini(session: CallSession): Promise<void> {
    const agent = session.agent;

    session.geminiSession = await this.ai.live.connect({
      model: agent.model || DEFAULT_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        thinkingConfig: { thinkingBudget: agent.thinkingBudget ?? 0 },
        systemInstruction: agent.systemPrompt,
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: agent.voice || DEFAULT_VOICE },
          },
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
            silenceDurationMs: 300,
            prefixPaddingMs: 20,
          },
        },
        tools: [{
          functionDeclarations: [{
            name: "end_call",
            description: "End the phone call. Call this AFTER you have already said your goodbye.",
          }],
        }],
      },
      callbacks: {
        onopen: () => {
          this.log(session, "gemini_connected");
        },
        onmessage: (message: any) => {
          if (message.setupComplete) {
            this.log(session, "gemini_setup_complete");
            this.startHeartbeat(session);
            if (agent.greeting) {
              setTimeout(() => this.sendGreeting(session), 500);
            }
          }
          if (message.toolCall) {
            this.handleToolCall(session, message.toolCall);
          }
          if (message.serverContent) {
            this.handleServerContent(session, message.serverContent);
          }
          this.forwardAudioToTwilio(session, message);
        },
        onerror: (error: any) => {
          this.log(session, "gemini_error", { error: String(error) });
        },
        onclose: (event: any) => {
          this.log(session, "gemini_closed", {
            code: event?.code,
            reason: event?.reason,
            wasClean: event?.wasClean,
            isDraining: session.isDraining,
            isClosing: session.isClosing,
          });
          if (!session.isClosing) this.endSession(session.streamSid);
        },
      },
    });
  }

  private handleServerContent(session: CallSession, sc: any): void {
    if (sc.inputTranscription?.text) {
      session.lastInputAt = Date.now();
      this.callbacks.onInputTranscription?.(session.streamSid, sc.inputTranscription.text);
    }
    if (sc.outputTranscription?.text) {
      this.callbacks.onOutputTranscription?.(session.streamSid, sc.outputTranscription.text);
    }
    if (sc.modelTurn?.parts) {
      if (!session.isSpeaking) {
        session.isSpeaking = true;
        if (session.lastInputAt) {
          this.callbacks.onLatency?.(session.streamSid, Date.now() - session.lastInputAt);
          session.lastInputAt = 0;
        }
      }
    }
    if (sc.turnComplete || sc.interrupted) {
      session.isSpeaking = false;
      if (sc.interrupted) {
        this.clearTwilioAudio(session);
        this.callbacks.onInterruption?.(session.streamSid);
      }
    }
  }

  private handleToolCall(session: CallSession, toolCall: any): void {
    for (const fc of toolCall.functionCalls || []) {
      this.log(session, "tool_call", { name: fc.name, args: fc.args });

      if (fc.name === "end_call") {
        if (session.isDraining) {
          this.log(session, "end_call_duplicate_ignored");
          return;
        }
        session.isDraining = true;

        this.log(session, "end_call_draining");

        // 1. SORDA: stop heartbeat + stop forwarding audio to Gemini
        //    (prevents Gemini 1008 race condition on sendRealtimeInput during tool call)
        if (session.heartbeatTimer) {
          clearInterval(session.heartbeatTimer);
          session.heartbeatTimer = null;
        }
        // handleTwilioAudio checks isDraining — no more audio sent to Gemini

        // 2. MUDA: stop forwarding Gemini audio to Twilio
        //    forwardAudioToTwilio checks isDraining — no new audio to caller

        // 3. DRAIN: let already-buffered Twilio audio finish playing, then hang up
        setTimeout(() => this.endSession(session.streamSid), 2000);
      }
    }
  }

  private startHeartbeat(session: CallSession): void {
    if (session.heartbeatTimer) return;
    session.heartbeatTimer = setInterval(() => {
      if (!session.geminiSession || session.isClosing || session.isDraining) return;
      try {
        session.geminiSession.sendRealtimeInput({
          audio: { data: SILENT_CHUNK_B64, mimeType: "audio/pcm;rate=16000" },
        });
      } catch (error) {
        this.log(session, "heartbeat_error", { error: String(error) });
      }
    }, HEARTBEAT_INTERVAL);
  }

  private sendGreeting(session: CallSession): void {
    if (!session.geminiSession || !session.agent.greeting) return;
    try {
      this.log(session, "greeting_sent");
      session.geminiSession.sendClientContent({
        turns: session.agent.greeting,
        turnComplete: true,
      });
    } catch (error) {
      this.log(session, "greeting_error", { error: String(error) });
    }
  }

  handleTwilioAudio(streamSid: string, base64Mulaw: string): void {
    const session = this.sessions.get(streamSid);
    if (!session?.geminiSession || session.isDraining) return; // SORDA: ignore audio after end_call

    try {
      session.geminiSession.sendRealtimeInput({
        audio: { data: mulawToPcm16k(base64Mulaw), mimeType: "audio/pcm;rate=16000" },
      });
    } catch (error) {
      this.log(session, "twilio_audio_forward_error", { error: String(error) });
    }
  }

  private forwardAudioToTwilio(session: CallSession, message: any): void {
    if (session.isDraining) return; // MUDA: no new audio to caller after end_call
    if (!message.serverContent?.modelTurn?.parts) return;
    for (const part of message.serverContent.modelTurn.parts) {
      if (part.inlineData?.mimeType?.startsWith("audio/")) {
        this.sendAudioToTwilio(session, part.inlineData.data);
      }
    }
  }

  private clearTwilioAudio(session: CallSession): void {
    if (session.twilioWs.readyState !== WebSocket.OPEN) return;
    session.twilioWs.send(JSON.stringify({
      event: "clear",
      streamSid: session.streamSid,
    }));
  }

  private sendAudioToTwilio(session: CallSession, pcm24kBase64: string): void {
    if (session.twilioWs.readyState !== WebSocket.OPEN) return;
    try {
      session.twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: { payload: pcm24kToMulaw(pcm24kBase64) },
      }));
    } catch (error) {
      this.log(session, "twilio_send_error", { error: String(error) });
    }
  }

  async endSession(streamSid: string): Promise<void> {
    const session = this.sessions.get(streamSid);
    if (!session) return;
    session.isClosing = true;

    const duration = Math.round((Date.now() - session.startTime.getTime()) / 1000);
    this.log(session, "session_ending", {
      duration,
      isDraining: session.isDraining,
      twilioWsState: session.twilioWs.readyState,
    });
    this.callbacks.onSessionEnd?.(streamSid, duration);

    if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
    if (session.geminiSession) {
      try { session.geminiSession.close(); } catch (error) {
        this.log(session, "gemini_close_error", { error: String(error) });
      }
    }
    // Close Twilio WebSocket to actually hang up the call
    if (session.twilioWs.readyState === WebSocket.OPEN) {
      this.log(session, "twilio_ws_closing");
      session.twilioWs.close();
    }
    this.sessions.delete(streamSid);
  }

  getSession(streamSid: string): CallSession | undefined {
    return this.sessions.get(streamSid);
  }
}
