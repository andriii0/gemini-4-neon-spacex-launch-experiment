import { RocketSpecs, ScenarioConfig } from './types';

export const ROCKET_SPECS: RocketSpecs = {
  dryMass: 25600,          // kg (Falcon 9-class first stage)
  maxFuelMass: 12000,      // kg landing propellant capacity
  height: 42.0,            // m
  radius: 1.85,            // m (3.7m diameter)
  maxThrust: 960000,       // N (960 kN single landing engine)
  isp: 282,                // s (sea-level Isp)
  maxGimbalRad: (13 * Math.PI) / 180, // ±13 deg TVC gimbal
  rcsTorquePitchYaw: 420000, // N*m cold-gas nitrogen thrusters at top
  rcsTorqueRoll: 65000,      // N*m roll thrusters
  legSpanRadius: 9.2,        // m footpad radius from centerline
  legDropBelowBase: 2.6,     // m footpad extends below nozzle plane
  padRadius: 27.5,           // m usable deck radius of ASDS drone ship
  padDeckY: 3.4,             // m deck height above sea level (y=0)
  maxSafeVertSpeed: 6.5,     // m/s max safe touchdown vertical impact
  maxSafeHorizSpeed: 4.2,    // m/s max safe horizontal skid speed
  maxSafeTiltDeg: 13.0       // deg max safe tilt at touchdown
};

export const SCENARIOS: ScenarioConfig[] = [
  {
    id: 'nominal-hoverslam',
    name: 'Nominal Hoverslam',
    description: 'Classic high-speed autonomous booster return from 850m with 160m downrange offset and moderate sea breeze.',
    controlMode: 'AUTO',
    startAltitude: 850,
    startOffsetX: -165,
    startOffsetZ: 65,
    startVelX: 28,
    startVelY: -102,
    startVelZ: -11,
    startPitchDeg: -9,
    startRollDeg: 4,
    fuelMass: 7200,
    maxFuelMass: 12000,
    windSpeed: 6.5,
    windGustiness: 0.35,
    windDirectionDeg: 35,
    sasEnabled: true
  },
  {
    id: 'high-crosswind',
    name: 'Storm Crosswind',
    description: 'Severe 17 m/s gusting crosswind & wind shear testing PID disturbance rejection during powered descent.',
    controlMode: 'AUTO',
    startAltitude: 780,
    startOffsetX: -120,
    startOffsetZ: -95,
    startVelX: 16,
    startVelY: -94,
    startVelZ: 14,
    startPitchDeg: -6,
    startRollDeg: -5,
    fuelMass: 8200,
    maxFuelMass: 12000,
    windSpeed: 17.0,
    windGustiness: 0.78,
    windDirectionDeg: 115,
    sasEnabled: true
  },
  {
    id: 'extreme-divert',
    name: 'Extreme Divert Burn',
    description: 'Heavy 270m lateral offset requiring aggressive aerodynamic glide & TVC divert maneuver to reach the barge.',
    controlMode: 'AUTO',
    startAltitude: 980,
    startOffsetX: -240,
    startOffsetZ: 125,
    startVelX: 34,
    startVelY: -108,
    startVelZ: -16,
    startPitchDeg: -14,
    startRollDeg: 6,
    fuelMass: 9000,
    maxFuelMass: 12000,
    windSpeed: 8.0,
    windGustiness: 0.4,
    windDirectionDeg: 210,
    sasEnabled: true
  },
  {
    id: 'manual-approach',
    name: 'Manual Pilot Approach',
    description: 'Take the stick at 420m with generous propellant and Stability Assist (SAS). Use W/A/S/D, Shift/Ctrl, and L for legs.',
    controlMode: 'MANUAL',
    startAltitude: 420,
    startOffsetX: -48,
    startOffsetZ: 24,
    startVelX: 7,
    startVelY: -48,
    startVelZ: -3,
    startPitchDeg: -3,
    startRollDeg: 2,
    fuelMass: 8800,
    maxFuelMass: 12000,
    windSpeed: 4.5,
    windGustiness: 0.25,
    windDirectionDeg: 60,
    sasEnabled: true
  },
  {
    id: 'low-fuel-crisis',
    name: 'Low-Fuel Flameout Risk',
    description: 'Critically low propellant reserves (2,350 kg) from 820m — demonstrates realistic engine flameout & RUD impact unless tuned.',
    controlMode: 'AUTO',
    startAltitude: 820,
    startOffsetX: -145,
    startOffsetZ: 80,
    startVelX: 20,
    startVelY: -112,
    startVelZ: -12,
    startPitchDeg: -10,
    startRollDeg: 5,
    fuelMass: 2350,
    maxFuelMass: 12000,
    windSpeed: 10.5,
    windGustiness: 0.55,
    windDirectionDeg: 45,
    sasEnabled: true
  }
];
