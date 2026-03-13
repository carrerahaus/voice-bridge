import { createServer } from "http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { VoiceBridge } from "./bridge.js";
import type { AgentConfig } from "./types.js";

const PORT = parseInt(process.env.PORT || "8080");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const bridge = new VoiceBridge(GEMINI_API_KEY, {
  onInputTranscription: (_sid, text) => console.log(`🎤 "${text}"`),
  onOutputTranscription: (_sid, text) => console.log(`🤖 "${text}"`),
  onLatency: (_sid, ms) => console.log(`⏱ ${ms}ms`),
  onInterruption: () => console.log(`⚡ Interrupted`),
  onSessionEnd: (sid, dur) => console.log(`📞 Session ${sid} ended — ${dur}s`),
});

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "voice-bridge" });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", (ws: WebSocket) => {
  let currentStreamSid: string | null = null;
  let currentCallSid: string | null = null;

  ws.on("message", async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.event) {
        case "connected":
          console.log(`[ws] Twilio connected`);
          break;

        case "start": {
          const { streamSid, callSid, customParameters } = message.start;
          currentStreamSid = streamSid;
          currentCallSid = callSid;

          let agent: AgentConfig;

          if (customParameters?.configUrl) {
            // Fetch config from URL (prompt too large for TwiML)
            console.log(`[ws] Fetching config from ${customParameters.configUrl}`);
            const resp = await fetch(customParameters.configUrl);
            if (!resp.ok) {
              console.error(`[ws] Config fetch failed: ${resp.status}`);
              ws.close();
              break;
            }
            const config = await resp.json() as Record<string, string>;
            agent = {
              model: config.model,
              systemPrompt: config.systemPrompt || "You are a helpful voice assistant.",
              voice: config.voice,
              greeting: config.greeting,
              thinkingBudget: config.thinkingBudget ? parseInt(config.thinkingBudget) : 0,
              callbackUrl: config.callbackUrl,
            };
          } else {
            // Inline config from TwiML parameters (backward compatible)
            agent = {
              model: customParameters?.model,
              systemPrompt: customParameters?.systemPrompt || "You are a helpful voice assistant.",
              voice: customParameters?.voice,
              greeting: customParameters?.greeting,
              thinkingBudget: customParameters?.thinkingBudget
                ? parseInt(customParameters.thinkingBudget)
                : 0,
              callbackUrl: customParameters?.callbackUrl,
            };
          }

          console.log(`[ws] Stream start — call=${callSid} stream=${streamSid} voice=${agent.voice} prompt=${agent.systemPrompt.slice(0, 80)}...`);
          await bridge.startSession(ws, streamSid, callSid, agent);
          break;
        }

        case "media": {
          if (message.streamSid && message.media.track === "inbound") {
            bridge.handleTwilioAudio(message.streamSid, message.media.payload);
          }
          break;
        }

        case "stop":
          console.log(`[ws] Stream stop — call=${currentCallSid} stream=${message.streamSid}`);
          if (message.streamSid) {
            await bridge.endSession(message.streamSid);
          }
          currentStreamSid = null;
          currentCallSid = null;
          break;
      }
    } catch (error) {
      console.error(`[ws] Message error (call=${currentCallSid}):`, error);
    }
  });

  ws.on("close", async (code, reason) => {
    console.log(`[ws] Twilio WS closed — call=${currentCallSid} code=${code} reason=${reason?.toString()}`);
    if (currentStreamSid) {
      await bridge.endSession(currentStreamSid);
    }
  });

  ws.on("error", (error) => {
    console.error(`[ws] Twilio WS error — call=${currentCallSid}:`, error);
  });
});

server.listen(PORT, () => {
  console.log(`voice-bridge running on port ${PORT}`);
});
