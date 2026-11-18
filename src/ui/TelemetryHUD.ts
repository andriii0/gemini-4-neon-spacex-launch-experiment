import {
  CameraMode,
  ControlMode,
  FailureReason,
  ReplayEvent,
  ScenarioConfig,
  TelemetryData
} from '../types';
import { SCENARIOS } from '../scenarios';

export interface HUDCallbacks {
  onSelectScenario: (scenario: ScenarioConfig) => void;
  onApplyCustomLaunch: (alt: number, offsetX: number, fuel: number) => void;
  onToggleControlMode: () => void;
  onToggleSAS: () => void;
  onSelectCamera: (mode: CameraMode) => void;
  onWindSpeedChange: (speed: number) => void;
  onWindGustChange: (gust: number) => void;
  onInjectGust: () => void;
  onToggleLegs: () => void;
  onManualThrottleSlider: (val01: number) => void;
  onLiveSpeedChange: (speed: number) => void;
  onReset: () => void;
  onTogglePause: () => void;
  onToggleMute: () => void;
  onEnterReplay: (speed?: number, fromEndSec?: number) => void;
  onExitReplay: () => void;
  onReplaySpeedChange: (speed: number) => void;
  onReplaySeek: (time: number) => void;
  onReplayTogglePlay: () => void;
}

const FAILURE_LABELS: Record<FailureReason, string> = {
  NONE: 'Nominal landing complete',
  HARD_IMPACT: 'Hard impact exceeded landing leg structural limit (RUD)',
  LEGS_NOT_DEPLOYED: 'Touchdown attempted without landing legs deployed & locked',
  TIP_OVER: 'Excessive tilt / lateral velocity caused booster tip-over',
  OFF_PAD_OCEAN: 'Missed ASDS landing platform — ocean splashdown',
  FUEL_EXHAUSTED: 'Propellant depleted prior to touchdown — engine flameout',
  STRUCTURAL_FAILURE: 'Catastrophic airframe overload'
};

export class TelemetryHUD {
  private readonly cb: HUDCallbacks;

  // Sparkline history buffers
  private readonly altHistory: number[] = [];
  private readonly vyHistory: number[] = [];
  private lastSparkTime = -1;

  // Cached DOM refs
  private readonly phaseBadge = document.getElementById('phase-badge')!;
  private readonly missionClock = document.getElementById('mission-clock')!;
  private readonly legsPill = document.getElementById('legs-pill')!;
  private readonly valAlt = document.getElementById('val-alt')!;
  private readonly valVy = document.getElementById('val-vy')!;
  private readonly valVh = document.getElementById('val-vh')!;
  private readonly valErr = document.getElementById('val-err')!;
  private readonly valThrust = document.getElementById('val-thrust')!;
  private readonly valThrottle = document.getElementById('val-throttle')!;
  private readonly valTwr = document.getElementById('val-twr')!;
  private readonly barThrust = document.getElementById('bar-thrust')!;
  private readonly valFuelPct = document.getElementById('val-fuel-pct')!;
  private readonly valFuelKg = document.getElementById('val-fuel-kg')!;
  private readonly barFuel = document.getElementById('bar-fuel')!;
  private readonly valTilt = document.getElementById('val-tilt')!;
  private readonly valMass = document.getElementById('val-mass')!;
  private readonly valWind = document.getElementById('val-wind')!;
  private readonly valDrag = document.getElementById('val-drag')!;

  private readonly btnMode = document.getElementById('btn-mode')!;
  private readonly btnSas = document.getElementById('btn-sas')!;
  private readonly btnPause = document.getElementById('btn-pause')!;
  private readonly btnMute = document.getElementById('btn-mute')!;

  private readonly slWind = document.getElementById('sl-wind') as HTMLInputElement;
  private readonly lblWind = document.getElementById('lbl-wind')!;
  private readonly slGust = document.getElementById('sl-gust') as HTMLInputElement;
  private readonly lblGust = document.getElementById('lbl-gust')!;
  private readonly lblTimescale = document.getElementById('lbl-timescale')!;

