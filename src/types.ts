import * as THREE from 'three';

export type ControlMode = 'AUTO' | 'MANUAL';

export type FlightPhase =
  | 'COAST'
  | 'LANDING_BURN'
  | 'FINAL_APPROACH'
  | 'TOUCHDOWN'
  | 'LANDED'
  | 'FAILED';

export type FailureReason =
  | 'NONE'
  | 'HARD_IMPACT'
  | 'LEGS_NOT_DEPLOYED'
  | 'TIP_OVER'
  | 'OFF_PAD_OCEAN'
  | 'FUEL_EXHAUSTED'
  | 'STRUCTURAL_FAILURE';

export type CameraMode =
  | 'CINEMATIC'
  | 'CHASE'
  | 'DECK'
  | 'ONBOARD'
  | 'ORBIT';

export interface ScenarioConfig {
  id: string;
  name: string;
  description: string;
  controlMode: ControlMode;
  startAltitude: number;     // m (bottom of booster above pad)
  startOffsetX: number;      // m
  startOffsetZ: number;      // m
  startVelX: number;         // m/s
  startVelY: number;         // m/s (negative = downward)
  startVelZ: number;         // m/s
  startPitchDeg: number;     // deg
  startRollDeg: number;      // deg
  fuelMass: number;          // kg
  maxFuelMass: number;       // kg
  windSpeed: number;         // m/s base wind
  windGustiness: number;     // 0..1 gust intensity
  windDirectionDeg: number;  // deg (0 = +X, 90 = +Z)
  sasEnabled: boolean;
}

export interface ControlCommand {
  throttle: number;          // 0..1 target throttle
  gimbalPitch: number;       // -1..1 (normalized max gimbal angle)
  gimbalYaw: number;         // -1..1 (normalized max gimbal angle)
  rcsPitch: number;          // -1..1
  rcsYaw: number;            // -1..1
  rcsRoll: number;           // -1..1
  finPitch: number;          // -1..1
  finYaw: number;            // -1..1
  finRoll: number;           // -1..1
  deployLegs: boolean;
}

export interface RocketSpecs {
  dryMass: number;           // kg
  maxFuelMass: number;       // kg
  height: number;            // m (total booster body length)
  radius: number;            // m (fuselage radius)
  maxThrust: number;         // N
  isp: number;               // s (specific impulse)
  maxGimbalRad: number;      // rad
  rcsTorquePitchYaw: number; // N*m
  rcsTorqueRoll: number;     // N*m
  legSpanRadius: number;     // m (horizontal foot distance from centerline when deployed)
  legDropBelowBase: number;  // m (how far footpads extend below engine nozzle plane)
  padRadius: number;         // m (usable drone ship deck radius)
  padDeckY: number;          // m (deck height above sea level y=0)
  maxSafeVertSpeed: number;  // m/s
  maxSafeHorizSpeed: number; // m/s
  maxSafeTiltDeg: number;    // deg
}

export interface TelemetryData {
  time: number;
  altitude: number;          // m above deck (footpad/nozzle clearance)
  verticalVelocity: number;  // m/s
  horizontalVelocity: number;// m/s
  totalSpeed: number;        // m/s
  fuelMass: number;          // kg
  fuelPercent: number;       // 0..100
  totalMass: number;         // kg
  thrustN: number;           // N
  throttle: number;          // 0..1 actual engine throttle
  twr: number;               // thrust-to-weight ratio
  tiltDeg: number;           // deg from vertical
  posX: number;              // m
  posZ: number;              // m
  distFromPad: number;       // m current horizontal distance
  estLandingErrorX: number;  // m predicted X offset at touchdown
  estLandingErrorZ: number;  // m predicted Z offset at touchdown
  estLandingError: number;   // m predicted radial offset
  windX: number;             // m/s
  windZ: number;             // m/s
  windSpeed: number;         // m/s
  dragForceN: number;        // N
  dynamicPressurePa: number; // Pa (Q)
  legDeploy: number;         // 0..1
  legsLocked: boolean;
  phase: FlightPhase;
  failureReason: FailureReason;
  onPad: boolean;
  inContact: boolean;
  touchdownSpeed: number | null;
  touchdownHorizSpeed: number | null;
  touchdownTiltDeg: number | null;
  touchdownError: number | null;
  burnIgnited: boolean;
  grade: string | null;
}

export interface ReplayEvent {
  time: number;
  label: string;
  color: string;
}

export interface ReplayFrame {
  time: number;
  pos: [number, number, number];
  vel: [number, number, number];
  quat: [number, number, number, number];
  angVel: [number, number, number];
  throttle: number;
  gimbalPitch: number;
  gimbalYaw: number;
  rcsPitch: number;
  rcsYaw: number;
  rcsRoll: number;
  finPitch: number;
  finYaw: number;
  legDeploy: number;
  exploded: boolean;
  splashed: boolean;
  telemetry: TelemetryData;
}

export interface SimEventCallbacks {
  onExplosion?: (position: THREE.Vector3, velocity: THREE.Vector3) => void;
  onWaterSplash?: (position: THREE.Vector3, speed: number) => void;
  onLegDeployStart?: () => void;
  onTouchdownImpact?: (position: THREE.Vector3, speed: number) => void;
  onOutcome?: (phase: 'LANDED' | 'FAILED', reason: FailureReason) => void;
  onIgnition?: () => void;
}
