# VALKYRIE-9 — 3D Reusable Rocket Booster Landing Simulator

Interactive 3D reusable orbital rocket booster landing simulator built with **Three.js**, **TypeScript**, and **Vite** (SpaceX-style ASDS offshore drone ship landing experiment).

## Features
- **6-DOF Rigid-Body Physics**: Gravity, variable mass & shifting center of mass/inertia from fuel consumption, throttleable TVC gimbaled main engine, cold-gas RCS thrusters, aerodynamic drag, grid fins, altitude wind shear, gust disturbances, articulated telescoping landing legs, and multi-point barge/ocean collision physics.
- **Autonomous PID Landing Controller + Manual Mode**: Cascaded position/velocity/attitude PID controller with hoverslam timing and wind rejection, plus full keyboard manual flight with optional Stability Assist (SAS).
- **Live Telemetry HUD**: Altitude, vertical & horizontal velocity, remaining propellant, thrust/TWR, estimated landing error, ASDS target radar, and altitude/velocity profile graph.
- **Cinematic 3D Scene & Slow-Motion Replay**: Golden-hour atmospheric lighting, GLSL animated ocean, detailed ASDS landing platform, exhaust/ground-wash/explosion particles, 5 tracking cameras, procedural Web Audio SFX, and 60 Hz slow-motion replay (`0.1x`–`2.0x`) with timeline event markers.

## Run Locally
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
```