  private readonly slStartAlt = document.getElementById('sl-start-alt') as HTMLInputElement;
  private readonly lblStartAlt = document.getElementById('lbl-start-alt')!;
  private readonly slStartOff = document.getElementById('sl-start-off') as HTMLInputElement;
  private readonly lblStartOff = document.getElementById('lbl-start-off')!;
  private readonly slStartFuel = document.getElementById('sl-start-fuel') as HTMLInputElement;
  private readonly lblStartFuel = document.getElementById('lbl-start-fuel')!;

  private readonly slManualThr = document.getElementById('sl-manual-thr') as HTMLInputElement;
  private readonly lblManualThr = document.getElementById('lbl-manual-thr')!;

  private readonly outcomeBanner = document.getElementById('outcome-banner')!;
  private readonly outcomeTitle = document.getElementById('outcome-title')!;
  private readonly outcomeSub = document.getElementById('outcome-sub')!;
  private readonly outcomeGrade = document.getElementById('outcome-grade')!;
  private readonly osSpeed = document.getElementById('os-speed')!;
  private readonly osErr = document.getElementById('os-err')!;
  private readonly osTilt = document.getElementById('os-tilt')!;
  private readonly osFuel = document.getElementById('os-fuel')!;

  private readonly replayDock = document.getElementById('replay-dock')!;
  private readonly replayTime = document.getElementById('replay-time')!;
  private readonly replayScrubber = document.getElementById('replay-scrubber') as HTMLInputElement;
  private readonly timelineMarkers = document.getElementById('timeline-markers')!;
  private readonly btnReplayPlay = document.getElementById('btn-replay-play')!;

  private readonly radarCanvas = document.getElementById('radar-canvas') as HTMLCanvasElement;
  private readonly radarCtx = this.radarCanvas.getContext('2d')!;
  private readonly sparkCanvas = document.getElementById('spark-canvas') as HTMLCanvasElement;
  private readonly sparkCtx = this.sparkCanvas.getContext('2d')!;

  private activeScenarioId = SCENARIOS[0].id;

  constructor(callbacks: HUDCallbacks) {
    this.cb = callbacks;
    this.buildScenarioButtons();
    this.bindEvents();
  }

  private buildScenarioButtons(): void {
    const container = document.getElementById('scenario-list')!;
    container.innerHTML = '';
    for (const sc of SCENARIOS) {
      const btn = document.createElement('button');
      btn.className = 'scenario-btn' + (sc.id === this.activeScenarioId ? ' active' : '');
      btn.dataset.scenarioId = sc.id;
      btn.innerHTML = `
        <div class="sc-name">
          <span>${sc.name}</span>
          <span class="sc-tag">${sc.controlMode}</span>
        </div>
        <div class="sc-desc">${sc.description}</div>
      `;
      btn.addEventListener('click', () => {
        this.setActiveScenarioUI(sc);
        this.cb.onSelectScenario(sc);
      });
      container.appendChild(btn);
    }
  }

