export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private rcsGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  public muted = false;
  private initialized = false;

  public unlock(): void {
    if (this.initialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return;
    }
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;

      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 0.42;
      this.masterGain.connect(this.ctx.destination);

      // Generate 2 seconds of smooth brown/pink noise buffer for engine roar & RCS
      const sampleRate = this.ctx.sampleRate;
      const len = sampleRate * 2;
      this.noiseBuffer = this.ctx.createBuffer(1, len, sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      let lastOut = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        lastOut = (lastOut + 0.04 * white) / 1.04;
        data[i] = Math.max(-1, Math.min(1, lastOut * 3.2 + white * 0.22));
      }

      // Continuous main engine roar loop
      const engineSrc = this.ctx.createBufferSource();
      engineSrc.buffer = this.noiseBuffer;
      engineSrc.loop = true;

      this.engineFilter = this.ctx.createBiquadFilter();
      this.engineFilter.type = 'lowpass';
      this.engineFilter.frequency.value = 320;
      this.engineFilter.Q.value = 1.1;

      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0;

      engineSrc.connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.masterGain);
      engineSrc.start();

      // Continuous high-passed cold-gas RCS hiss loop
      const rcsSrc = this.ctx.createBufferSource();
      rcsSrc.buffer = this.noiseBuffer;
      rcsSrc.loop = true;

      const rcsFilter = this.ctx.createBiquadFilter();
      rcsFilter.type = 'bandpass';
      rcsFilter.frequency.value = 2400;
      rcsFilter.Q.value = 1.6;

      this.rcsGain = this.ctx.createGain();
      this.rcsGain.gain.value = 0;

      rcsSrc.connect(rcsFilter);
      rcsFilter.connect(this.rcsGain);
      this.rcsGain.connect(this.masterGain);
      rcsSrc.start();

      this.initialized = true;
    } catch {
      // Gracefully ignore if browser restricts audio
    }
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.42, this.ctx.currentTime, 0.04);
    }
  }

  public update(throttle: number, rcsActivity: number, timeScale: number, paused: boolean): void {
    if (!this.initialized || !this.ctx || !this.engineGain || !this.engineFilter || !this.rcsGain) {
      return;
    }
    const now = this.ctx.currentTime;
    if (paused || this.muted) {
      this.engineGain.gain.setTargetAtTime(0, now, 0.05);
      this.rcsGain.gain.setTargetAtTime(0, now, 0.04);
      return;
    }

    const engLevel = throttle > 0.01 ? 0.14 + throttle * 0.72 : 0;
    const freq = (190 + throttle * 520) * Math.max(0.35, Math.min(1.2, Math.sqrt(timeScale)));
    this.engineGain.gain.setTargetAtTime(engLevel, now, 0.05);
    this.engineFilter.frequency.setTargetAtTime(freq, now, 0.06);

    const rcsLevel = rcsActivity > 0.12 ? Math.min(0.18, rcsActivity * 0.16) : 0;
    this.rcsGain.gain.setTargetAtTime(rcsLevel, now, 0.03);
  }

  public playExplosion(): void {
    if (!this.initialized || !this.ctx || !this.masterGain || !this.noiseBuffer || this.muted) return;
    const now = this.ctx.currentTime;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(520, now);
    filter.frequency.exponentialRampToValueAtTime(55, now + 1.8);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(1.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 2.1);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start(now);
    src.stop(now + 2.15);
  }

  public playLegDeploy(): void {
    if (!this.initialized || !this.ctx || !this.masterGain || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(78, now + 0.45);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.24, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.48);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.5);
  }

  public playLandingSuccess(): void {
    if (!this.initialized || !this.ctx || !this.masterGain || this.muted) return;
    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      const osc = this.ctx!.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.11);

      const gain = this.ctx!.createGain();
      gain.gain.setValueAtTime(0.001, now + i * 0.11);
      gain.gain.linearRampToValueAtTime(0.16, now + i * 0.11 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.11 + 0.45);

      osc.connect(gain);
      gain.connect(this.masterGain!);
      osc.start(now + i * 0.11);
      osc.stop(now + i * 0.11 + 0.48);
    });
  }
}
