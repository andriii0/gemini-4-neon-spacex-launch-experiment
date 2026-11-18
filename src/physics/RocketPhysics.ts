import * as THREE from 'three';
import {
  ControlCommand,
  FailureReason,
  FlightPhase,
  RocketSpecs,
  ScenarioConfig,
  SimEventCallbacks,
  TelemetryData
} from '../types';
import { ROCKET_SPECS } from '../scenarios';

const G0 = 9.80665;
const RHO0 = 1.225;
const SCALE_HEIGHT = 8500;

interface ContactPoint {
  localPos: THREE.Vector3;
  isLegFoot: boolean;
  isCriticalHull: boolean;
}

export class RocketPhysics {
  public readonly specs: RocketSpecs = { ...ROCKET_SPECS };

  // Rigid body state (posCoM is world position of instantaneous Center of Mass)
  public posCoM = new THREE.Vector3();
  public vel = new THREE.Vector3();
  public quat = new THREE.Quaternion();
  public angVel = new THREE.Vector3(); // body-frame angular velocity (rad/s)

  // Dynamic mass properties
  public fuelMass = 7200;
  public maxFuelMass = 12000;
  public totalMass = 32800;
  public comLocalY = 16.5; // local Y height of CoM from base nozzle plane
  public inertia = new THREE.Vector3(3.5e6, 7.0e4, 3.5e6); // diagonal body-frame inertia (Ix, Iy, Iz)

  // Actuator & mechanical states
  public throttle = 0;           // actual spooled throttle 0..1
  public targetThrottle = 0;
  public gimbalPitch = 0;        // actual spooled -1..1
  public gimbalYaw = 0;          // actual spooled -1..1
  public rcsPitch = 0;
  public rcsYaw = 0;
  public rcsRoll = 0;
  public finPitch = 0;
  public finYaw = 0;
  public legDeploy = 0;          // 0 = stowed, 1 = fully deployed & locked
  public legCommand = false;
  public legsBroken = false;

  // Environment / Wind config
  public baseWindSpeed = 6.5;
  public windGustiness = 0.35;
  public windDirRad = 0;
  public windVector = new THREE.Vector3();
  public gustImpulse = new THREE.Vector3();

  // Telemetry & mission tracking
  public simTime = 0;
  public phase: FlightPhase = 'COAST';
  public failureReason: FailureReason = 'NONE';
  public exploded = false;
  public splashed = false;
  public burnIgnited = false;
  public inContact = false;
  public onPad = false;
  public lastDragForceN = 0;
  public lastDynamicPressure = 0;
  public lastThrustN = 0;

  // Touchdown & settling tracking
  public touchdownSpeed: number | null = null;
  public touchdownHorizSpeed: number | null = null;
  public touchdownTiltDeg: number | null = null;
  public touchdownError: number | null = null;
  public grade: string | null = null;
  private settledTimer = 0;
  private firstContactTriggered = false;
  private legDeploySoundFired = false;
  private outcomeFired = false;
  private windSeed = 1.37;

  // Reusable scratch vectors (avoid GC in 120Hz physics loop)
  private readonly _v1 = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();
  private readonly _v3 = new THREE.Vector3();
  private readonly _invQuat = new THREE.Quaternion();
  private readonly _forceWorld = new THREE.Vector3();
  private readonly _torqueBody = new THREE.Vector3();

  public callbacks: SimEventCallbacks = {};

  constructor() {
    this.updateMassProperties(false);
  }

  public reset(scenario: ScenarioConfig): void {
    this.simTime = 0;
    this.fuelMass = Math.max(0, Math.min(scenario.maxFuelMass, scenario.fuelMass));
    this.maxFuelMass = scenario.maxFuelMass;
    this.throttle = 0;
    this.targetThrottle = 0;
    this.gimbalPitch = 0;
    this.gimbalYaw = 0;
    this.rcsPitch = 0;
    this.rcsYaw = 0;
    this.rcsRoll = 0;
    this.finPitch = 0;
    this.finYaw = 0;
    this.legDeploy = 0;
    this.legCommand = false;
    this.legsBroken = false;

    this.baseWindSpeed = scenario.windSpeed;
    this.windGustiness = scenario.windGustiness;
    this.windDirRad = (scenario.windDirectionDeg * Math.PI) / 180;
    this.gustImpulse.set(0, 0, 0);
    this.windSeed = Math.random() * 100;

    this.phase = 'COAST';
    this.failureReason = 'NONE';
    this.exploded = false;
    this.splashed = false;
    this.burnIgnited = false;
    this.inContact = false;
    this.onPad = false;
    this.lastDragForceN = 0;
    this.lastDynamicPressure = 0;
    this.lastThrustN = 0;

    this.touchdownSpeed = null;
    this.touchdownHorizSpeed = null;
    this.touchdownTiltDeg = null;
    this.touchdownError = null;
    this.grade = null;
    this.settledTimer = 0;
    this.firstContactTriggered = false;
    this.legDeploySoundFired = false;
    this.outcomeFired = false;

    this.updateMassProperties(false);

    // Orientation from initial pitch & roll
    const euler = new THREE.Euler(
      (scenario.startPitchDeg * Math.PI) / 180,
      0,
      (scenario.startRollDeg * Math.PI) / 180,
      'XYZ'
    );
    this.quat.setFromEuler(euler);

    // Place base of booster at startAltitude above padDeckY
    const basePos = new THREE.Vector3(
      scenario.startOffsetX,
      this.specs.padDeckY + scenario.startAltitude,
      scenario.startOffsetZ
    );
    const comOffsetWorld = new THREE.Vector3(0, this.comLocalY, 0).applyQuaternion(this.quat);
    this.posCoM.copy(basePos).add(comOffsetWorld);

    this.vel.set(scenario.startVelX, scenario.startVelY, scenario.startVelZ);
    this.angVel.set(0, 0, 0);

    this.updateWind(0);
  }

