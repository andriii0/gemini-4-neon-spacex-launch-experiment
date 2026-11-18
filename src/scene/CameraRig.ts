import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CameraMode } from '../types';
import { ROCKET_SPECS } from '../scenarios';

export class CameraRig {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly controls: OrbitControls;
  public mode: CameraMode = 'CINEMATIC';

  private readonly smoothPos = new THREE.Vector3(85, 32, 115);
  private readonly smoothLook = new THREE.Vector3(0, 120, 0);
  private readonly prevTarget = new THREE.Vector3(0, 120, 0);
  private shakeIntensity = 0;
  private shakeTime = 0;
  private cinematicOrbitAngle = 0.65;
  private initialized = false;

  constructor(domElement: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.5, 12000);
    this.camera.position.copy(this.smoothPos);

    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 18;
    this.controls.maxDistance = 1400;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.enabled = false;
  }

  public setMode(mode: CameraMode, rocketBasePos: THREE.Vector3): void {
    this.mode = mode;
    this.controls.enabled = mode === 'ORBIT';
    if (mode === 'ORBIT') {
      const center = rocketBasePos.clone().add(new THREE.Vector3(0, 20, 0));
      this.controls.target.copy(center);
      this.prevTarget.copy(center);
      if (this.camera.position.distanceTo(center) > 400 || this.camera.position.distanceTo(center) < 15) {
        this.camera.position.copy(center).add(new THREE.Vector3(75, 35, 95));
      }
      this.camera.fov = 50;
      this.camera.updateProjectionMatrix();
    }
  }

  public addShake(amount: number): void {
    this.shakeIntensity = Math.min(2.6, this.shakeIntensity + amount);
  }

  public snapToRocket(rocketBasePos: THREE.Vector3): void {
    const center = rocketBasePos.clone().add(new THREE.Vector3(0, 20, 0));
    this.smoothLook.copy(center);
    this.prevTarget.copy(center);
    this.smoothPos.set(95, 28, 128);
    this.camera.position.copy(this.smoothPos);
    this.camera.lookAt(this.smoothLook);
    this.initialized = true;
  }

  public resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  public update(
    dt: number,
    rocketBasePos: THREE.Vector3,
    rocketQuat: THREE.Quaternion,
    throttle: number,
    altitude: number
  ): void {
    const rocketCenter = rocketBasePos.clone().add(new THREE.Vector3(0, 19, 0));

    if (!this.initialized) {
      this.snapToRocket(rocketBasePos);
    }

    // Decay explosion / impact shake + add subtle acoustic rumble when close to thrusting rocket
    this.shakeTime += dt * 36;
    this.shakeIntensity *= Math.exp(-dt * 2.8);
    const camDist = this.camera.position.distanceTo(rocketBasePos);
    const thrustRumble =
      throttle > 0.05 ? (throttle * 0.48) / Math.max(1.0, Math.pow(camDist / 65, 1.35)) : 0;
    const totalShake = this.shakeIntensity + thrustRumble;

    if (this.mode === 'ORBIT') {
      // Shift camera along with rocket so user orbits around moving booster
      const delta = rocketCenter.clone().sub(this.prevTarget);
      this.camera.position.add(delta);
      this.controls.target.add(delta);
      this.prevTarget.copy(rocketCenter);
      this.controls.update();
      this.applyShake(totalShake * 0.35);
      return;
    }

    const desiredPos = new THREE.Vector3();
    const desiredLook = new THREE.Vector3();
    let desiredFov = 48;

    if (this.mode === 'CINEMATIC') {
      // Broadcast tracking camera near barge with smooth dramatic telephoto framing
      this.cinematicOrbitAngle += dt * 0.055;
      const distFactor = THREE.MathUtils.clamp(altitude / 550, 0, 1);
      const camRadius = THREE.MathUtils.lerp(92, 138, distFactor);
      const camHeight = THREE.MathUtils.lerp(22, 46, distFactor);
      desiredPos.set(
        Math.cos(this.cinematicOrbitAngle) * camRadius,
        camHeight,
        Math.sin(this.cinematicOrbitAngle) * camRadius
      );
      // Frame rocket and keep landing pad slightly in view when close
      const lookY = Math.max(14, rocketCenter.y * (0.78 + 0.22 * distFactor));
      desiredLook.set(rocketCenter.x * 0.72, lookY, rocketCenter.z * 0.72);
      // Telephoto zoom when rocket is high, widen smoothly as it lands!
      const dToRocket = desiredPos.distanceTo(rocketCenter);
      desiredFov = THREE.MathUtils.clamp(56 - Math.max(0, dToRocket - 120) * 0.036, 22, 54);
    } else if (this.mode === 'CHASE') {
      // Elevated chase view keeping both rocket and barge in sight
      const toPad = new THREE.Vector3(-rocketCenter.x, 0, -rocketCenter.z);
      const backDir = toPad.lengthSq() > 25 ? toPad.normalize().negate() : new THREE.Vector3(0.45, 0, 0.89);
      const chaseDist = THREE.MathUtils.lerp(72, 128, THREE.MathUtils.clamp(altitude / 600, 0, 1));
      const chaseUp = THREE.MathUtils.lerp(28, 65, THREE.MathUtils.clamp(altitude / 600, 0, 1));
      desiredPos.copy(rocketCenter).addScaledVector(backDir, chaseDist).add(new THREE.Vector3(0, chaseUp, 0));
      desiredPos.y = Math.max(12, desiredPos.y);
      desiredLook.copy(rocketCenter).lerp(new THREE.Vector3(0, ROCKET_SPECS.padDeckY + 8, 0), 0.3);
      desiredFov = 54;
    } else if (this.mode === 'DECK') {
      // Fixed dramatic camera mounted on corner of ASDS deck
      desiredPos.set(25.5, ROCKET_SPECS.padDeckY + 4.8, 37.5);
      desiredLook.copy(rocketCenter);
      const d = desiredPos.distanceTo(rocketCenter);
      desiredFov = THREE.MathUtils.clamp(62 - Math.max(0, d - 90) * 0.042, 24, 62);
    } else if (this.mode === 'ONBOARD') {
      // Iconic booster-mounted side camera near top interstage looking down the stage!
      const localCamOffset = new THREE.Vector3(3.15, 36.2, 0.85);
      const localLookOffset = new THREE.Vector3(1.1, -18.0, 0.2);
      desiredPos.copy(localCamOffset).applyQuaternion(rocketQuat).add(rocketBasePos);
      desiredLook.copy(localLookOffset).applyQuaternion(rocketQuat).add(rocketBasePos);
      desiredFov = 68;
    }

    // Smooth camera response (instant lock for onboard & deck)
    const posLerp = this.mode === 'ONBOARD' || this.mode === 'DECK' ? 1.0 : Math.min(1, dt * 4.8);
    const lookLerp = this.mode === 'ONBOARD' ? 1.0 : Math.min(1, dt * 8.5);

    this.smoothPos.lerp(desiredPos, posLerp);
    this.smoothLook.lerp(desiredLook, lookLerp);

    this.camera.position.copy(this.smoothPos);
    this.applyShake(this.mode === 'ONBOARD' ? totalShake * 0.14 : totalShake);
    this.camera.lookAt(this.smoothLook);

    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, desiredFov, Math.min(1, dt * 4.0));
    this.camera.updateProjectionMatrix();
    this.prevTarget.copy(rocketCenter);
  }

  private applyShake(amp: number): void {
    if (amp < 0.005) return;
    const t = this.shakeTime;
    this.camera.position.x += (Math.sin(t * 1.7) + Math.cos(t * 3.1) * 0.5) * amp;
    this.camera.position.y += (Math.cos(t * 2.3) + Math.sin(t * 4.1) * 0.5) * amp;
    this.camera.position.z += (Math.sin(t * 2.9) - Math.cos(t * 1.9) * 0.5) * amp;
  }
}
