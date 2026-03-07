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

  ws.on("message", async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.event) {
        case "connected":
          break;

        case "start": {
          const { streamSid, callSid, customParameters } = message.start;
          currentStreamSid = streamSid;

          const agent: AgentConfig = {
            model: customParameters?.model,
            systemPrompt: customParameters?.systemPrompt || "You are a helpful voice assistant.",
            voice: customParameters?.voice,
            greeting: customParameters?.greeting,
            thinkingBudget: customParameters?.thinkingBudget
              ? parseInt(customParameters.thinkingBudget)
              : 0,
          };

          console.log(`📞 Call started — stream=${streamSid}`);
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
          if (message.streamSid) {
            await bridge.endSession(message.streamSid);
          }
          currentStreamSid = null;
          break;
      }
    } catch (error) {
      console.error("[voice-bridge] Message error:", error);
    }
  });

  ws.on("close", async () => {
    if (currentStreamSid) {
      await bridge.endSession(currentStreamSid);
    }
  });
});

server.listen(PORT, () => {
  console.log(`voice-bridge running on port ${PORT}`);
});