  public injectWindGust(strength = 14): void {
    const angle = this.windDirRad + (Math.random() - 0.5) * 0.9;
    this.gustImpulse.set(Math.cos(angle) * strength, 0, Math.sin(angle) * strength);
  }

  public getBasePosition(target = new THREE.Vector3()): THREE.Vector3 {
    const offset = this._v1.set(0, this.comLocalY, 0).applyQuaternion(this.quat);
    return target.copy(this.posCoM).sub(offset);
  }

  public getAltitudeAboveDeck(): number {
    const basePos = this.getBasePosition(this._v2);
    const legExt = this.legsBroken ? 0 : this.legDeploy * this.specs.legDropBelowBase;
    // Account for tilt lowering lowest point slightly
    const up = this._v3.set(0, 1, 0).applyQuaternion(this.quat);
    const cosTilt = Math.max(0.1, up.y);
    return basePos.y - legExt * cosTilt - this.specs.padDeckY;
  }

  public getTiltDeg(): number {
    const up = this._v1.set(0, 1, 0).applyQuaternion(this.quat);
    const cosA = THREE.MathUtils.clamp(up.y, -1, 1);
    return (Math.acos(cosA) * 180) / Math.PI;
  }

  public getUpVector(target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(0, 1, 0).applyQuaternion(this.quat);
  }

  public getBargeBounds(): { halfX: number; halfZ: number } {
    return { halfX: 29.0, halfZ: 43.0 };
  }

  public isPointOverBarge(x: number, z: number): boolean {
    const b = this.getBargeBounds();
    return Math.abs(x) <= b.halfX && Math.abs(z) <= b.halfZ;
  }

  private updateMassProperties(shiftCoMPosition: boolean): void {
    const prevComY = this.comLocalY;
    const mDry = this.specs.dryMass;
    const mFuel = this.fuelMass;
    this.totalMass = mDry + mFuel;

    // Dry booster CoM sits slightly below geometric center due to heavy octaweb + engines at base
    const yDry = 17.8;
    const fillFrac = this.maxFuelMass > 0 ? THREE.MathUtils.clamp(mFuel / this.maxFuelMass, 0, 1) : 0;
    const fuelColHeight = Math.max(0.6, 23.0 * fillFrac);
    const yFuel = 2.6 + 0.5 * fuelColHeight;

    this.comLocalY = (mDry * yDry + mFuel * yFuel) / this.totalMass;

    if (shiftCoMPosition) {
      const dCom = this.comLocalY - prevComY;
      if (Math.abs(dCom) > 1e-7) {
        const shiftWorld = this._v1.set(0, dCom, 0).applyQuaternion(this.quat);
        this.posCoM.add(shiftWorld);
      }
    }

    // Parallel axis theorem for cylindrical dry body + propellant column
    const r = this.specs.radius;
    const L = this.specs.height;
    const iDryPitch = (1 / 12) * mDry * (3 * r * r + L * L) + mDry * (yDry - this.comLocalY) ** 2;
    const iFuelPitch =
      (1 / 12) * mFuel * (3 * r * r + fuelColHeight * fuelColHeight) +
      mFuel * (yFuel - this.comLocalY) ** 2;
    const iPitch = iDryPitch + iFuelPitch;
    const iRoll = 0.5 * this.totalMass * r * r * 1.4; // slightly higher effective roll inertia

    this.inertia.set(iPitch, iRoll, iPitch);
  }

