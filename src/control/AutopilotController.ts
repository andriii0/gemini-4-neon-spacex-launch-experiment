import * as THREE from 'three';
import { ControlCommand } from '../types';
import { RocketPhysics } from '../physics/RocketPhysics';

export interface ManualInputState {
  pitch: number;      // -1..1 (W/S)
  yaw: number;        // -1..1 (A/D)
  roll: number;       // -1..1 (Q/E)
  throttle: number;   // 0..1
  deployLegs: boolean;
  sasEnabled: boolean;
}

const G0 = 9.80665;

export class AutopilotController {
  // PID integral states
  private intVelY = 0;
  private intVelX = 0;
  private intVelZ = 0;
  private intAttX = 0;
  private intAttZ = 0;

  private prevErrVelY = 0;
  private lastThrottleCmd = 0;
  private burnStarted = false;
  private touchdownCutoff = false;

  // Scratch vectors
  private readonly _up = new THREE.Vector3();
  private readonly _desUp = new THREE.Vector3();
  private readonly _errWorld = new THREE.Vector3();
  private readonly _errBody = new THREE.Vector3();
  private readonly _invQuat = new THREE.Quaternion();
  private readonly _basePos = new THREE.Vector3();

  public reset(): void {
    this.intVelY = 0;
    this.intVelX = 0;
    this.intVelZ = 0;
    this.intAttX = 0;
    this.intAttZ = 0;
    this.prevErrVelY = 0;
    this.lastThrottleCmd = 0;
    this.burnStarted = false;
    this.touchdownCutoff = false;
  }

