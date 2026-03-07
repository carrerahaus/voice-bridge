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
      isSpeaking: false,
      heartbeatTimer: null,
      lastInputAt: 0,
    };

    this.sessions.set(streamSid, session);

    try {
      await this.connectGemini(session);
    } catch (error) {
      console.error(`[voice-bridge] Error connecting to Gemini:`, error);
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
      },
      callbacks: {
        onopen: () => {},
        onmessage: (message: any) => {
          if (message.setupComplete) {
            this.startHeartbeat(session);
            if (agent.greeting) {
              setTimeout(() => this.sendGreeting(session), 500);
            }
          }
          if (message.serverContent) {
            this.handleServerContent(session, message.serverContent);
          }
          this.forwardAudioToTwilio(session, message);
        },
        onerror: (error: any) => {
          console.error(`[voice-bridge] Session error:`, error);
        },
        onclose: () => {
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

  private startHeartbeat(session: CallSession): void {
    if (session.heartbeatTimer) return;
    session.heartbeatTimer = setInterval(() => {
      if (!session.geminiSession || session.isClosing) return;
      try {
        session.geminiSession.sendRealtimeInput({
          audio: { data: SILENT_CHUNK_B64, mimeType: "audio/pcm;rate=16000" },
        });
      } catch {}
    }, HEARTBEAT_INTERVAL);
  }

  private sendGreeting(session: CallSession): void {
    if (!session.geminiSession || !session.agent.greeting) return;
    try {
      session.geminiSession.sendClientContent({
        turns: session.agent.greeting,
        turnComplete: true,
      });
    } catch (error) {
      console.error(`[voice-bridge] Greeting error:`, error);
    }
  }

  handleTwilioAudio(streamSid: string, base64Mulaw: string): void {
    const session = this.sessions.get(streamSid);
    if (!session?.geminiSession) return;

    try {
      session.geminiSession.sendRealtimeInput({
        audio: { data: mulawToPcm16k(base64Mulaw), mimeType: "audio/pcm;rate=16000" },
      });
    } catch {}
  }

  private forwardAudioToTwilio(session: CallSession, message: any): void {
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
    } catch {}
  }

  async endSession(streamSid: string): Promise<void> {
    const session = this.sessions.get(streamSid);
    if (!session) return;
    session.isClosing = true;

    const duration = Math.round((Date.now() - session.startTime.getTime()) / 1000);
    this.callbacks.onSessionEnd?.(streamSid, duration);

    if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
    if (session.geminiSession) {
      try { session.geminiSession.close(); } catch {}
    }
    this.sessions.delete(streamSid);
  }

  getSession(streamSid: string): CallSession | undefined {
    return this.sessions.get(streamSid);
  }
}