  private updateWind(dt: number): void {
    const t = this.simTime;
    const alt = Math.max(0, this.posCoM.y);

    // Realistic atmospheric boundary layer wind shear (stronger aloft, calmer near sea surface)
    const shearFactor = 0.68 + 0.55 * Math.min(1.0, Math.pow(alt / 350, 0.35));

    // Smooth multi-octave turbulence gusts
    const s = this.windSeed;
    const gustLong =
      Math.sin(t * 0.43 + s) * 0.5 +
      Math.sin(t * 1.17 + s * 2.1) * 0.32 +
      Math.sin(t * 2.61 + s * 0.7) * 0.18;
    const gustCross =
      Math.cos(t * 0.57 + s * 1.4) * 0.55 +
      Math.sin(t * 1.49 + s * 3.2) * 0.45;

    const gustAmp = this.baseWindSpeed * this.windGustiness * 0.65;
    const alongSpeed = Math.max(0, this.baseWindSpeed * shearFactor + gustLong * gustAmp);
    const crossSpeed = gustCross * gustAmp * 0.55;

    const cosD = Math.cos(this.windDirRad);
    const sinD = Math.sin(this.windDirRad);

    // Decay any injected manual wind gust impulse smoothly
    if (dt > 0) {
      this.gustImpulse.multiplyScalar(Math.exp(-dt * 0.42));
    }

    this.windVector.set(
      alongSpeed * cosD - crossSpeed * sinD + this.gustImpulse.x,
      0,
      alongSpeed * sinD + crossSpeed * cosD + this.gustImpulse.z
    );
  }

  public step(dt: number, cmd: ControlCommand): void {
    // Substep at <= 1/120s for stiff ground contact and fast attitude dynamics
    const maxSubDt = 1 / 120;
    const subSteps = Math.max(1, Math.ceil(dt / maxSubDt));
    const subDt = dt / subSteps;

    for (let i = 0; i < subSteps; i++) {
      this.subStep(subDt, cmd);
    }
  }

