import './styles.css';
import * as THREE from 'three';
import { CameraMode, ControlMode, ScenarioConfig } from './types';
import { SCENARIOS } from './scenarios';
import { RocketPhysics } from './physics/RocketPhysics';
import { AutopilotController, ManualInputState } from './control/AutopilotController';
import { ReplaySystem } from './replay/ReplaySystem';
import { EnvironmentScene } from './scene/EnvironmentScene';
import { RocketMesh } from './scene/RocketMesh';
import { ParticleSystem } from './scene/ParticleSystem';
import { CameraRig } from './scene/CameraRig';
import { SoundEngine } from './audio/SoundEngine';
import { TelemetryHUD } from './ui/TelemetryHUD';

class RocketLandingSimulator {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly env: EnvironmentScene;
  private readonly rocketMesh: RocketMesh;
  private readonly particles: ParticleSystem;
  private readonly cameraRig: CameraRig;
  private readonly physics: RocketPhysics;
  private readonly autopilot: AutopilotController;
  private readonly replay: ReplaySystem;
  private readonly sound: SoundEngine;
  private readonly hud: TelemetryHUD;

  private currentScenario: ScenarioConfig = { ...SCENARIOS[0] };
  private controlMode: ControlMode = 'AUTO';
  private paused = false;
  private liveTimeScale = 1.0;

