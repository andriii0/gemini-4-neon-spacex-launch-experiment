import * as THREE from 'three';
import { ReplayEvent, ReplayFrame } from '../types';
import { RocketPhysics } from '../physics/RocketPhysics';

export class ReplaySystem {
  public frames: ReplayFrame[] = [];
  public events: ReplayEvent[] = [];

  public isReplaying = false;
  public isPaused = false;
  public playbackSpeed = 0.25; // default cinematic slow-motion speed
  public playheadTime = 0;
  public loop = true;

  private lastRecordTime = -1;
  private readonly recordInterval = 1 / 60;
  private readonly maxFrames = 60 * 180; // up to 3 minutes of flight at 60Hz

  private readonly _qA = new THREE.Quaternion();
  private readonly _qB = new THREE.Quaternion();
  private readonly _qOut = new THREE.Quaternion();

  public reset(): void {
    this.frames = [];
    this.events = [];
    this.isReplaying = false;
    this.isPaused = false;
    this.playheadTime = 0;
    this.lastRecordTime = -1;
  }

  public addEvent(time: number, label: string, color: string): void {
    // Avoid duplicate event markers very close together
    const exists = this.events.some((e) => e.label === label && Math.abs(e.time - time) < 0.5);
    if (!exists) {
      this.events.push({ time, label, color });
    }
  }

  public recordFrame(physics: RocketPhysics): void {
    if (this.isReplaying) return;
    if (this.frames.length >= this.maxFrames) return;
    if (this.lastRecordTime >= 0 && physics.simTime - this.lastRecordTime < this.recordInterval) {
      return;
    }

    this.lastRecordTime = physics.simTime;
    const basePos = physics.getBasePosition(new THREE.Vector3());
    const tel = physics.getTelemetry();

    this.frames.push({
      time: physics.simTime,
      pos: [basePos.x, basePos.y, basePos.z],
      vel: [physics.vel.x, physics.vel.y, physics.vel.z],
      quat: [physics.quat.x, physics.quat.y, physics.quat.z, physics.quat.w],
      angVel: [physics.angVel.x, physics.angVel.y, physics.angVel.z],
      throttle: physics.throttle,
      gimbalPitch: physics.gimbalPitch,
      gimbalYaw: physics.gimbalYaw,
      rcsPitch: physics.rcsPitch,
      rcsYaw: physics.rcsYaw,
      rcsRoll: physics.rcsRoll,
      finPitch: physics.finPitch,
      finYaw: physics.finYaw,
      legDeploy: physics.legDeploy,
      exploded: physics.exploded,
      splashed: physics.splashed,
      telemetry: tel
    });
  }

  public getDuration(): number {
    if (this.frames.length === 0) return 0;
    return this.frames[this.frames.length - 1].time;
  }

  public startReplay(speed = 0.25, startOffsetFromEnd?: number): boolean {
    if (this.frames.length < 2) return false;
    this.isReplaying = true;
    this.isPaused = false;
    this.playbackSpeed = speed;
    const duration = this.getDuration();
    if (startOffsetFromEnd !== undefined) {
      this.playheadTime = Math.max(0, duration - startOffsetFromEnd);
    } else {
      this.playheadTime = 0;
    }
    return true;
  }

  public exitReplay(): void {
    this.isReplaying = false;
    this.isPaused = false;
  }

  public seek(timeSec: number): void {
    this.playheadTime = THREE.MathUtils.clamp(timeSec, 0, this.getDuration());
  }

  public advance(realDt: number): { frame: ReplayFrame; justExploded: boolean; justSplashed: boolean } | null {
    if (!this.isReplaying || this.frames.length === 0) return null;

    const prevTime = this.playheadTime;
    const duration = this.getDuration();

    if (!this.isPaused) {
      this.playheadTime += realDt * this.playbackSpeed;
      if (this.playheadTime > duration) {
        if (this.loop) {
          this.playheadTime = 0;
        } else {
          this.playheadTime = duration;
          this.isPaused = true;
        }
      }
    }

    const prevFrame = this.sampleAt(prevTime);
    const curFrame = this.sampleAt(this.playheadTime);

    const justExploded = !prevFrame.exploded && curFrame.exploded && this.playheadTime >= prevTime;
    const justSplashed = !prevFrame.splashed && curFrame.splashed && this.playheadTime >= prevTime;

    return { frame: curFrame, justExploded, justSplashed };
  }

  public sampleAt(t: number): ReplayFrame {
    const n = this.frames.length;
    if (n === 1 || t <= this.frames[0].time) return this.frames[0];
    if (t >= this.frames[n - 1].time) return this.frames[n - 1];

    // Binary search for frame index
    let lo = 0;
    let hi = n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.frames[mid].time <= t) lo = mid;
      else hi = mid;
    }

    const a = this.frames[lo];
    const b = this.frames[hi];
    const span = Math.max(1e-6, b.time - a.time);
    const alpha = THREE.MathUtils.clamp((t - a.time) / span, 0, 1);

    this._qA.set(a.quat[0], a.quat[1], a.quat[2], a.quat[3]);
    this._qB.set(b.quat[0], b.quat[1], b.quat[2], b.quat[3]);
    this._qOut.slerpQuaternions(this._qA, this._qB, alpha);

    const lerp = THREE.MathUtils.lerp;

    return {
      time: t,
      pos: [
        lerp(a.pos[0], b.pos[0], alpha),
        lerp(a.pos[1], b.pos[1], alpha),
        lerp(a.pos[2], b.pos[2], alpha)
      ],
      vel: [
        lerp(a.vel[0], b.vel[0], alpha),
        lerp(a.vel[1], b.vel[1], alpha),
        lerp(a.vel[2], b.vel[2], alpha)
      ],
      quat: [this._qOut.x, this._qOut.y, this._qOut.z, this._qOut.w],
      angVel: [
        lerp(a.angVel[0], b.angVel[0], alpha),
        lerp(a.angVel[1], b.angVel[1], alpha),
        lerp(a.angVel[2], b.angVel[2], alpha)
      ],
      throttle: lerp(a.throttle, b.throttle, alpha),
      gimbalPitch: lerp(a.gimbalPitch, b.gimbalPitch, alpha),
      gimbalYaw: lerp(a.gimbalYaw, b.gimbalYaw, alpha),
      rcsPitch: lerp(a.rcsPitch, b.rcsPitch, alpha),
      rcsYaw: lerp(a.rcsYaw, b.rcsYaw, alpha),
      rcsRoll: lerp(a.rcsRoll, b.rcsRoll, alpha),
      finPitch: lerp(a.finPitch, b.finPitch, alpha),
      finYaw: lerp(a.finYaw, b.finYaw, alpha),
      legDeploy: lerp(a.legDeploy, b.legDeploy, alpha),
      exploded: alpha > 0.5 ? b.exploded : a.exploded,
      splashed: alpha > 0.5 ? b.splashed : a.splashed,
      telemetry: alpha > 0.5 ? b.telemetry : a.telemetry
    };
  }
}