  private subStep(dt: number, cmd: ControlCommand): void {
    this.simTime += dt;
    this.updateWind(dt);

    // 1. Actuator dynamics (spool lag, gimbal rate limit, leg hydraulics)
    const hasFuel = this.fuelMass > 0.01 && !this.exploded && !this.splashed;
    this.targetThrottle = hasFuel ? THREE.MathUtils.clamp(cmd.throttle, 0, 1) : 0;

    // Engine spool lag (~0.085s time constant)
    const spoolRate = this.targetThrottle > this.throttle ? 13.0 : 16.0;
    this.throttle += (this.targetThrottle - this.throttle) * Math.min(1, dt * spoolRate);
    if (this.throttle < 0.002 && this.targetThrottle === 0) this.throttle = 0;

    if (this.throttle > 0.08 && !this.burnIgnited && !this.exploded) {
      this.burnIgnited = true;
      this.callbacks.onIgnition?.();
    }

    // Gimbal actuator dynamics
    const targetGP = this.exploded ? 0 : THREE.MathUtils.clamp(cmd.gimbalPitch, -1, 1);
    const targetGY = this.exploded ? 0 : THREE.MathUtils.clamp(cmd.gimbalYaw, -1, 1);
    this.gimbalPitch += (targetGP - this.gimbalPitch) * Math.min(1, dt * 18.0);
    this.gimbalYaw += (targetGY - this.gimbalYaw) * Math.min(1, dt * 18.0);

    this.rcsPitch = this.exploded ? 0 : THREE.MathUtils.clamp(cmd.rcsPitch, -1, 1);
    this.rcsYaw = this.exploded ? 0 : THREE.MathUtils.clamp(cmd.rcsYaw, -1, 1);
    this.rcsRoll = this.exploded ? 0 : THREE.MathUtils.clamp(cmd.rcsRoll, -1, 1);
    this.finPitch = this.exploded ? 0 : THREE.MathUtils.clamp(cmd.finPitch, -1, 1);
    this.finYaw = this.exploded ? 0 : THREE.MathUtils.clamp(cmd.finYaw, -1, 1);

    // Landing leg deployment (~2.1s full deploy)
    if (cmd.deployLegs && !this.legCommand && !this.exploded) {
      this.legCommand = true;
      if (!this.legDeploySoundFired) {
        this.legDeploySoundFired = true;
        this.callbacks.onLegDeployStart?.();
      }
    }
    if (this.legCommand && !this.legsBroken) {
      this.legDeploy = Math.min(1, this.legDeploy + dt / 2.1);
    } else if (!cmd.deployLegs && !this.inContact && this.legDeploy < 0.99 && !this.legsBroken) {
      this.legCommand = false;
      this.legDeploy = Math.max(0, this.legDeploy - dt / 2.5);
    }

    // 2. Fuel consumption & variable mass update
    let thrustN = 0;
    if (hasFuel && this.throttle > 0) {
      thrustN = this.throttle * this.specs.maxThrust;
      const massFlow = thrustN / (this.specs.isp * G0);
      const burned = massFlow * dt;
      if (burned >= this.fuelMass) {
        thrustN *= this.fuelMass / burned;
        this.fuelMass = 0;
        this.throttle = 0;
      } else {
        this.fuelMass -= burned;
      }
    }
    this.lastThrustN = thrustN;
    this.updateMassProperties(true);

    // 3. Accumulate world forces and body-frame torques
    this._forceWorld.set(0, 0, 0);
    this._torqueBody.set(0, 0, 0);
    this._invQuat.copy(this.quat).invert();

    // 3a. Gravity (subtle altitude attenuation)
    const altSea = Math.max(0, this.posCoM.y);
    const g = G0 * (6371000 / (6371000 + altSea)) ** 2;
    this._forceWorld.y -= this.totalMass * g;

    // 3b. Main engine thrust & TVC torque
    if (thrustN > 0) {
      const angleX = this.gimbalPitch * this.specs.maxGimbalRad;
      const angleZ = this.gimbalYaw * this.specs.maxGimbalRad;
      // Consistent sign convention:
      // +gimbalPitch => +tau_x (nose toward +Z) => tz < 0
      // +gimbalYaw   => +tau_z (nose toward -X) => tx > 0
      const tx = Math.sin(angleZ);
      const tz = -Math.sin(angleX);
      const ty = Math.sqrt(Math.max(0.05, 1 - tx * tx - tz * tz));

      const fBody = this._v1.set(thrustN * tx, thrustN * ty, thrustN * tz);
      // Nozzle position relative to CoM in body frame: (0, -comLocalY, 0)
      const lever = this.comLocalY;
      // r x F = (0, -lever, 0) x (fx, fy, fz) = (-lever * fz, 0, +lever * fx)
      this._torqueBody.x += -lever * fBody.z;
      this._torqueBody.z += lever * fBody.x;

      // Convert thrust force to world frame
      fBody.applyQuaternion(this.quat);
      this._forceWorld.add(fBody);
    }

    // 3c. Cold-gas RCS thrusters (at top interstage)
    if (!this.exploded && !this.splashed) {
      this._torqueBody.x += this.rcsPitch * this.specs.rcsTorquePitchYaw;
      this._torqueBody.z += this.rcsYaw * this.specs.rcsTorquePitchYaw;
      this._torqueBody.y += this.rcsRoll * this.specs.rcsTorqueRoll;
    }

    // 3d. Aerodynamic drag, wind forces, CoP torque & Grid Fins
    const rho = RHO0 * Math.exp(-altSea / SCALE_HEIGHT);
    const vRelWorld = this._v1.copy(this.vel).sub(this.windVector);
    const speedSq = vRelWorld.lengthSq();
    const speed = Math.sqrt(speedSq);
    const qDyn = 0.5 * rho * speedSq;
    this.lastDynamicPressure = qDyn;

    if (speed > 0.05) {
      const vRelBody = this._v2.copy(vRelWorld).applyQuaternion(this._invQuat);

      // Cross-sectional areas
      const areaAxial = Math.PI * this.specs.radius * this.specs.radius * (1 + 0.55 * this.legDeploy);
      const areaLateral = 2 * this.specs.radius * this.specs.height;

      // Anisotropic drag components in body frame (opposing relative airflow)
      const cdAxial = 0.72 + 0.25 * this.legDeploy;
      const cdLat = 1.18;

      const fxDrag = -0.5 * rho * cdLat * areaLateral * vRelBody.x * Math.abs(vRelBody.x);
      const fyDrag = -0.5 * rho * cdAxial * areaAxial * vRelBody.y * Math.abs(vRelBody.y);
      const fzDrag = -0.5 * rho * cdLat * areaLateral * vRelBody.z * Math.abs(vRelBody.z);

      const dragBody = this._v3.set(fxDrag, fyDrag, fzDrag);
      this.lastDragForceN = dragBody.length();

      // Aerodynamic Center of Pressure (CoP) sits near geometric center + grid fin lift (~22.5m)
      // When falling engine-first (vRelBody.y < 0), lateral air pushes upper body creating stabilizing weathercock moment!
      const copOffset = 22.8 - this.comLocalY;
      // r_cop x F_drag = (0, copOffset, 0) x (fx, fy, fz) = (copOffset * fz, 0, -copOffset * fx)
      this._torqueBody.x += copOffset * fzDrag * 0.35;
      this._torqueBody.z += -copOffset * fxDrag * 0.35;

      // Aerodynamic angular damping (prevents unreal spinning in dense air)
      const aeroDamp = rho * 18500 * Math.max(1.0, speed * 0.08);
      this._torqueBody.x -= this.angVel.x * aeroDamp;
      this._torqueBody.z -= this.angVel.z * aeroDamp;
      this._torqueBody.y -= this.angVel.y * aeroDamp * 0.12;

      // Titanium grid fin aerodynamic control authority (scales with dynamic pressure)
      const finAuthority = Math.min(340000, qDyn * 115.0);
      this._torqueBody.x += this.finPitch * finAuthority;
      this._torqueBody.z += this.finYaw * finAuthority;
      this._torqueBody.y += cmd.finRoll * finAuthority * 0.22;

      dragBody.applyQuaternion(this.quat);
      this._forceWorld.add(dragBody);
    } else {
      this.lastDragForceN = 0;
    }

    // 4. Ground / Landing Platform / Ocean multi-point collision solver
    this.solveContacts(dt);

    // 5. Integrate linear & angular motion (semi-implicit symplectic Euler)
    this.vel.addScaledVector(this._forceWorld, dt / this.totalMass);
    this.posCoM.addScaledVector(this.vel, dt);

    // Euler's rotational equations: I * w_dot + w x (I * w) = tau
    const Ix = this.inertia.x;
    const Iy = this.inertia.y;
    const Iz = this.inertia.z;
    const wx = this.angVel.x;
    const wy = this.angVel.y;
    const wz = this.angVel.z;

    const ax = (this._torqueBody.x - (Iz - Iy) * wy * wz) / Ix;
    const ay = (this._torqueBody.y - (Ix - Iz) * wz * wx) / Iy;
    const az = (this._torqueBody.z - (Iy - Ix) * wx * wy) / Iz;

    this.angVel.x += ax * dt;
    this.angVel.y += ay * dt;
    this.angVel.z += az * dt;

    // Gentle structural damping when settled on deck to eliminate micro-jitter
    if (this.inContact && !this.exploded) {
      const speedNow = this.vel.length();
      const angSpeedNow = this.angVel.length();
      if (speedNow < 0.35 && angSpeedNow < 0.08 && this.throttle < 0.02) {
        this.vel.multiplyScalar(Math.max(0, 1 - dt * 5.0));
        this.angVel.multiplyScalar(Math.max(0, 1 - dt * 7.0));
      }
    }

    // Quaternion derivative integration: q_dot = 0.5 * q * (0, wx, wy, wz)
    const dq = new THREE.Quaternion(
      this.angVel.x * 0.5 * dt,
      this.angVel.y * 0.5 * dt,
      this.angVel.z * 0.5 * dt,
      0
    );
    dq.premultiply(this.quat);
    this.quat.x += dq.x;
    this.quat.y += dq.y;
    this.quat.z += dq.z;
    this.quat.w += dq.w;
    this.quat.normalize();

    // 6. Update Flight Phase & Win/Fail State Evaluation
    this.evaluateMissionState(dt);
  }

