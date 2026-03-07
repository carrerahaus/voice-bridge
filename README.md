<p align="center">
  <img src="logo.svg" width="120" alt="voice-bridge" />
</p>

<h1 align="center">voice-bridge</h1>

<p align="center">
  Twilio ↔ Gemini Live API bridge in TypeScript.<br/>
  Codec conversion, VAD, interruptions, heartbeat, transcriptions — all handled.
</p>

<p align="center">
  <a href="#architecture">Architecture</a> · <a href="#quickstart">Quickstart</a> · <a href="#deploy">Deploy</a> · <a href="#twiml-integration">TwiML</a> · <a href="#design-decisions">Design</a>
</p>

---

## Architecture

```
Phone call → Twilio (mulaw 8kHz) → WebSocket → voice-bridge → Gemini Live API (PCM 16k/24k)
```

Your app server builds TwiML that connects a call to this bridge via `<Stream>`. The bridge opens a Gemini Live session and forwards audio both ways, converting between G.711 mu-law (telephony) and PCM (Gemini).

## Quickstart

```bash
git clone https://github.com/carrerahaus/voice-bridge.git
cd voice-bridge
npm install
cp .env.example .env  # add your GEMINI_API_KEY
npm run dev
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Google AI API key with Gemini Live access |
| `PORT` | No | Server port (default: 8080) |

## Deploy

### Cloud Run (recommended)

Same Google network as Gemini — lowest latency.

```bash
gcloud run deploy voice-bridge \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=your-key \
  --timeout 3600 \
  --session-affinity
```

### Docker

```bash
docker build -t voice-bridge .
docker run -p 8080:8080 -e GEMINI_API_KEY=your-key voice-bridge
```

## TwiML integration

Your app server generates TwiML pointing to this bridge:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://your-voice-bridge.run.app/stream">
      <Parameter name="systemPrompt" value="You are a helpful assistant."/>
      <Parameter name="voice" value="Aoede"/>
      <Parameter name="greeting" value="Say hello to the caller."/>
    </Stream>
  </Connect>
</Response>
```

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `systemPrompt` | `"You are a helpful voice assistant."` | System instruction for Gemini |
| `voice` | `"Aoede"` | Voice name — Aoede, Puck, Kore, Charon, etc. |
| `greeting` | — | Text prompt to trigger the agent's first utterance |
| `model` | `"gemini-2.5-flash-native-audio-latest"` | Gemini model ID |
| `thinkingBudget` | `"0"` | Thinking budget (0 = disabled for lowest latency) |

## How it works

1. Twilio sends `start` event with custom parameters
2. Bridge opens a Gemini Live session with that config
3. Inbound: mulaw 8kHz → PCM 16kHz → Gemini
4. Outbound: PCM 24kHz → mulaw 8kHz → Twilio
5. Heartbeat sends 10ms of silence every 5s to keep the session alive
6. On interruption, sends `clear` to Twilio to flush buffered audio

## Project structure

```
src/
  server.ts   Express + WebSocket server
  bridge.ts   VoiceBridge class — Gemini session lifecycle
  codec.ts    G.711 mu-law ↔ PCM conversion + resampling
  types.ts    TypeScript interfaces
Dockerfile    Multi-stage build for Cloud Run
```

## Design decisions

**Heartbeat** — Gemini Live sessions go dormant without periodic audio. A 10ms silent chunk at 16kHz every 5 seconds keeps them alive. Discovered from [Google's official sample](https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/sample-apps/gemini-live-telephony-app).

**Thinking disabled** — Gemini 2.5 Flash has thinking enabled by default. Setting `thinkingBudget: 0` drops response latency from ~5s to under 1s.

**VAD tuning** — `startOfSpeechSensitivity: HIGH` catches interruptions fast. `endOfSpeechSensitivity: LOW` with `silenceDurationMs: 300` avoids cutting off mid-sentence.

**Twilio `clear`** — When Gemini detects an interruption, we tell Twilio to flush its audio buffer immediately. Without this, the caller hears ~8s of stale audio before the interruption takes effect.

**Zero dependencies for codec** — G.711 mu-law is a [1972 ITU-T standard](https://en.wikipedia.org/wiki/G.711). The encode/decode table and resampling are implemented in ~60 lines. No native modules, no `python-samplerate`, no `alawmulaw`.

## Latency

Measured end-to-end (user stops speaking → first audio response from agent):

| Setup | Latency |
|---|---|
| Thinking ON, Railway | ~5.4s |
| Thinking OFF, Railway | ~1.7s |
| Thinking OFF, Cloud Run | ~876ms |

Cloud Run in `us-central1` benefits from being on the same Google network as Gemini.

## Contact

Questions or suggestions? **hola@carrera.haus**

Built by [Carrera Haus](https://carrera.haus) — Lima, Peru.

## License

MIT
