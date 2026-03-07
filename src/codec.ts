// ITU-T G.711 mu-law codec
// Standard from 1972 — this code will never need to change.

const MULAW_DECODE: Int16Array = new Int16Array(256);
const MULAW_BIAS = 33;
const MULAW_CLIP = 32635;
const EXP_LUT = [0, 132, 396, 924, 1980, 4092, 8316, 16764];

for (let i = 0; i < 256; i++) {
  const b = ~i;
  const sign = b & 0x80;
  const exponent = (b >> 4) & 0x07;
  const mantissa = b & 0x0f;
  let sample = EXP_LUT[exponent] + (mantissa << (exponent + 3));
  if (sign !== 0) sample = -sample;
  MULAW_DECODE[i] = sample;
}

function linearToMulaw(pcmSample: number): number {
  const sign = pcmSample < 0 ? 0x80 : 0;
  if (pcmSample < 0) pcmSample = -pcmSample;
  if (pcmSample > MULAW_CLIP) pcmSample = MULAW_CLIP;
  pcmSample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; exponent > 0; exponent--, expMask >>= 1) {
    if (pcmSample & expMask) break;
  }
  const mantissa = (pcmSample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode mulaw 8kHz → PCM 16kHz (for Gemini input) */
export function mulawToPcm16k(base64Mulaw: string): string {
  const mulawBuffer = Buffer.from(base64Mulaw, "base64");
  const pcm8k = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm8k[i] = MULAW_DECODE[mulawBuffer[i]];
  }
  // Upsample 8kHz → 16kHz (linear interpolation)
  const pcm16k = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    pcm16k[i * 2] = pcm8k[i];
    const next = i + 1 < pcm8k.length ? pcm8k[i + 1] : pcm8k[i];
    pcm16k[i * 2 + 1] = Math.round((pcm8k[i] + next) / 2);
  }
  return Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength).toString("base64");
}

/** Encode PCM 24kHz → mulaw 8kHz (for Twilio output) */
export function pcm24kToMulaw(base64Pcm24k: string): string {
  const pcmBuffer = Buffer.from(base64Pcm24k, "base64");
  const pcm24k = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
  const pcm8kLength = Math.floor(pcm24k.length / 3);
  const mulaw = new Uint8Array(pcm8kLength);
  for (let i = 0; i < pcm8kLength; i++) {
    mulaw[i] = linearToMulaw(pcm24k[i * 3]);
  }
  return Buffer.from(mulaw).toString("base64");
}