  private getContactPoints(): ContactPoint[] {
    const pts: ContactPoint[] = [];
    const r = this.specs.radius;
    const legR = this.specs.legSpanRadius;
    const legDrop = this.specs.legDropBelowBase;

    // 4 landing leg footpads (positioned at 45°, 135°, 225°, 315°)
    if (!this.legsBroken && this.legDeploy > 0.35) {
      const deployFrac = THREE.MathUtils.clamp((this.legDeploy - 0.35) / 0.65, 0, 1);
      const curR = r + (legR - r) * deployFrac;
      const curY = -legDrop * deployFrac;
      const d = curR * Math.SQRT1_2;
      pts.push(
        { localPos: new THREE.Vector3(d, curY, d), isLegFoot: true, isCriticalHull: false },
        { localPos: new THREE.Vector3(-d, curY, d), isLegFoot: true, isCriticalHull: false },
        { localPos: new THREE.Vector3(-d, curY, -d), isLegFoot: true, isCriticalHull: false },
        { localPos: new THREE.Vector3(d, curY, -d), isLegFoot: true, isCriticalHull: false }
      );
    }

    // 4 engine skirt / base ring points
    pts.push(
      { localPos: new THREE.Vector3(r, 0, 0), isLegFoot: false, isCriticalHull: true },
      { localPos: new THREE.Vector3(-r, 0, 0), isLegFoot: false, isCriticalHull: true },
      { localPos: new THREE.Vector3(0, 0, r), isLegFoot: false, isCriticalHull: true },
      { localPos: new THREE.Vector3(0, 0, -r), isLegFoot: false, isCriticalHull: true }
    );

    // Mid-fuselage and top interstage points (for realistic tip-over collisions)
    const H = this.specs.height;
    pts.push(
      { localPos: new THREE.Vector3(r, H * 0.5, 0), isLegFoot: false, isCriticalHull: true },
      { localPos: new THREE.Vector3(-r, H * 0.5, 0), isLegFoot: false, isCriticalHull: true },
      { localPos: new THREE.Vector3(0, H * 0.5, r), isLegFoot: false, isCriticalHull: true },
      { localPos: new THREE.Vector3(0, H * 0.5, -r), isLegFoot: false, isCriticalHull: true },
      { localPos: new THREE.Vector3(r, H, 0), isLegFoot: false, isCriticalHull: true },
      { localPos: new THREE.Vector3(-r, H, 0), isLegFoot: false, isCriticalHull: true },
      { localPos: new THREE.Vector3(0, H, r), isLegFoot: false, isCriticalHull: true },
      { localPos: new THREE.Vector3(0, H, -r), isLegFoot: false, isCriticalHull: true }
    );

    return pts;
  }