  public setActiveScenarioUI(sc: ScenarioConfig): void {
    this.activeScenarioId = sc.id;
    document.querySelectorAll('.scenario-btn').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.scenarioId === sc.id);
    });

    this.slWind.value = String(sc.windSpeed);
    this.lblWind.textContent = `${sc.windSpeed.toFixed(1)} m/s`;
    this.slGust.value = String(Math.round(sc.windGustiness * 100));
    this.lblGust.textContent = `${Math.round(sc.windGustiness * 100)}%`;

    this.slStartAlt.value = String(Math.round(sc.startAltitude));
    this.lblStartAlt.textContent = `${Math.round(sc.startAltitude)} m`;
    this.slStartOff.value = String(Math.round(Math.abs(sc.startOffsetX)));
    this.lblStartOff.textContent = `${Math.round(Math.abs(sc.startOffsetX))} m`;
    this.slStartFuel.value = String(Math.round(sc.fuelMass));
    this.lblStartFuel.textContent = `${Math.round(sc.fuelMass).toLocaleString()} kg`;
  }

  private bindEvents(): void {
    // Camera buttons
    document.querySelectorAll('.cam-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = (btn as HTMLElement).dataset.cam as CameraMode;
        this.cb.onSelectCamera(mode);
      });
    });

    this.btnMode.addEventListener('click', () => this.cb.onToggleControlMode());
    this.btnSas.addEventListener('click', () => this.cb.onToggleSAS());
    this.btnPause.addEventListener('click', () => this.cb.onTogglePause());
    this.btnMute.addEventListener('click', () => this.cb.onToggleMute());
    document.getElementById('btn-reset')!.addEventListener('click', () => this.cb.onReset());
    document.getElementById('btn-replay-toggle')!.addEventListener('click', () => this.cb.onEnterReplay(0.25));

    // Collapse right panel
    const collapseBtn = document.getElementById('btn-collapse-right')!;
    const rightBody = document.getElementById('right-body')!;
    collapseBtn.addEventListener('click', () => {
      const collapsed = rightBody.classList.toggle('hidden');
      collapseBtn.textContent = collapsed ? '+' : '−';
    });

    // Wind sliders & buttons
    this.slWind.addEventListener('input', () => {
      const v = parseFloat(this.slWind.value);
      this.lblWind.textContent = `${v.toFixed(1)} m/s`;
      this.cb.onWindSpeedChange(v);
    });
    this.slGust.addEventListener('input', () => {
      const v = parseFloat(this.slGust.value);
      this.lblGust.textContent = `${Math.round(v)}%`;
      this.cb.onWindGustChange(v / 100);
    });
    document.getElementById('btn-gust')!.addEventListener('click', () => this.cb.onInjectGust());
    document.getElementById('btn-legs')!.addEventListener('click', () => this.cb.onToggleLegs());

    // Live speed pills
    document.querySelectorAll('#live-speed-pills .speed-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const spd = parseFloat((pill as HTMLElement).dataset.speed || '1');
        document.querySelectorAll('#live-speed-pills .speed-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        this.lblTimescale.textContent = `${spd}x`;
        this.cb.onLiveSpeedChange(spd);
      });
    });

    // Custom launch sliders
    this.slStartAlt.addEventListener('input', () => {
      this.lblStartAlt.textContent = `${this.slStartAlt.value} m`;
    });
    this.slStartOff.addEventListener('input', () => {
      this.lblStartOff.textContent = `${this.slStartOff.value} m`;
    });
    this.slStartFuel.addEventListener('input', () => {
      this.lblStartFuel.textContent = `${Number(this.slStartFuel.value).toLocaleString()} kg`;
    });
    document.getElementById('btn-apply-custom')!.addEventListener('click', () => {
      this.cb.onApplyCustomLaunch(
        parseFloat(this.slStartAlt.value),
        -parseFloat(this.slStartOff.value),
        parseFloat(this.slStartFuel.value)
      );
    });

    // Manual throttle slider
    this.slManualThr.addEventListener('input', () => {
      const pct = parseFloat(this.slManualThr.value);
      this.lblManualThr.textContent = `${Math.round(pct)}%`;
      this.cb.onManualThrottleSlider(pct / 100);
    });

    // Outcome buttons
    document.getElementById('btn-watch-replay')!.addEventListener('click', () => {
      // Jump to last 10 seconds at 0.25x slow-mo so the landing/impact is immediately dramatic!
      this.cb.onEnterReplay(0.25, 11);
    });
    document.getElementById('btn-outcome-reset')!.addEventListener('click', () => this.cb.onReset());

    // Replay dock buttons
    document.querySelectorAll('#replay-speeds .speed-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const spd = parseFloat((pill as HTMLElement).dataset.rspeed || '0.25');
        this.setReplaySpeedUI(spd);
        this.cb.onReplaySpeedChange(spd);
      });
    });
    this.btnReplayPlay.addEventListener('click', () => this.cb.onReplayTogglePlay());
    document.getElementById('btn-replay-exit')!.addEventListener('click', () => this.cb.onExitReplay());
    this.replayScrubber.addEventListener('input', () => {
      this.cb.onReplaySeek(parseFloat(this.replayScrubber.value));
    });
  }

  public resetGraphs(): void {
    this.altHistory.length = 0;
    this.vyHistory.length = 0;
    this.lastSparkTime = -1;
    this.hideOutcome();
  }

  public setCameraUI(mode: CameraMode): void {
    document.querySelectorAll('.cam-btn').forEach((btn) => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.cam === mode);
    });
  }

  public setControlModeUI(mode: ControlMode): void {
    this.btnMode.textContent = mode === 'AUTO' ? 'AUTO PID' : 'MANUAL';
    this.btnMode.classList.toggle('btn-auto', mode === 'AUTO');
    this.btnMode.classList.toggle('btn-manual', mode === 'MANUAL');
  }

  public setSASUI(enabled: boolean): void {
    this.btnSas.textContent = enabled ? 'SAS ON' : 'SAS OFF';
    this.btnSas.classList.toggle('active', enabled);
  }

  public setPauseUI(paused: boolean): void {
    this.btnPause.textContent = paused ? 'Resume' : 'Pause';
  }

  public setMuteUI(muted: boolean): void {
    this.btnMute.textContent = muted ? 'SFX OFF' : 'SFX ON';
  }

  public setManualThrottleUI(val01: number): void {
    const pct = Math.round(val01 * 100);
    this.slManualThr.value = String(pct);
    this.lblManualThr.textContent = `${pct}%`;
  }

  public setReplaySpeedUI(speed: number): void {
    document.querySelectorAll('#replay-speeds .speed-pill').forEach((p) => {
      const s = parseFloat((p as HTMLElement).dataset.rspeed || '0');
      p.classList.toggle('active', Math.abs(s - speed) < 0.01);
    });
  }

  public showReplayDock(duration: number, events: ReplayEvent[], speed: number): void {
    this.replayDock.classList.remove('hidden');
    this.replayScrubber.max = String(Math.max(0.1, duration));
    this.setReplaySpeedUI(speed);
    this.btnReplayPlay.textContent = 'Pause';

    this.timelineMarkers.innerHTML = '';
    if (duration > 0.1) {
      for (const ev of events) {
        const pct = Math.min(100, Math.max(0, (ev.time / duration) * 100));
        const dot = document.createElement('div');
        dot.className = 'tl-marker';
        dot.style.left = `${pct}%`;
        dot.style.backgroundColor = ev.color;
        dot.style.color = ev.color;
        dot.title = `${ev.label} (T+${ev.time.toFixed(1)}s)`;
        this.timelineMarkers.appendChild(dot);
      }
    }
  }

  public hideReplayDock(): void {
    this.replayDock.classList.add('hidden');
  }

  public updateReplayDock(playhead: number, duration: number, paused: boolean): void {
    this.replayTime.textContent = `${playhead.toFixed(2)}s / ${duration.toFixed(2)}s`;
    this.replayScrubber.value = String(playhead);
    this.btnReplayPlay.textContent = paused ? 'Play' : 'Pause';
  }

  public showOutcome(tel: TelemetryData): void {
    const landed = tel.phase === 'LANDED';
    this.outcomeBanner.classList.remove('hidden');
    this.outcomeBanner.classList.toggle('failed', !landed);

    if (landed) {
      this.outcomeTitle.textContent = 'NOMINAL LANDING CONFIRMED';
      this.outcomeSub.textContent = 'Valkyrie-9 booster upright & secured on ASDS-01';
      this.outcomeGrade.textContent = tel.grade ?? 'A';
    } else {
      this.outcomeTitle.textContent = 'MISSION FAILURE';
      this.outcomeSub.textContent = FAILURE_LABELS[tel.failureReason] ?? 'Booster lost on descent';
      this.outcomeGrade.textContent = '✕';
    }

    this.osSpeed.textContent = `${(tel.touchdownSpeed ?? Math.abs(tel.verticalVelocity)).toFixed(1)} m/s`;
    this.osErr.textContent = `${(tel.touchdownError ?? tel.distFromPad).toFixed(1)} m`;
    this.osTilt.textContent = `${(tel.touchdownTiltDeg ?? tel.tiltDeg).toFixed(1)}°`;
    this.osFuel.textContent = `${tel.fuelPercent.toFixed(1)}%`;
  }

  public hideOutcome(): void {
    this.outcomeBanner.classList.add('hidden');
  }

  public updateTelemetry(tel: TelemetryData, isReplaying: boolean): void {
    this.missionClock.textContent = `T+${tel.time.toFixed(1)}s`;

    // Phase badge styling
    const phaseMap: Record<string, [string, string]> = {
      COAST: ['BALLISTIC COAST', 'phase-coast'],
      LANDING_BURN: ['LANDING BURN', 'phase-burn'],
      FINAL_APPROACH: ['FINAL APPROACH', 'phase-approach'],
      TOUCHDOWN: ['TOUCHDOWN', 'phase-approach'],
      LANDED: ['LANDED NOMINAL', 'phase-landed'],
      FAILED: ['BOOSTER LOST', 'phase-failed']
    };
    const [pText, pCls] = phaseMap[tel.phase] ?? [tel.phase, 'phase-coast'];
    this.phaseBadge.textContent = pText;
    this.phaseBadge.className = `phase-badge ${pCls}`;

    // Legs pill
    if (tel.legsLocked) {
      this.legsPill.textContent = 'LEGS LOCKED';
      this.legsPill.className = 'mini-pill locked';
    } else if (tel.legDeploy > 0.02) {
      this.legsPill.textContent = `DEPLOYING ${Math.round(tel.legDeploy * 100)}%`;
      this.legsPill.className = 'mini-pill deploying';
    } else {
      this.legsPill.textContent = 'LEGS STOWED';
      this.legsPill.className = 'mini-pill';
    }

    // Core numbers
    this.valAlt.textContent = tel.altitude.toFixed(1);
    this.valVy.textContent = tel.verticalVelocity.toFixed(1);
    this.valVy.className =
      tel.altitude < 30 && tel.verticalVelocity < -8
        ? 'text-danger'
        : tel.altitude < 60 && tel.verticalVelocity < -18
          ? 'text-warn'
          : '';

    this.valVh.textContent = tel.horizontalVelocity.toFixed(1);

    const err = tel.altitude < 2 ? tel.distFromPad : tel.estLandingError;
    this.valErr.textContent = err.toFixed(1);
    this.valErr.className = err <= 10 ? 'text-ok' : err <= 24 ? '' : 'text-warn';

    // Thrust & Throttle
    const thrustKN = tel.thrustN / 1000;
    const thrPct = Math.round(tel.throttle * 100);
    this.valThrust.textContent = Math.round(thrustKN).toString();
    this.valThrottle.textContent = String(thrPct);
    this.valTwr.textContent = tel.twr.toFixed(2);
    this.barThrust.style.width = `${thrPct}%`;

    // Propellant
    this.valFuelPct.textContent = tel.fuelPercent.toFixed(1);
    this.valFuelKg.textContent = Math.round(tel.fuelMass).toLocaleString();
    this.barFuel.style.width = `${Math.max(0, Math.min(100, tel.fuelPercent))}%`;
    this.barFuel.classList.toggle('low', tel.fuelPercent < 14);

    // Secondary stats
    this.valTilt.textContent = `${tel.tiltDeg.toFixed(1)}°`;
    this.valTilt.className =
      tel.tiltDeg > 28 ? 'mono text-danger' : tel.tiltDeg > 13 && tel.altitude < 20 ? 'mono text-warn' : 'mono';
    this.valMass.textContent = `${(tel.totalMass / 1000).toFixed(1)}t`;
    this.valWind.textContent = `${tel.windSpeed.toFixed(1)} m/s`;
    this.valDrag.textContent = `${(tel.dragForceN / 1000).toFixed(1)} kN`;

    // Record sparkline samples during live flight
    if (!isReplaying && (this.lastSparkTime < 0 || tel.time - this.lastSparkTime >= 0.15)) {
      this.lastSparkTime = tel.time;
      this.altHistory.push(tel.altitude);
      this.vyHistory.push(tel.verticalVelocity);
      if (this.altHistory.length > 180) {
        this.altHistory.shift();
        this.vyHistory.shift();
      }
    }

    this.drawRadar(tel);
    this.drawSparkline();
  }

  private drawRadar(tel: TelemetryData): void {
    const ctx = this.radarCtx;
    const w = this.radarCanvas.width;
    const h = this.radarCanvas.height;
    const cx = w * 0.5;
    const cy = h * 0.5;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#06101e';
    ctx.fillRect(0, 0, w, h);

    // Dynamic zoom range: tight when close to pad, wider when far off-pad
    const maxDist = Math.max(60, Math.min(320, Math.max(tel.distFromPad, tel.estLandingError) * 1.35));
    const scale = (w * 0.44) / maxDist;

    // Range rings
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.lineWidth = 1;
    for (const r of [0.5, 1.0]) {
      ctx.beginPath();
      ctx.arc(cx, cy, w * 0.44 * r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ASDS Barge rectangle (58m x 86m)
    const bw = 58 * scale;
    const bh = 86 * scale;
    ctx.fillStyle = 'rgba(51, 65, 85, 0.55)';
    ctx.strokeStyle = 'rgba(234, 179, 8, 0.72)';
    ctx.lineWidth = 1.3;
    ctx.fillRect(cx - bw * 0.5, cy - bh * 0.5, bw, bh);
    ctx.strokeRect(cx - bw * 0.5, cy - bh * 0.5, bw, bh);

    // Bullseye circle
    ctx.strokeStyle = 'rgba(241, 245, 249, 0.5)';
    ctx.beginPath();
    ctx.arc(cx, cy, 23.5 * scale, 0, Math.PI * 2);
    ctx.stroke();

    // Crosshairs
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy);
    ctx.lineTo(cx + 6, cy);
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx, cy + 6);
    ctx.stroke();

    // Wind arrow in top-left corner of radar
    if (tel.windSpeed > 0.3) {
      const wx = 18;
      const wy = 18;
      const a = Math.atan2(tel.windZ, tel.windX);
      const len = Math.min(13, 5 + tel.windSpeed * 0.4);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(wx - Math.cos(a) * len * 0.5, wy - Math.sin(a) * len * 0.5);
      ctx.lineTo(wx + Math.cos(a) * len * 0.7, wy + Math.sin(a) * len * 0.7);
      ctx.stroke();
    }

    // Predicted landing point (Est. Error reticle)
    const ex = cx + Math.max(-w * 0.46, Math.min(w * 0.46, tel.estLandingErrorX * scale));
    const ey = cy + Math.max(-h * 0.46, Math.min(h * 0.46, tel.estLandingErrorZ * scale));
    ctx.strokeStyle = tel.estLandingError <= 10 ? '#22c55e' : tel.estLandingError <= 24 ? '#38bdf8' : '#f97316';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(ex, ey, 5.2, 0, Math.PI * 2);
    ctx.stroke();

    // Current rocket horizontal position (bright dot)
    const rx = cx + Math.max(-w * 0.46, Math.min(w * 0.46, tel.posX * scale));
    const ry = cy + Math.max(-h * 0.46, Math.min(h * 0.46, tel.posZ * scale));
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(rx, ry, 3.2, 0, Math.PI * 2);
    ctx.fill();

    // Range scale label
    ctx.fillStyle = 'rgba(148,163,184,0.75)';
    ctx.font = '9px monospace';
    ctx.fillText(`±${Math.round(maxDist)}m`, 5, h - 5);
  }

  private drawSparkline(): void {
    const ctx = this.sparkCtx;
    const w = this.sparkCanvas.width;
    const h = this.sparkCanvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#06101e';
    ctx.fillRect(0, 0, w, h);

    // Subtle horizontal grid
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = (h * i) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const n = this.altHistory.length;
    if (n < 2) return;

    const maxAlt = Math.max(100, ...this.altHistory);
    const maxSpd = Math.max(30, ...this.vyHistory.map((v) => Math.abs(v)));

    // Altitude line (cyan)
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (w - 8) + 4;
      const y = h - 10 - (this.altHistory[i] / maxAlt) * (h - 22);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Descent speed line (orange)
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (w - 8) + 4;
      const spd = Math.abs(this.vyHistory[i]);
      const y = h - 10 - (spd / maxSpd) * (h - 22);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Legend
    ctx.font = '9px monospace';
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('ALT', 5, 11);
    ctx.fillStyle = '#f97316';
    ctx.fillText('SPD', 32, 11);
  }
}