  private readonly keys = new Set<string>();
  private readonly manualInput: ManualInputState = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0,
    deployLegs: false,
    sasEnabled: true
  };

  // RCS emitter local mount positions on upper interstage (y = 39.2)
  private readonly rcsLeftLocal = new THREE.Vector3(-1.95, 39.2, 0);
  private readonly rcsRightLocal = new THREE.Vector3(1.95, 39.2, 0);
  private readonly rcsFrontLocal = new THREE.Vector3(0, 39.2, 1.95);
  private readonly rcsBackLocal = new THREE.Vector3(0, 39.2, -1.95);

  private lastFrameTime = performance.now();
  private accumulator = 0;

  constructor() {
    const container = document.getElementById('viewport')!;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.env = new EnvironmentScene(this.scene);
    this.rocketMesh = new RocketMesh();
    this.scene.add(this.rocketMesh.group);

    this.particles = new ParticleSystem(this.scene);
    this.cameraRig = new CameraRig(this.renderer.domElement);
    this.physics = new RocketPhysics();
    this.autopilot = new AutopilotController();
    this.replay = new ReplaySystem();
    this.sound = new SoundEngine();

    this.wirePhysicsEvents();

    this.hud = new TelemetryHUD({
      onSelectScenario: (sc) => {
        this.sound.unlock();
        this.loadScenario(sc);
      },
      onApplyCustomLaunch: (alt, offsetX, fuel) => {
        this.sound.unlock();
        const custom: ScenarioConfig = {
          ...this.currentScenario,
          startAltitude: alt,
          startOffsetX: offsetX,
          startOffsetZ: Math.round(offsetX * -0.35),
          fuelMass: fuel
        };
        this.loadScenario(custom);
      },
      onToggleControlMode: () => {
        this.sound.unlock();
        this.toggleControlMode();
      },
      onToggleSAS: () => {
        this.manualInput.sasEnabled = !this.manualInput.sasEnabled;
        this.hud.setSASUI(this.manualInput.sasEnabled);
      },
      onSelectCamera: (mode) => this.setCameraMode(mode),
      onWindSpeedChange: (spd) => {
        this.physics.baseWindSpeed = spd;
        this.currentScenario.windSpeed = spd;
      },
      onWindGustChange: (gust) => {
        this.physics.windGustiness = gust;
        this.currentScenario.windGustiness = gust;
      },
      onInjectGust: () => {
        this.sound.unlock();
        this.physics.injectWindGust(16);
      },
      onToggleLegs: () => {
        this.sound.unlock();
        this.manualInput.deployLegs = !this.manualInput.deployLegs;
        if (this.controlMode === 'AUTO' && this.manualInput.deployLegs) {
          this.physics.legCommand = true;
        }
      },
      onManualThrottleSlider: (val01) => {
        this.sound.unlock();
        this.manualInput.throttle = val01;
        if (this.controlMode !== 'MANUAL') {
          this.setControlMode('MANUAL');
        }
      },
      onLiveSpeedChange: (spd) => {
        this.liveTimeScale = spd;
      },
      onReset: () => {
        this.sound.unlock();
        this.loadScenario(this.currentScenario);
      },
      onTogglePause: () => {
        if (this.replay.isReplaying) {
          this.replay.isPaused = !this.replay.isPaused;
        } else {
          this.paused = !this.paused;
          this.hud.setPauseUI(this.paused);
        }
      },
      onToggleMute: () => {
        this.sound.unlock();
        this.sound.setMuted(!this.sound.muted);
        this.hud.setMuteUI(this.sound.muted);
      },
      onEnterReplay: (speed = 0.25, fromEndSec?: number) => {
        this.sound.unlock();
        this.enterReplayMode(speed, fromEndSec);
      },
      onExitReplay: () => this.exitReplayMode(),
      onReplaySpeedChange: (speed) => {
        this.replay.playbackSpeed = speed;
      },
      onReplaySeek: (time) => {
        this.particles.clear();
        this.replay.seek(time);
      },
      onReplayTogglePlay: () => {
        this.replay.isPaused = !this.replay.isPaused;
      }
    });

    this.bindKeyboardAndResize();
    this.loadScenario(SCENARIOS[0]);
    this.animate();
  }

  private wirePhysicsEvents(): void {
    this.physics.callbacks = {
      onIgnition: () => {
        this.replay.addEvent(this.physics.simTime, 'Landing Burn Ignition', '#f97316');
      },
      onLegDeployStart: () => {
        this.sound.playLegDeploy();
        this.replay.addEvent(this.physics.simTime, 'Landing Legs Deploy', '#38bdf8');
      },
      onTouchdownImpact: (_pos, speed) => {
        this.cameraRig.addShake(Math.min(1.4, speed * 0.08));
        this.replay.addEvent(this.physics.simTime, 'Deck Contact', '#facc15');
      },
      onExplosion: (pos, vel) => {
        this.particles.triggerExplosion(pos, vel);
        this.cameraRig.addShake(2.4);
        this.sound.playExplosion();
        this.replay.addEvent(this.physics.simTime, 'RUD Explosion', '#ef4444');
      },
      onWaterSplash: (pos, speed) => {
        this.particles.triggerWaterSplash(pos, speed);
        this.cameraRig.addShake(Math.min(1.6, speed * 0.05));
        this.sound.playExplosion();
        this.replay.addEvent(this.physics.simTime, 'Ocean Splashdown', '#0ea5e9');
      },
      onOutcome: (phase) => {
        if (phase === 'LANDED') {
          this.sound.playLandingSuccess();
          this.replay.addEvent(this.physics.simTime, 'Landing Confirmed', '#22c55e');
        }
        this.hud.showOutcome(this.physics.getTelemetry());
      }
    };
  }

  private loadScenario(sc: ScenarioConfig): void {
    this.currentScenario = { ...sc };
    this.exitReplayMode();
    this.paused = false;
    this.hud.setPauseUI(false);

    this.physics.reset(this.currentScenario);
    this.autopilot.reset();
    this.replay.reset();
    this.particles.clear();
    this.hud.resetGraphs();
    this.hud.setActiveScenarioUI(this.currentScenario);

    this.setControlMode(sc.controlMode);
    this.manualInput.throttle = sc.controlMode === 'MANUAL' ? 0.35 : 0;
    this.manualInput.deployLegs = false;
    this.manualInput.sasEnabled = sc.sasEnabled;
    this.hud.setSASUI(this.manualInput.sasEnabled);
    this.hud.setManualThrottleUI(this.manualInput.throttle);

    // Sync initial visual & camera
    const basePos = this.physics.getBasePosition(new THREE.Vector3());
    this.rocketMesh.updateVisuals(basePos, this.physics.quat, 0, 0, 0, 0, 0, 0, false, 0.016);
    this.cameraRig.snapToRocket(basePos);
    this.replay.recordFrame(this.physics);
  }

  private setControlMode(mode: ControlMode): void {
    this.controlMode = mode;
    this.hud.setControlModeUI(mode);
    if (mode === 'MANUAL') {
      // Smoothly inherit current engine throttle & leg state so handover isn't jarring!
      this.manualInput.throttle = this.physics.throttle;
      this.manualInput.deployLegs = this.physics.legCommand;
      this.hud.setManualThrottleUI(this.manualInput.throttle);
    }
  }

  private toggleControlMode(): void {
    this.setControlMode(this.controlMode === 'AUTO' ? 'MANUAL' : 'AUTO');
  }

  private setCameraMode(mode: CameraMode): void {
    const basePos = this.replay.isReplaying
      ? new THREE.Vector3(...this.replay.sampleAt(this.replay.playheadTime).pos)
      : this.physics.getBasePosition(new THREE.Vector3());
    this.cameraRig.setMode(mode, basePos);
    this.hud.setCameraUI(mode);
  }

  private enterReplayMode(speed = 0.25, fromEndSec?: number): void {
    if (!this.replay.startReplay(speed, fromEndSec)) return;
    this.particles.clear();
    this.hud.hideOutcome();
    this.hud.showReplayDock(this.replay.getDuration(), this.replay.events, speed);
  }

  private exitReplayMode(): void {
    if (!this.replay.isReplaying) return;
    this.replay.exitReplay();
    this.hud.hideReplayDock();
    this.particles.clear();
    if (this.physics.phase === 'LANDED' || this.physics.phase === 'FAILED') {
      this.hud.showOutcome(this.physics.getTelemetry());
    }
  }

  private bindKeyboardAndResize(): void {
    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.cameraRig.resize(window.innerWidth, window.innerHeight);
    });

    window.addEventListener('pointerdown', () => this.sound.unlock(), { once: true });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLInputElement && e.target.type === 'text')) {
        return;
      }
      this.sound.unlock();
      const code = e.code;
      this.keys.add(code);

      if (code === 'Digit1') this.setCameraMode('CINEMATIC');
      else if (code === 'Digit2') this.setCameraMode('CHASE');
      else if (code === 'Digit3') this.setCameraMode('DECK');
      else if (code === 'Digit4') this.setCameraMode('ONBOARD');
      else if (code === 'Digit5') this.setCameraMode('ORBIT');
      else if (code === 'KeyP') this.toggleControlMode();
      else if (code === 'KeyT') {
        this.manualInput.sasEnabled = !this.manualInput.sasEnabled;
        this.hud.setSASUI(this.manualInput.sasEnabled);
      } else if (code === 'KeyL') {
        this.manualInput.deployLegs = !this.manualInput.deployLegs;
        if (this.controlMode === 'AUTO' && this.manualInput.deployLegs) {
          this.physics.legCommand = true;
        }
      } else if (code === 'KeyR') {
        this.loadScenario(this.currentScenario);
      } else if (code === 'KeyZ') {
        this.manualInput.throttle = 1;
        this.hud.setManualThrottleUI(1);
        if (this.controlMode !== 'MANUAL') this.setControlMode('MANUAL');
      } else if (code === 'KeyX') {
        this.manualInput.throttle = 0;
        this.hud.setManualThrottleUI(0);
        if (this.controlMode !== 'MANUAL') this.setControlMode('MANUAL');
      } else if (code === 'Space') {
        e.preventDefault();
        if (this.replay.isReplaying) {
          this.replay.isPaused = !this.replay.isPaused;
        } else {
          this.paused = !this.paused;
          this.hud.setPauseUI(this.paused);
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
  }

  private sampleManualKeyboard(dt: number): void {
    // Pitch: W/ArrowUp tilts nose toward -Z (or forward), S/ArrowDown toward +Z
    let pitch = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) pitch -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) pitch += 1;

    // Yaw/Lateral tilt: A/ArrowLeft tilts nose toward -X (+tau_z), D/ArrowRight toward +X (-tau_z)
    let yaw = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) yaw += 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) yaw -= 1;

    // Roll spin: Q/E
    let roll = 0;
    if (this.keys.has('KeyQ')) roll += 1;
    if (this.keys.has('KeyE')) roll -= 1;

    // If user presses flight keys while in AUTO, keep them in MANUAL if throttle adjusted or let them stay aware
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) {
      this.manualInput.throttle = Math.min(1, this.manualInput.throttle + dt * 0.72);
      this.hud.setManualThrottleUI(this.manualInput.throttle);
      if (this.controlMode !== 'MANUAL') this.setControlMode('MANUAL');
    }
    if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) {
      this.manualInput.throttle = Math.max(0, this.manualInput.throttle - dt * 0.72);
      this.hud.setManualThrottleUI(this.manualInput.throttle);
      if (this.controlMode !== 'MANUAL') this.setControlMode('MANUAL');
    }

    this.manualInput.pitch = pitch;
    this.manualInput.yaw = yaw;
    this.manualInput.roll = roll;
  }

  private emitRCSParticles(
    quat: THREE.Quaternion,
    vel: THREE.Vector3,
    rcsPitch: number,
    rcsYaw: number,
    rcsRoll: number
  ): void {
    const tmpPos = new THREE.Vector3();
    const tmpDir = new THREE.Vector3();

    // Positive rcsPitch pushes top toward +Z => fires gas toward -Z from front/back nozzles
    if (Math.abs(rcsPitch) > 0.16) {
      const sidePos = rcsPitch > 0 ? this.rcsBackLocal : this.rcsFrontLocal;
      this.rocketMesh.getRCSWorldPosition(sidePos, tmpPos);
      tmpDir.set(0, 0, rcsPitch > 0 ? -1 : 1).applyQuaternion(quat);
      this.particles.emitRCSPuff(tmpPos, tmpDir, Math.abs(rcsPitch), vel);
    }

    // Positive rcsYaw pushes top toward -X => fires gas toward +X
    if (Math.abs(rcsYaw) > 0.16) {
      const sidePos = rcsYaw > 0 ? this.rcsRightLocal : this.rcsLeftLocal;
      this.rocketMesh.getRCSWorldPosition(sidePos, tmpPos);
      tmpDir.set(rcsYaw > 0 ? 1 : -1, 0, 0).applyQuaternion(quat);
      this.particles.emitRCSPuff(tmpPos, tmpDir, Math.abs(rcsYaw), vel);
    }

    // Roll thrusters emit tangent puffs
    if (Math.abs(rcsRoll) > 0.25) {
      this.rocketMesh.getRCSWorldPosition(this.rcsRightLocal, tmpPos);
      tmpDir.set(0, 0, rcsRoll > 0 ? 1 : -1).applyQuaternion(quat);
      this.particles.emitRCSPuff(tmpPos, tmpDir, Math.abs(rcsRoll) * 0.7, vel);
    }
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);

    const now = performance.now();
    const realDt = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;

    if (this.replay.isReplaying) {
      this.tickReplay(realDt);
    } else {
      this.tickLive(realDt);
    }

    this.renderer.render(this.scene, this.cameraRig.camera);
  };

  private tickLive(realDt: number): void {
    this.sampleManualKeyboard(realDt);

    const simDt = this.paused ? 0 : realDt * this.liveTimeScale;
    const fixedStep = 1 / 60;

    if (simDt > 0) {
      this.accumulator += simDt;
      let steps = 0;
      while (this.accumulator >= fixedStep && steps < 6) {
        const cmd =
          this.controlMode === 'AUTO'
            ? this.autopilot.computeAutoCommand(this.physics, fixedStep)
            : this.autopilot.computeManualCommand(this.physics, this.manualInput);

        this.physics.step(fixedStep, cmd);
        this.replay.recordFrame(this.physics);
        this.accumulator -= fixedStep;
        steps++;
      }
    }

    const basePos = this.physics.getBasePosition(new THREE.Vector3());
    const tel = this.physics.getTelemetry();

    this.rocketMesh.updateVisuals(
      basePos,
      this.physics.quat,
      this.physics.throttle,
      this.physics.gimbalPitch,
      this.physics.gimbalYaw,
      this.physics.finPitch,
      this.physics.finYaw,
      this.physics.legDeploy,
      this.physics.exploded,
      simDt
    );

    if (simDt > 0) {
      if (!this.physics.exploded && this.physics.throttle > 0.015) {
        const nozPos = this.rocketMesh.getNozzleWorldPosition(new THREE.Vector3());
        const exhDir = this.rocketMesh.getExhaustWorldDirection(new THREE.Vector3());
        this.particles.emitEngineExhaust(
          nozPos,
          exhDir,
          this.physics.vel,
          this.physics.throttle,
          tel.altitude,
          simDt
        );
      }
      if (!this.physics.exploded && !this.physics.splashed) {
        this.emitRCSParticles(
          this.physics.quat,
          this.physics.vel,
          this.physics.rcsPitch,
          this.physics.rcsYaw,
          this.physics.rcsRoll
        );
      }
      this.particles.update(simDt, this.physics.windVector);
    }

    const showReticle = this.physics.phase !== 'LANDED' && !this.physics.exploded;
    this.env.update(
      simDt > 0 ? simDt : realDt * 0.15,
      tel.estLandingErrorX,
      tel.estLandingErrorZ,
      tel.estLandingError,
      tel.windX,
      tel.windZ,
      showReticle
    );

    this.cameraRig.update(realDt, basePos, this.physics.quat, this.physics.throttle, tel.altitude);

    const rcsAct = Math.max(
      Math.abs(this.physics.rcsPitch),
      Math.abs(this.physics.rcsYaw),
      Math.abs(this.physics.rcsRoll)
    );
    this.sound.update(this.physics.throttle, rcsAct, this.liveTimeScale, this.paused);

    this.hud.updateTelemetry(tel, false);
  }

  private tickReplay(realDt: number): void {
    const res = this.replay.advance(realDt);
    if (!res) return;
    const { frame, justExploded, justSplashed } = res;

    const basePos = new THREE.Vector3(...frame.pos);
    const vel = new THREE.Vector3(...frame.vel);
    const quat = new THREE.Quaternion(...frame.quat);
    const windVec = new THREE.Vector3(frame.telemetry.windX, 0, frame.telemetry.windZ);
    const fxDt = this.replay.isPaused ? 0 : realDt * this.replay.playbackSpeed;

    this.rocketMesh.updateVisuals(
      basePos,
      quat,
      frame.throttle,
      frame.gimbalPitch,
      frame.gimbalYaw,
      frame.finPitch,
      frame.finYaw,
      frame.legDeploy,
      frame.exploded,
      Math.max(0.002, fxDt)
    );

    if (justExploded) {
      this.particles.triggerExplosion(basePos.clone().add(new THREE.Vector3(0, 6, 0)), vel);
      this.cameraRig.addShake(2.2);
      this.sound.playExplosion();
    }
    if (justSplashed) {
      this.particles.triggerWaterSplash(new THREE.Vector3(basePos.x, 0.2, basePos.z), vel.length());
      this.cameraRig.addShake(1.3);
    }

    if (fxDt > 0) {
      if (!frame.exploded && frame.throttle > 0.015) {
        const nozPos = this.rocketMesh.getNozzleWorldPosition(new THREE.Vector3());
        const exhDir = this.rocketMesh.getExhaustWorldDirection(new THREE.Vector3());
        this.particles.emitEngineExhaust(
          nozPos,
          exhDir,
          vel,
          frame.throttle,
          frame.telemetry.altitude,
          fxDt
        );
      }
      if (!frame.exploded && !frame.splashed) {
        this.emitRCSParticles(quat, vel, frame.rcsPitch, frame.rcsYaw, frame.rcsRoll);
      }
      this.particles.update(fxDt, windVec);
    }

    const showReticle = frame.telemetry.phase !== 'LANDED' && !frame.exploded;
    this.env.update(
      Math.max(0.002, fxDt),
      frame.telemetry.estLandingErrorX,
      frame.telemetry.estLandingErrorZ,
      frame.telemetry.estLandingError,
      frame.telemetry.windX,
      frame.telemetry.windZ,
      showReticle
    );

    this.cameraRig.update(realDt, basePos, quat, frame.throttle, frame.telemetry.altitude);

    const rcsAct = Math.max(Math.abs(frame.rcsPitch), Math.abs(frame.rcsYaw), Math.abs(frame.rcsRoll));
    this.sound.update(frame.throttle, rcsAct, this.replay.playbackSpeed, this.replay.isPaused);

    this.hud.updateTelemetry(frame.telemetry, true);
    this.hud.updateReplayDock(this.replay.playheadTime, this.replay.getDuration(), this.replay.isPaused);
  }
}

new RocketLandingSimulator();