  private solveContacts(dt: number): void {
    const contacts = this.getContactPoints();
    let anyContact = false;
    let legContactCount = 0;
    let hullDeckHit = false;
    let maxImpactVertSpeed = 0;
    let hitWater = false;

    const kSpring = this.totalMass * 30.0; // smooth hydraulic landing shock absorber (zero micro-chatter)
    const cDamp = this.totalMass * 15.0;   // overdamped landing struts to absorb impact cleanly
    const muFriction = 0.92;               // high-grip deck contact pads

    const omegaWorld = this._v1.copy(this.angVel).applyQuaternion(this.quat);

    for (const cp of contacts) {
      // Offset from CoM in body frame -> world frame
      const rBody = new THREE.Vector3(cp.localPos.x, cp.localPos.y - this.comLocalY, cp.localPos.z);
      const rWorld = rBody.clone().applyQuaternion(this.quat);
      const pWorld = this.posCoM.clone().add(rWorld);

      const overBarge = this.isPointOverBarge(pWorld.x, pWorld.z);
      const surfaceY = overBarge ? this.specs.padDeckY : 0.0;
      const penetration = surfaceY - pWorld.y;

      if (penetration > 0) {
        anyContact = true;

        // Point velocity: v_p = v + omega x r
        const vPoint = this.vel.clone().add(new THREE.Vector3().crossVectors(omegaWorld, rWorld));

        if (!overBarge) {
          // Ocean impact / buoyancy / drag
          hitWater = true;
          const fWaterY = Math.min(this.totalMass * 22, penetration * this.totalMass * 6.5 - vPoint.y * this.totalMass * 2.8);
          const fWater = new THREE.Vector3(
            -vPoint.x * this.totalMass * 1.6,
            Math.max(0, fWaterY),
            -vPoint.z * this.totalMass * 1.6
          );
          this._forceWorld.add(fWater);

          const fBody = fWater.clone().applyQuaternion(this._invQuat);
          this._torqueBody.add(new THREE.Vector3().crossVectors(rBody, fBody));

          if (!this.splashed && pWorld.y < -0.5) {
            this.splashed = true;
            const impactSpd = this.vel.length();
            this.callbacks.onWaterSplash?.(new THREE.Vector3(pWorld.x, 0.2, pWorld.z), impactSpd);
            if (impactSpd > 14 && !this.exploded) {
              this.triggerExplosion('OFF_PAD_OCEAN');
            } else {
              this.failMission('OFF_PAD_OCEAN');
            }
          }
          continue;
        }

        // Solid barge deck contact
        if (cp.isLegFoot) legContactCount++;
        if (cp.isCriticalHull && pWorld.y < surfaceY + 0.05) {
          hullDeckHit = true;
        }

        if (-vPoint.y > maxImpactVertSpeed) {
          maxImpactVertSpeed = -vPoint.y;
        }

        // Normal spring-damper force (pushing upward only)
        const fn = Math.max(0, kSpring * penetration - cDamp * vPoint.y);

        // Tangential Coulomb friction (bounded by rotational roll stability to prevent substep sign-flip)
        const vtX = vPoint.x;
        const vtZ = vPoint.z;
        const vtMag = Math.hypot(vtX, vtZ);
        let fx = 0;
        let fz = 0;
        if (vtMag > 0.0005 && fn > 0) {
          const rHorizSq = Math.max(1.0, rBody.x * rBody.x + rBody.z * rBody.z);
          // Effective mass at contact point accounting for roll inertia Iy
          const mEff = 1 / (1 / this.totalMass + rHorizSq / this.inertia.y);
          const maxNonOvershootF = (vtMag * mEff * 0.35) / Math.max(dt, 0.004);
          const desiredFriction = Math.min(muFriction * fn, maxNonOvershootF);
          fx = -(vtX / vtMag) * desiredFriction;
          fz = -(vtZ / vtMag) * desiredFriction;
        }

        const fContactWorld = new THREE.Vector3(fx, fn, fz);
        this._forceWorld.add(fContactWorld);

        const fContactBody = fContactWorld.clone().applyQuaternion(this._invQuat);
        this._torqueBody.add(new THREE.Vector3().crossVectors(rBody, fContactBody));
      }
    }

    this.inContact = anyContact;
    const basePos = this.getBasePosition(this._v2);
    this.onPad = this.isPointOverBarge(basePos.x, basePos.z);

    // Evaluate first touchdown impact conditions
    if (anyContact && !hitWater && !this.firstContactTriggered && !this.exploded) {
      this.firstContactTriggered = true;
      const vertImpact = Math.abs(this.vel.y);
      const horizImpact = Math.hypot(this.vel.x, this.vel.z);
      const tilt = this.getTiltDeg();
      const err = Math.hypot(basePos.x, basePos.z);

      this.touchdownSpeed = vertImpact;
      this.touchdownHorizSpeed = horizImpact;
      this.touchdownTiltDeg = tilt;
      this.touchdownError = err;

      this.callbacks.onTouchdownImpact?.(
        new THREE.Vector3(basePos.x, this.specs.padDeckY, basePos.z),
        Math.max(vertImpact, maxImpactVertSpeed)
      );

      // Check immediate catastrophic impact failure conditions
      if (this.legDeploy < 0.85) {
        if (vertImpact > 3.2 || horizImpact > 2.5) {
          this.triggerExplosion('LEGS_NOT_DEPLOYED');
        } else {
          this.failMission('LEGS_NOT_DEPLOYED');
        }
      } else if (vertImpact > this.specs.maxSafeVertSpeed * 1.45) {
        // Severe slam -> legs snap & RUD explosion
        this.legsBroken = true;
        this.triggerExplosion('HARD_IMPACT');
      } else if (vertImpact > this.specs.maxSafeVertSpeed) {
        // Moderate slam -> legs buckle, rocket likely tips and blows up
        this.legsBroken = true;
        this.failMission('HARD_IMPACT');
      } else if (horizImpact > this.specs.maxSafeHorizSpeed * 1.85) {
        this.legsBroken = true;
        this.triggerExplosion('TIP_OVER');
      } else if (tilt > this.specs.maxSafeTiltDeg * 1.7) {
        this.failMission('TIP_OVER');
      }
    }

    // Secondary hull smash (e.g. after tipping over or bouncing without legs)
    if (hullDeckHit && !this.exploded) {
      const tilt = this.getTiltDeg();
      const speed = this.vel.length();
      if (tilt > 28 || (this.legsBroken && speed > 4.5) || (!this.legCommand && speed > 4.5)) {
        this.triggerExplosion(
          this.failureReason !== 'NONE'
            ? this.failureReason
            : this.legDeploy < 0.85
              ? 'LEGS_NOT_DEPLOYED'
              : 'TIP_OVER'
        );
      }
    }
  }

