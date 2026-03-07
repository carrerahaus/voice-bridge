# voice-bridge

Twilio Media Streams ↔ Gemini Live API bridge. Handles codec conversion, VAD, interruptions, heartbeat, and transcriptions.

## Architecture

```
Twilio (mulaw 8kHz) → WebSocket → voice-bridge → Gemini Live API (PCM 16kHz/24kHz)
```

Your application server builds TwiML that connects a phone call to this bridge via `<Stream>`. The bridge opens a Gemini Live session and forwards audio bidirectionally, converting between G.711 mu-law (telephony) and PCM (Gemini).

## How it works

1. Twilio sends a `start` event with custom parameters (`systemPrompt`, `voice`, `greeting`, etc.)
2. Bridge opens a Gemini Live session with those parameters
3. Inbound audio: mulaw 8kHz → PCM 16kHz → Gemini
4. Outbound audio: PCM 24kHz → mulaw 8kHz → Twilio
5. Heartbeat sends silent audio every 5s to keep the Gemini session alive
6. On interruption, sends `clear` to Twilio to stop buffered playback

## Setup

```bash
npm install
cp .env.example .env  # add your GEMINI_API_KEY
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Google AI API key with Gemini Live access |
| `PORT` | No | Server port (default: 8080) |

## Run locally

```bash
npm run dev
```

## Deploy to Cloud Run

```bash
gcloud run deploy voice-bridge \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=your-key \
  --timeout 3600 \
  --session-affinity
```

## TwiML integration

Your application server generates TwiML that points to this bridge:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://your-voice-bridge-url.run.app/stream">
      <Parameter name="systemPrompt" value="You are a helpful assistant."/>
      <Parameter name="voice" value="Aoede"/>
      <Parameter name="greeting" value="Say hello to the caller."/>
    </Stream>
  </Connect>
</Response>
```

### Custom parameters

| Parameter | Default | Description |
|---|---|---|
| `systemPrompt` | "You are a helpful voice assistant." | System instruction for Gemini |
| `voice` | "Aoede" | Gemini voice name (Aoede, Puck, Kore, etc.) |
| `greeting` | — | Initial message to trigger the agent's first utterance |
| `model` | "gemini-2.5-flash-native-audio-latest" | Gemini model ID |
| `thinkingBudget` | "0" | Thinking budget (0 = disabled for low latency) |

## Project structure

```
src/
  server.ts   — Express + WebSocket server
  bridge.ts   — VoiceBridge class (Gemini session management)
  codec.ts    — G.711 mu-law ↔ PCM conversion + resampling
  types.ts    — TypeScript interfaces
Dockerfile    — Multi-stage build for Cloud Run
```

## Key design decisions

- **Heartbeat**: Gemini Live sessions go dormant without periodic audio input. A 10ms silent chunk every 5s keeps them alive.
- **thinkingBudget: 0**: Gemini 2.5 Flash has thinking enabled by default. Disabling it drops latency from ~5s to ~1s.
- **VAD tuning**: `startOfSpeechSensitivity: HIGH` + `endOfSpeechSensitivity: LOW` + `silenceDurationMs: 300` gives responsive interruptions without cutting off the caller mid-sentence.
- **Twilio `clear` event**: When Gemini detects an interruption, we immediately tell Twilio to flush its audio buffer so the caller doesn't hear stale audio.

## License

MIT