  public computeAutoCommand(physics: RocketPhysics, dt: number): ControlCommand {
    const cmd: ControlCommand = {
      throttle: 0,
      gimbalPitch: 0,
      gimbalYaw: 0,
      rcsPitch: 0,
      rcsYaw: 0,
      rcsRoll: 0,
      finPitch: 0,
      finYaw: 0,
      finRoll: 0,
      deployLegs: physics.legCommand
    };

    if (physics.exploded || physics.splashed || physics.phase === 'LANDED') {
      return cmd;
    }

    const basePos = physics.getBasePosition(this._basePos);
    const alt = physics.getAltitudeAboveDeck();
    const vel = physics.vel;
    const mass = physics.totalMass;
    const maxThrust = physics.specs.maxThrust;
    const distHoriz = Math.hypot(basePos.x, basePos.z);

    // Touchdown Engine Cutoff (MECO) once firmly contacting the landing deck
    if (physics.inContact && physics.onPad && alt < 1.8) {
      this.touchdownCutoff = true;
    }
    if (this.touchdownCutoff) {
      cmd.throttle = 0;
      cmd.deployLegs = true;
      // Only fire gentle RCS stabilization if noticeably tilted; otherwise let booster settle calmly
      if (physics.getTiltDeg() > 2.5 || physics.angVel.length() > 0.06) {
        this.applyAttitudePID(physics, new THREE.Vector3(0, 1, 0), 0, dt, cmd, true);
      }
      return cmd;
    }

    // Current thrust-to-weight & net braking capability
    const maxAccel = maxThrust / mass;
    const netMaxDecel = Math.max(4.5, maxAccel * 0.90 - G0);

    // 1. Hoverslam ignition decision
    if (!this.burnStarted) {
      const safeDecel = netMaxDecel * 0.48;
      const downSpeed = Math.max(0, -vel.y);
      const stoppingDist = (downSpeed * downSpeed) / (2 * safeDecel);
      const divertMargin = Math.min(220, distHoriz * 0.85);
      const ignitionAlt = stoppingDist + 48 + divertMargin;

      if (alt <= ignitionAlt || alt < 210) {
        this.burnStarted = true;
      }
    }

    // 2. Automatic Landing Leg Deployment (well ahead of touchdown)
    const downSpd = Math.max(1, -vel.y);
    const estTTI = alt / downSpd;
    if (alt < 110 || (this.burnStarted && estTTI < 4.5 && alt < 200)) {
      cmd.deployLegs = true;
    }

    // 3. Coast Phase (pre-ignition attitude stabilization)
    if (!this.burnStarted) {
      cmd.throttle = 0;
      const glideTiltX = THREE.MathUtils.clamp((-basePos.x - vel.x * 4.5) * 0.001, -0.10, 0.10);
      const glideTiltZ = THREE.MathUtils.clamp((-basePos.z - vel.z * 4.5) * 0.001, -0.10, 0.10);
      this._desUp.set(glideTiltX, 1, glideTiltZ).normalize();
      this.applyAttitudePID(physics, this._desUp, 0, dt, cmd, false);
      return cmd;
    }

    // 4. Powered Descent: Vertical Velocity & Altitude PID
    let targetVy: number;
    if (alt > 22) {
      const profileDecel = netMaxDecel * 0.45;
      const curveVy = Math.sqrt(2 * profileDecel * Math.max(0, alt - 12.0) + 5.2 * 5.2);
      // If significantly off-pad horizontally below 240m, ease descent rate to buy lateral divert time
      const horizHoldFactor =
        alt < 250 && distHoriz > 20 ? THREE.MathUtils.clamp(1.0 - (distHoriz - 20) * 0.0085, 0.48, 1.0) : 1.0;
      targetVy = -Math.min(135, curveVy * horizHoldFactor);
    } else {
      // Crisp, smooth final flare from -5.2 m/s at 22m down to -1.25 m/s at deck contact
      targetVy = -THREE.MathUtils.clamp(1.25 + (alt / 22.0) * 3.95, 1.25, 5.2);
    }

    const errVy = targetVy - vel.y; // positive => falling too fast => need more thrust

    // Anti-windup: only integrate when not saturated and above final flare
    if (alt > 12 && this.lastThrottleCmd > 0.05 && this.lastThrottleCmd < 0.96) {
      this.intVelY = THREE.MathUtils.clamp(this.intVelY + errVy * dt, -3.5, 3.5);
    } else if (alt <= 12) {
      // Quickly bleed vertical integral in final flare so rocket never floats above deck
      this.intVelY *= Math.exp(-dt * 4.0);
    }

    const dErrVy = dt > 1e-4 ? (errVy - this.prevErrVelY) / dt : 0;
    this.prevErrVelY = errVy;

    const kpVy = alt < 28 ? 2.15 : 1.55;
    const kiVy = 0.25;
    const kdVy = 0.08;

    const ayCmd = Math.max(1.5, G0 + kpVy * errVy + kiVy * this.intVelY + kdVy * dErrVy);

    // 5. Horizontal Position -> Velocity -> Acceleration PID (Critically damped + wind rejection)
    const errX = -basePos.x;
    const errZ = -basePos.z;

    const maxHorizVel =
      alt > 50 ? Math.min(36, 4.0 + alt * 0.11) : THREE.MathUtils.clamp(1.2 + alt * 0.14, 1.2, 9.5);
    const kpPos = alt > 45 ? 0.26 : 0.34;

    let targetVx = errX * kpPos;
    let targetVz = errZ * kpPos;
    const targetHMag = Math.hypot(targetVx, targetVz);
    if (targetHMag > maxHorizVel && targetHMag > 1e-4) {
      targetVx = (targetVx / targetHMag) * maxHorizVel;
      targetVz = (targetVz / targetHMag) * maxHorizVel;
    }

    // In final 4m, prioritize killing horizontal skid velocity over chasing last few decimeters
    if (alt < 4.5 && distHoriz < 14) {
      const f = alt / 4.5;
      targetVx *= f;
      targetVz *= f;
    }

    const errVx = targetVx - vel.x;
    const errVz = targetVz - vel.z;

    // Strong integral wind-disturbance rejection (learns steady crosswind force!)
    const intRate = alt > 2.0 ? 1.0 : 0.25;
    this.intVelX = THREE.MathUtils.clamp(this.intVelX + errVx * dt * intRate, -18, 18);
    this.intVelZ = THREE.MathUtils.clamp(this.intVelZ + errVz * dt * intRate, -18, 18);

    const kpVh = alt < 35 ? 1.65 : 1.38;
    const kiVh = 0.42;

    let axCmd = kpVh * errVx + kiVh * this.intVelX;
    let azCmd = kpVh * errVz + kiVh * this.intVelZ;

    // Taper max tilt smoothly while retaining enough crab angle for storm crosswinds!
    let maxTiltDeg = 22.0;
    if (alt < 110) {
      maxTiltDeg = THREE.MathUtils.lerp(9.5, 22.0, Math.max(0, (alt - 22) / 88));
    }
    if (alt < 22) {
      maxTiltDeg = THREE.MathUtils.lerp(6.0, 9.5, Math.max(0, (alt - 3) / 19));
    }
    if (alt < 3.0) {
      maxTiltDeg = 5.5;
    }
    const maxTiltRad = (maxTiltDeg * Math.PI) / 180;
    const maxLatAccel = Math.tan(maxTiltRad) * Math.max(G0, ayCmd);

    const latMag = Math.hypot(axCmd, azCmd);
    if (latMag > maxLatAccel && latMag > 1e-4) {
      axCmd = (axCmd / latMag) * maxLatAccel;
      azCmd = (azCmd / latMag) * maxLatAccel;
    }

    this._desUp.set(axCmd, Math.max(5.5, ayCmd), azCmd).normalize();

    const curUp = physics.getUpVector(this._up);
    const cosTilt = Math.max(0.55, curUp.y);
    const totalReqAccel = Math.hypot(axCmd, ayCmd, azCmd);
    const reqThrust = mass * Math.max(ayCmd / cosTilt, totalReqAccel);
    cmd.throttle = THREE.MathUtils.clamp(reqThrust / maxThrust, 0, 1);
    this.lastThrottleCmd = cmd.throttle;

    // 6. Inner-loop Quaternion Attitude PID
    this.applyAttitudePID(physics, this._desUp, cmd.throttle, dt, cmd, false);

    return cmd;
  }