  private evaluateMissionState(dt: number): void {
    if (this.phase === 'LANDED' || this.exploded) {
      return;
    }

    const alt = this.getAltitudeAboveDeck();
    const tilt = this.getTiltDeg();
    const speed = this.vel.length();
    const angSpeed = this.angVel.length();
    const basePos = this.getBasePosition(this._v2);
    const padDist = Math.hypot(basePos.x, basePos.z);

    // Detect mid-air fuel exhaustion warning (don't instantly fail until impact unless hopeless,
    // wait — record fuel exhaustion if it hits hard with 0 fuel)
    if (this.phase !== 'FAILED') {
      if ((this.inContact || (this.firstContactTriggered && alt <= 0.25)) && this.onPad) {
        this.phase = 'TOUCHDOWN';
      } else if (this.burnIgnited) {
        this.phase = alt < 85 ? 'FINAL_APPROACH' : 'LANDING_BURN';
      } else {
        this.phase = 'COAST';
      }
    }

    // Check tip-over while on deck
    if (this.inContact && tilt > 34 && !this.exploded) {
      this.failMission('TIP_OVER');
    }

    // Check clean stable landing confirmation
    if (
      this.phase === 'TOUCHDOWN' &&
      this.onPad &&
      this.legDeploy >= 0.85 &&
      !this.legsBroken &&
      tilt <= this.specs.maxSafeTiltDeg &&
      speed < 0.45 &&
      angSpeed < 0.12 &&
      this.throttle < 0.05
    ) {
      this.settledTimer += dt;
      if (this.settledTimer >= 1.4) {
        this.phase = 'LANDED';
        this.failureReason = 'NONE';
        this.touchdownError = padDist;
        this.grade = this.computeGrade(
          padDist,
          this.touchdownSpeed ?? 0,
          this.touchdownTiltDeg ?? tilt
        );
        if (!this.outcomeFired) {
          this.outcomeFired = true;
          this.callbacks.onOutcome?.('LANDED', 'NONE');
        }
      }
    } else {
      this.settledTimer = Math.max(0, this.settledTimer - dt * 1.5);
    }
  }

  private computeGrade(errorM: number, tdSpeed: number, tdTilt: number): string {
    const score =
      100 -
      Math.min(45, errorM * 2.1) -
      Math.min(30, Math.max(0, tdSpeed - 1.2) * 6.5) -
      Math.min(20, tdTilt * 1.8);
    if (score >= 90) return 'S';
    if (score >= 78) return 'A';
    if (score >= 62) return 'B';
    return 'C';
  }

  public triggerExplosion(reason: FailureReason): void {
    if (this.exploded) return;
    this.exploded = true;
    this.throttle = 0;
    this.targetThrottle = 0;
    this.legsBroken = true;

    const finalReason: FailureReason =
      this.fuelMass <= 0.5 && reason === 'HARD_IMPACT' ? 'FUEL_EXHAUSTED' : reason;

    this.failMission(finalReason);

    const boomPos = this.getBasePosition(new THREE.Vector3()).add(new THREE.Vector3(0, 6, 0));
    this.callbacks.onExplosion?.(boomPos, this.vel.clone());
  }

