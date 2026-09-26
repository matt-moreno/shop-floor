/** Tiny synthesized spindle hum plus cutting noise. Opt-in. */
export class Sound {
  private ctx: AudioContext | null = null;
  private hum!: OscillatorNode;
  private humGain!: GainNode;
  private cutGain!: GainNode;
  private cutFilter!: BiquadFilterNode;
  private cutLevel = 0;

  enable() {
    if (this.ctx) return void this.ctx.resume();
    const ctx = (this.ctx = new AudioContext());
    const master = ctx.createGain();
    master.gain.value = 0.25;
    master.connect(ctx.destination);

    this.hum = ctx.createOscillator();
    this.hum.type = "sawtooth";
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    this.hum.connect(lp).connect(this.humGain).connect(master);
    this.hum.start();

    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    this.cutFilter = ctx.createBiquadFilter();
    this.cutFilter.type = "bandpass";
    this.cutFilter.Q.value = 4;
    this.cutGain = ctx.createGain();
    this.cutGain.gain.value = 0;
    noise.connect(this.cutFilter).connect(this.cutGain).connect(master);
    noise.start();
  }

  disable() {
    void this.ctx?.suspend();
  }

  update(rpm: number, removed: number, dt: number) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const t = this.ctx.currentTime;
    this.hum.frequency.setTargetAtTime(40 + rpm / 40, t, 0.3);
    this.humGain.gain.setTargetAtTime(rpm > 0 ? 0.12 : 0, t, 0.25);
    const target = removed > 0 ? Math.min(1, 0.3 + removed / 40) : 0;
    this.cutLevel += (target - this.cutLevel) * Math.min(1, dt * 12);
    this.cutGain.gain.setTargetAtTime(this.cutLevel * 0.5, t, 0.03);
    this.cutFilter.frequency.setTargetAtTime(1200 + rpm / 3, t, 0.1);
  }
}