  private applyAttitudePID(
    physics: RocketPhysics,
    desiredUpWorld: THREE.Vector3,
    throttleCmd: number,
    dt: number,
    cmd: ControlCommand,
    rcsOnly: boolean
  ): void {
    const curUp = physics.getUpVector(this._up);

    this._errWorld.crossVectors(curUp, desiredUpWorld);
    const sinAngle = this._errWorld.length();
    if (sinAngle > 1e-6) {
      const dot = THREE.MathUtils.clamp(curUp.dot(desiredUpWorld), -1, 1);
      const angle = Math.atan2(sinAngle, dot);
      this._errWorld.multiplyScalar(angle / sinAngle);
    }

    this._invQuat.copy(physics.quat).invert();
    this._errBody.copy(this._errWorld).applyQuaternion(this._invQuat);

    this.intAttX = THREE.MathUtils.clamp(this.intAttX + this._errBody.x * dt, -0.32, 0.32);
    this.intAttZ = THREE.MathUtils.clamp(this.intAttZ + this._errBody.z * dt, -0.32, 0.32);

    const kpAtt = 5.4;
    const kiAtt = 0.45;
    const kdAtt = 3.1;

    const uPitch = kpAtt * this._errBody.x + kiAtt * this.intAttX - kdAtt * physics.angVel.x;
    const uYaw = kpAtt * this._errBody.z + kiAtt * this.intAttZ - kdAtt * physics.angVel.z;
    const uRoll = -2.6 * physics.angVel.y;

    if (!rcsOnly && throttleCmd > 0.06) {
      const tvcGain = THREE.MathUtils.clamp(0.56 / Math.max(0.24, throttleCmd), 0.45, 1.85);
      cmd.gimbalPitch = THREE.MathUtils.clamp(uPitch * tvcGain, -1, 1);
      cmd.gimbalYaw = THREE.MathUtils.clamp(uYaw * tvcGain, -1, 1);

      cmd.rcsPitch = THREE.MathUtils.clamp(uPitch * 0.45, -1, 1);
      cmd.rcsYaw = THREE.MathUtils.clamp(uYaw * 0.45, -1, 1);
      cmd.rcsRoll = THREE.MathUtils.clamp(uRoll, -1, 1);
      cmd.finPitch = THREE.MathUtils.clamp(uPitch * 0.85, -1, 1);
      cmd.finYaw = THREE.MathUtils.clamp(uYaw * 0.85, -1, 1);
      cmd.finRoll = THREE.MathUtils.clamp(uRoll, -1, 1);
    } else {
      cmd.gimbalPitch = 0;
      cmd.gimbalYaw = 0;
      cmd.rcsPitch = THREE.MathUtils.clamp(uPitch * 1.4, -1, 1);
      cmd.rcsYaw = THREE.MathUtils.clamp(uYaw * 1.4, -1, 1);
      cmd.rcsRoll = THREE.MathUtils.clamp(uRoll, -1, 1);
      cmd.finPitch = THREE.MathUtils.clamp(uPitch * 1.5, -1, 1);
      cmd.finYaw = THREE.MathUtils.clamp(uYaw * 1.5, -1, 1);
      cmd.finRoll = THREE.MathUtils.clamp(uRoll, -1, 1);
    }
  }