  private failMission(reason: FailureReason): void {
    if (this.phase === 'LANDED') return;
    this.phase = 'FAILED';
    if (this.failureReason === 'NONE') {
      this.failureReason =
        this.fuelMass <= 0.5 && reason === 'HARD_IMPACT' ? 'FUEL_EXHAUSTED' : reason;
    }
    if (!this.outcomeFired) {
      this.outcomeFired = true;
      this.callbacks.onOutcome?.('FAILED', this.failureReason);
    }
  }

  /**
   * Computes predicted landing error (ballistic + active deceleration estimate)
   * so telemetry and the pad target reticle show live estimated touchdown point.
   */
  public estimateLandingPoint(): { x: number; z: number; dist: number; timeToImpact: number } {
    const basePos = this.getBasePosition(this._v2);
    const alt = Math.max(0, this.getAltitudeAboveDeck());

    if (alt <= 0.1 || this.phase === 'LANDED') {
      return {
        x: basePos.x,
        z: basePos.z,
        dist: Math.hypot(basePos.x, basePos.z),
        timeToImpact: 0
      };
    }

    // Current net vertical acceleration estimate
    const up = this.getUpVector(this._v3);
    const curAccelY = (this.lastThrustN * up.y) / this.totalMass - G0;
    // Blend toward gentle braking if descending fast under power
    const effAy = this.throttle > 0.1 ? Math.max(-G0, curAccelY * 0.5) : -G0 * 0.85;

    // Solve 0.5 * a * t^2 + vy * t + alt = 0 for positive t
    const vy = this.vel.y;
    let tImpact = 0;
    if (Math.abs(effAy) < 0.2) {
      tImpact = vy < -0.5 ? alt / -vy : 10;
    } else {
      const disc = vy * vy - 2 * effAy * alt;
      if (disc >= 0) {
        const t1 = (-vy - Math.sqrt(disc)) / effAy;
        const t2 = (-vy + Math.sqrt(disc)) / effAy;
        const candidates = [t1, t2].filter((t) => t > 0.01);
        tImpact = candidates.length > 0 ? Math.min(...candidates) : Math.max(0.5, alt / Math.max(10, -vy));
      } else {
        tImpact = Math.max(0.5, -vy / Math.max(2, effAy));
      }
    }
    tImpact = THREE.MathUtils.clamp(tImpact, 0, 25);

    // Horizontal acceleration from current thrust tilt + wind drift
    const ax = (this.lastThrustN * up.x) / this.totalMass;
    const az = (this.lastThrustN * up.z) / this.totalMass;
    const predX = basePos.x + this.vel.x * tImpact + 0.35 * ax * tImpact * tImpact;
    const predZ = basePos.z + this.vel.z * tImpact + 0.35 * az * tImpact * tImpact;

    return {
      x: predX,
      z: predZ,
      dist: Math.hypot(predX, predZ),
      timeToImpact: tImpact
    };
  }

  public getTelemetry(): TelemetryData {
    const basePos = this.getBasePosition(new THREE.Vector3());
    const alt = Math.max(0, this.getAltitudeAboveDeck());
    const horizSpeed = Math.hypot(this.vel.x, this.vel.z);
    const est = this.estimateLandingPoint();

    return {
      time: this.simTime,
      altitude: alt,
      verticalVelocity: this.vel.y,
      horizontalVelocity: horizSpeed,
      totalSpeed: this.vel.length(),
      fuelMass: this.fuelMass,
      fuelPercent: this.maxFuelMass > 0 ? (this.fuelMass / this.maxFuelMass) * 100 : 0,
      totalMass: this.totalMass,
      thrustN: this.lastThrustN,
      throttle: this.throttle,
      twr: this.lastThrustN / (this.totalMass * G0),
      tiltDeg: this.getTiltDeg(),
      posX: basePos.x,
      posZ: basePos.z,
      distFromPad: Math.hypot(basePos.x, basePos.z),
      estLandingErrorX: est.x,
      estLandingErrorZ: est.z,
      estLandingError: est.dist,
      windX: this.windVector.x,
      windZ: this.windVector.z,
      windSpeed: this.windVector.length(),
      dragForceN: this.lastDragForceN,
      dynamicPressurePa: this.lastDynamicPressure,
      legDeploy: this.legDeploy,
      legsLocked: this.legDeploy >= 0.99 && !this.legsBroken,
      phase: this.phase,
      failureReason: this.failureReason,
      onPad: this.onPad,
      inContact: this.inContact,
      touchdownSpeed: this.touchdownSpeed,
      touchdownHorizSpeed: this.touchdownHorizSpeed,
      touchdownTiltDeg: this.touchdownTiltDeg,
      touchdownError: this.touchdownError,
      burnIgnited: this.burnIgnited,
      grade: this.grade
    };
  }
}
