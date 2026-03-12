import type { Session } from "@google/genai";
import type { WebSocket } from "ws";

export interface AgentConfig {
  /** Gemini model ID */
  model?: string;
  /** System instruction for the agent */
  systemPrompt: string;
  /** Voice name (e.g. "Aoede", "Puck", "Kore") */
  voice?: string;
  /** Initial message to trigger the agent's greeting */
  greeting?: string;
  /** Thinking budget (0 = disabled for low latency) */
  thinkingBudget?: number;
  /** URL to POST transcript when call ends (fire-and-forget) */
  callbackUrl?: string;
}

export interface TranscriptEntry {
  role: "user" | "agent";
  text: string;
}

export interface CallSession {
  streamSid: string;
  callSid: string;
  twilioWs: WebSocket;
  geminiSession: Session | null;
  agent: AgentConfig;
  startTime: Date;
  isClosing: boolean;
  isDraining: boolean;
  isSpeaking: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  lastInputAt: number;
  transcript: TranscriptEntry[];
}

export interface BridgeCallbacks {
  /** Called when user speech is transcribed */
  onInputTranscription?: (streamSid: string, text: string) => void;
  /** Called when agent speech is transcribed */
  onOutputTranscription?: (streamSid: string, text: string) => void;
  /** Called with latency measurement (ms from last user input to first agent response) */
  onLatency?: (streamSid: string, ms: number) => void;
  /** Called when agent is interrupted by user */
  onInterruption?: (streamSid: string) => void;
  /** Called when session ends */
  onSessionEnd?: (streamSid: string, durationSec: number) => void;
}