  public computeManualCommand(physics: RocketPhysics, input: ManualInputState): ControlCommand {
    const cmd: ControlCommand = {
      throttle: THREE.MathUtils.clamp(input.throttle, 0, 1),
      gimbalPitch: 0,
      gimbalYaw: 0,
      rcsPitch: 0,
      rcsYaw: 0,
      rcsRoll: 0,
      finPitch: 0,
      finYaw: 0,
      finRoll: 0,
      deployLegs: input.deployLegs
    };

    if (physics.exploded || physics.splashed) {
      cmd.throttle = 0;
      return cmd;
    }

    let pitchCmd = input.pitch;
    let yawCmd = input.yaw;
    let rollCmd = input.roll;

    if (input.sasEnabled) {
      const curUp = physics.getUpVector(this._up);
      this._errWorld.crossVectors(curUp, new THREE.Vector3(0, 1, 0));
      this._invQuat.copy(physics.quat).invert();
      this._errBody.copy(this._errWorld).applyQuaternion(this._invQuat);

      if (Math.abs(input.pitch) < 0.05) {
        pitchCmd = THREE.MathUtils.clamp(this._errBody.x * 1.35 - physics.angVel.x * 2.2, -0.85, 0.85);
      } else {
        pitchCmd = THREE.MathUtils.clamp(input.pitch * 0.85 - physics.angVel.x * 0.9, -1, 1);
      }

      if (Math.abs(input.yaw) < 0.05) {
        yawCmd = THREE.MathUtils.clamp(this._errBody.z * 1.35 - physics.angVel.z * 2.2, -0.85, 0.85);
      } else {
        yawCmd = THREE.MathUtils.clamp(input.yaw * 0.85 - physics.angVel.z * 0.9, -1, 1);
      }

      if (Math.abs(input.roll) < 0.05) {
        rollCmd = THREE.MathUtils.clamp(-physics.angVel.y * 2.0, -0.8, 0.8);
      }
    }

    cmd.gimbalPitch = THREE.MathUtils.clamp(pitchCmd, -1, 1);
    cmd.gimbalYaw = THREE.MathUtils.clamp(yawCmd, -1, 1);
    cmd.rcsPitch = THREE.MathUtils.clamp(pitchCmd, -1, 1);
    cmd.rcsYaw = THREE.MathUtils.clamp(yawCmd, -1, 1);
    cmd.rcsRoll = THREE.MathUtils.clamp(rollCmd, -1, 1);
    cmd.finPitch = THREE.MathUtils.clamp(pitchCmd, -1, 1);
    cmd.finYaw = THREE.MathUtils.clamp(yawCmd, -1, 1);
    cmd.finRoll = THREE.MathUtils.clamp(rollCmd, -1, 1);

    return cmd;
  }
}
