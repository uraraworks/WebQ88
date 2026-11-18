// 転送可能な Float32 ステレオを AudioWorklet に送り、共有メモリを使わない。
const source = `
class Q88Audio extends AudioWorkletProcessor {
  constructor() {
    super(); this.queue = []; this.count = 0; this.offset = 0; this.phase = 0;
    this.rate = 44100; this.fade = 0; this.lastL = 0; this.lastR = 0; this.blocks = 0;
    this.port.onmessage = e => {
      const m = e.data;
      if (m.t === 'flush') { this.queue = []; this.count = 0; this.offset = 0; this.phase = 0; this.fade = 0; this.lastL = this.lastR = 0; }
      else if (m.t === 'rate') { this.rate = m.rate; }
      else if (m.t === 'audio') {
        this.queue.push(m.samples); this.count += m.samples.length / 2;
        if (this.count > this.rate * 0.25) {
          while (this.queue.length > 1) {
            const n = this.queue[0].length / 2 - this.offset;
            if (this.count - n < this.rate * 0.08) break;
            this.queue.shift(); this.count -= n; this.offset = 0;
          }
        }
      }
    };
  }
  peek(i, ch) {
    for (let n = 0; n < this.queue.length; n++) {
      const a = this.queue[n], start = n === 0 ? this.offset : 0, len = a.length / 2 - start;
      if (i < len) return a[(start + i) * 2 + ch];
      i -= len;
    }
    return null;
  }
  consume(n) {
    while (n > 0 && this.queue.length) {
      const left = this.queue[0].length / 2 - this.offset, take = Math.min(n, left);
      this.offset += take; this.count -= take; n -= take;
      if (this.offset === this.queue[0].length / 2) { this.queue.shift(); this.offset = 0; }
    }
  }
  process(_in, out) {
    const l = out[0][0], r = out[0][1], step = this.rate / sampleRate, fadeStep = 1 / Math.max(1, sampleRate * 0.003);
    for (let i = 0; i < l.length; i++) {
      const a = this.peek(0, 0), b = this.peek(0, 1), c = this.peek(1, 0), d = this.peek(1, 1);
      if (a === null || c === null) {
        this.fade = Math.max(0, this.fade - fadeStep); l[i] = this.lastL * this.fade; r[i] = this.lastR * this.fade;
      } else {
        this.fade = Math.min(1, this.fade + fadeStep);
        this.lastL = a + (c - a) * this.phase; this.lastR = b + (d - b) * this.phase;
        l[i] = this.lastL * this.fade; r[i] = this.lastR * this.fade;
        this.phase += step; const n = Math.floor(this.phase); this.phase -= n; this.consume(n);
      }
    }
    if (++this.blocks % 4 === 0) this.port.postMessage({ q: this.count / this.rate });
    return true;
  }
}
registerProcessor('webq88-audio', Q88Audio);`;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private rate = 44100;
  private muted = false;
  private volume = 1;
  private paused = false;
  private driveSound = false;
  private driveLamp = 0;
  private lastDriveClick = 0;
  onQueue: ((seconds: number) => void) | null = null;

  start(): void {
    if (this.ctx) { if (!this.paused) void this.ctx.resume().catch(() => {}); return; }
    try {
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (session) session.type = 'playback';
      const ctx = new AudioContext({ sampleRate: 44100 });
      this.ctx = ctx;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
      void ctx.audioWorklet.addModule(url).then(() => {
        const node = new AudioWorkletNode(ctx, 'webq88-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        const gain = ctx.createGain(); this.node = node; this.gain = gain;
        this.updateGain(); node.connect(gain).connect(ctx.destination);
        node.port.onmessage = e => this.onQueue?.(e.data.q);
        node.port.postMessage({ t: 'rate', rate: this.rate });
      }).catch(err => { console.error('音声の初期化に失敗しました', err); }).finally(() => URL.revokeObjectURL(url));
    } catch (err) { console.error('音声の初期化に失敗しました', err); }
  }
  setRate(rate: number): void { this.flush(); this.rate = rate; this.node?.port.postMessage({ t: 'rate', rate }); }
  push(buffer: ArrayBuffer): void {
    if (!this.node || this.paused || this.ctx?.state !== 'running') return;
    const samples = new Float32Array(buffer); this.node.port.postMessage({ t: 'audio', samples }, [buffer]);
  }
  flush(): void { this.node?.port.postMessage({ t: 'flush' }); }
  setPaused(paused: boolean): void { this.paused = paused; this.flush(); this.updateGain(); }
  setSettings(muted: boolean, volume: number): void { this.muted = muted; this.volume = volume; this.updateGain(); }
  setDriveSound(enabled: boolean): void { this.driveSound = enabled; this.driveLamp = 0; }
  setDriveLamp(mask: number): void {
    const rising = mask & ~this.driveLamp;
    this.driveLamp = mask;
    const now = performance.now();
    if (!this.driveSound || !mask || (!rising && now - this.lastDriveClick < 90)) return;
    if (!this.ctx || !this.gain || this.ctx.state !== 'running' || this.paused || this.muted) return;
    this.lastDriveClick = now;
    const length = Math.ceil(this.ctx.sampleRate * 0.012);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) samples[i] = (Math.random() * 2 - 1) * Math.exp(-i / (length * 0.18)) * 0.12;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.start();
  }
  private updateGain(): void { if (this.gain) this.gain.gain.value = this.muted || this.paused ? 0 : this.volume; }
}
