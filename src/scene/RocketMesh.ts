import * as THREE from 'three';
import { ROCKET_SPECS } from '../scenarios';

interface LegAssembly {
  pivot: THREE.Group;
  upperStrutPivot: THREE.Group;
  upperStrutMesh: THREE.Mesh;
  footPad: THREE.Mesh;
  azimuth: number;
}

export class RocketMesh {
  public readonly group = new THREE.Group();
  public readonly engineLight: THREE.PointLight;

  private readonly centerNozzlePivot = new THREE.Group();
  private readonly flameCore: THREE.Mesh;
  private readonly flameOuter: THREE.Mesh;
  private readonly flameMatCore: THREE.MeshBasicMaterial;
  private readonly flameMatOuter: THREE.MeshBasicMaterial;
  private readonly gridFinPivots: { pivot: THREE.Group; axis: 'X' | 'Z'; sign: number }[] = [];
  private readonly legs: LegAssembly[] = [];
  private readonly nozzleTipLocal = new THREE.Vector3(0, -1.65, 0);
  private readonly bodyVisualGroup = new THREE.Group();

  private flickerPhase = 0;

  constructor() {
    this.group.add(this.bodyVisualGroup);

    const H = ROCKET_SPECS.height; // 42m
    const R = ROCKET_SPECS.radius; // 1.85m

    // 1. Procedural fuselage texture (white aerospace skin + soot + decals + seams)
    const fuselageTex = this.createFuselageTexture();
    const fuselageMat = new THREE.MeshStandardMaterial({
      map: fuselageTex,
      roughness: 0.42,
      metalness: 0.18
    });

    // Main cylindrical propellant tank stage (y = 1.2 to y = 35.5)
    const mainTankH = 34.3;
    const mainTankGeo = new THREE.CylinderGeometry(R, R, mainTankH, 36, 1);
    const mainTank = new THREE.Mesh(mainTankGeo, fuselageMat);
    mainTank.position.y = 1.2 + mainTankH * 0.5;
    mainTank.castShadow = true;
    mainTank.receiveShadow = true;
    this.bodyVisualGroup.add(mainTank);

    // 2. Carbon-fiber interstage (y = 35.5 to 42.0)
    const carbonMat = new THREE.MeshStandardMaterial({
      color: 0x1a1d22,
      roughness: 0.55,
      metalness: 0.35
    });
    const interstageH = H - 35.5;
    const interstage = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 1.006, R * 1.006, interstageH, 32, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x181b20,
        roughness: 0.52,
        metalness: 0.32,
        side: THREE.DoubleSide
      })
    );
    interstage.position.y = 35.5 + interstageH * 0.5;
    interstage.castShadow = true;
    interstage.receiveShadow = true;
    this.bodyVisualGroup.add(interstage);

    // Interstage top ring rim & inner dark cap
    const topRim = new THREE.Mesh(
      new THREE.TorusGeometry(R * 0.99, 0.08, 10, 32),
      new THREE.MeshStandardMaterial({ color: 0x3b4048, roughness: 0.35, metalness: 0.7 })
    );
    topRim.rotation.x = Math.PI / 2;
    topRim.position.y = H;
    this.bodyVisualGroup.add(topRim);

    const innerCap = new THREE.Mesh(
      new THREE.CircleGeometry(R * 0.96, 24),
      new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.9 })
    );
    innerCap.rotation.x = -Math.PI / 2;
    innerCap.position.y = 36.2;
    this.bodyVisualGroup.add(innerCap);

    // Avionics cable raceways along sides
    const racewayMat = new THREE.MeshStandardMaterial({
      color: 0xd9dde2,
      roughness: 0.45,
      metalness: 0.25
    });
    for (const side of [-1, 1]) {
      const rw = new THREE.Mesh(new THREE.BoxGeometry(0.18, 33.5, 0.26), racewayMat);
      rw.position.set(side * (R + 0.04), 18.2, 0);
      rw.castShadow = true;
      this.bodyVisualGroup.add(rw);
    }

    // 3. Octaweb lower thermal base shroud (y = 0 to 1.6)
    const octawebMat = new THREE.MeshStandardMaterial({
      color: 0x1e2024,
      roughness: 0.65,
      metalness: 0.55
    });
    const octaweb = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.02, R * 0.96, 1.6, 24), octawebMat);
    octaweb.position.y = 0.8;
    octaweb.castShadow = true;
    this.bodyVisualGroup.add(octaweb);

    // Heatshield plate at y = 0
    const heatshield = new THREE.Mesh(
      new THREE.CircleGeometry(R * 0.96, 24),
      new THREE.MeshStandardMaterial({ color: 0x151618, roughness: 0.75, metalness: 0.6 })
    );
    heatshield.rotation.x = Math.PI / 2;
    heatshield.position.y = 0.02;
    this.bodyVisualGroup.add(heatshield);

    // 4. Engine Bells: 8 outer Merlin bells + 1 central gimbaled landing engine bell
    const bellMat = new THREE.MeshStandardMaterial({
      color: 0x3a3e46,
      roughness: 0.32,
      metalness: 0.85
    });
    const outerBellGeo = new THREE.CylinderGeometry(0.22, 0.42, 1.15, 16, 1, true);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const bell = new THREE.Mesh(outerBellGeo, bellMat);
      bell.position.set(Math.cos(a) * 1.24, -0.48, Math.sin(a) * 1.24);
      this.bodyVisualGroup.add(bell);
    }

    // Center gimbaled landing engine
    this.centerNozzlePivot.position.set(0, 0.05, 0);
    this.bodyVisualGroup.add(this.centerNozzlePivot);

    const centerBell = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.54, 1.48, 22, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x4b505a,
        roughness: 0.28,
        metalness: 0.9,
        side: THREE.DoubleSide
      })
    );
    centerBell.position.y = -0.72;
    this.centerNozzlePivot.add(centerBell);

    // Glowing inner engine throat
    const throat = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 16),
      new THREE.MeshBasicMaterial({ color: 0xffd28a, side: THREE.DoubleSide })
    );
    throat.rotation.x = Math.PI / 2;
    throat.position.y = -0.95;
    this.centerNozzlePivot.add(throat);

    // 5. Dynamic Plasma Mach-Diamond Exhaust Cone (attached to gimbaled nozzle)
    this.flameMatCore = new THREE.MeshBasicMaterial({
      color: 0xfff4d6,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const coreGeo = new THREE.ConeGeometry(0.62, 14.0, 18, 1, true);
    coreGeo.translate(0, -7.0, 0);
    coreGeo.rotateX(Math.PI); // tip pointing downward? Wait: Cone apex is at +Y, base at -Y -> rotateX(PI) puts base at +Y (nozzle), apex at -Y!
    // Let's position directly: base at y = 0, apex at y = -14
    const coreGeoFixed = new THREE.ConeGeometry(0.56, 14.0, 18, 1, true);
    coreGeoFixed.rotateX(Math.PI);
    coreGeoFixed.translate(0, -7.0, 0);
    this.flameCore = new THREE.Mesh(coreGeoFixed, this.flameMatCore);
    this.flameCore.position.y = -1.35;
    this.flameCore.visible = false;
    this.centerNozzlePivot.add(this.flameCore);

    this.flameMatOuter = new THREE.MeshBasicMaterial({
      color: 0xff7b22,
      transparent: true,
      opacity: 0.52,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const outerGeo = new THREE.ConeGeometry(1.15, 22.0, 18, 1, true);
    outerGeo.rotateX(Math.PI);
    outerGeo.translate(0, -11.0, 0);
    this.flameOuter = new THREE.Mesh(outerGeo, this.flameMatOuter);
    this.flameOuter.position.y = -1.3;
    this.flameOuter.visible = false;
    this.centerNozzlePivot.add(this.flameOuter);

    // Engine illumination light (casts warm glow onto deck, smoke, and legs!)
    this.engineLight = new THREE.PointLight(0xff9436, 0, 190, 1.45);
    this.engineLight.position.set(0, -4.5, 0);
    this.centerNozzlePivot.add(this.engineLight);

    // 6. Four Titanium Grid Fins at top of interstage (y = 38.0)
    const finMat = new THREE.MeshStandardMaterial({
      color: 0x3b3f47,
      roughness: 0.45,
      metalness: 0.78
    });
    const finSpecs: { angle: number; axis: 'X' | 'Z'; sign: number }[] = [
      { angle: 0, axis: 'X', sign: 1 },
      { angle: Math.PI, axis: 'X', sign: -1 },
      { angle: Math.PI / 2, axis: 'Z', sign: 1 },
      { angle: -Math.PI / 2, axis: 'Z', sign: -1 }
    ];
    for (const fs of finSpecs) {
      const mount = new THREE.Group();
      mount.position.set(Math.cos(fs.angle) * (R + 0.05), 38.2, Math.sin(fs.angle) * (R + 0.05));
      mount.rotation.y = -fs.angle;
      this.bodyVisualGroup.add(mount);

      const pivot = new THREE.Group();
      mount.add(pivot);

      // Waffle frame + cross ribs
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.24, 1.5), finMat);
      frame.position.set(1.05, 0, 0);
      frame.castShadow = true;
      pivot.add(frame);

      // Visual waffle slots (darker inset bars)
      const slotMat = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.7 });
      for (let gx = -0.6; gx <= 0.65; gx += 0.42) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 1.25), slotMat);
        rib.position.set(1.05 + gx, 0, 0);
        pivot.add(rib);
      }

      this.gridFinPivots.push({ pivot, axis: fs.axis, sign: fs.sign });
    }

    // 7. Four Articulated Carbon-Fiber Telescoping Landing Legs (45°, 135°, 225°, 315°)
    const legMat = new THREE.MeshStandardMaterial({
      color: 0x1b1e23,
      roughness: 0.48,
      metalness: 0.35
    });
    const pistonMat = new THREE.MeshStandardMaterial({
      color: 0xc8d0da,
      roughness: 0.22,
      metalness: 0.88
    });

    for (let i = 0; i < 4; i++) {
      const azimuth = Math.PI / 4 + (i * Math.PI) / 2;
      const cosA = Math.cos(azimuth);
      const sinA = Math.sin(azimuth);

      // Base hinge on lower fuselage at y = 1.4
      const pivot = new THREE.Group();
      pivot.position.set(cosA * (R + 0.06), 1.4, sinA * (R + 0.06));
      pivot.rotation.y = -azimuth;
      this.bodyVisualGroup.add(pivot);

      // Tapered aerodynamic carbon leg housing (points +Y when stowed, rotates outward around -Z when deployed)
      const legLen = 8.45;
      const legGeo = new THREE.BoxGeometry(0.42, legLen, 1.05);
      legGeo.translate(0, legLen * 0.5, 0);
      const legMesh = new THREE.Mesh(legGeo, legMat);
      legMesh.castShadow = true;
      legMesh.receiveShadow = true;
      pivot.add(legMesh);

      // Footpad at tip of leg
      const footPad = new THREE.Mesh(
        new THREE.CylinderGeometry(0.58, 0.72, 0.28, 12),
        carbonMat
      );
      footPad.position.set(0.15, legLen, 0);
      footPad.castShadow = true;
      pivot.add(footPad);

      // Upper telescoping pneumatic strut anchored at y = 10.6 on fuselage
      const upperStrutPivot = new THREE.Group();
      upperStrutPivot.position.set(cosA * (R + 0.02), 10.6, sinA * (R + 0.02));
      upperStrutPivot.rotation.y = -azimuth;
      this.bodyVisualGroup.add(upperStrutPivot);

      const strutGeo = new THREE.CylinderGeometry(0.11, 0.13, 1.0, 10);
      strutGeo.translate(0, -0.5, 0); // extends downward along -Y, scaled dynamically
      const upperStrutMesh = new THREE.Mesh(strutGeo, pistonMat);
      upperStrutMesh.castShadow = true;
      upperStrutPivot.add(upperStrutMesh);

      this.legs.push({ pivot, upperStrutPivot, upperStrutMesh, footPad, azimuth });
    }

    this.updateLegArticulation(0);
  }

  private createFuselageTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 2048;
    const ctx = canvas.getContext('2d')!;

    // Base bright satin aerospace white
    const baseGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    baseGrad.addColorStop(0.0, '#f3f5f8');
    baseGrad.addColorStop(0.52, '#eceff3');
    baseGrad.addColorStop(0.75, '#d5d8dc');
    baseGrad.addColorStop(0.92, '#7b7c80'); // realistic RP-1 re-entry soot near bottom!
    baseGrad.addColorStop(1.0, '#2e3034');
    ctx.fillStyle = baseGrad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Subtle vertical soot streaks on lower half
    for (let i = 0; i < 95; i++) {
      const x = Math.random() * canvas.width;
      const w = 6 + Math.random() * 24;
      const yStart = canvas.height * (0.48 + Math.random() * 0.25);
      const g = ctx.createLinearGradient(0, yStart, 0, canvas.height);
      g.addColorStop(0, 'rgba(35,36,40,0)');
      g.addColorStop(1, `rgba(28,28,32,${0.08 + Math.random() * 0.14})`);
      ctx.fillStyle = g;
      ctx.fillRect(x, yStart, w, canvas.height - yStart);
    }

    // Horizontal weld seam bands
    ctx.strokeStyle = 'rgba(60, 68, 78, 0.22)';
    ctx.lineWidth = 3;
    for (let y = 120; y < canvas.height; y += 165) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Accent mission band near upper tank
    ctx.fillStyle = '#0e4c92';
    ctx.fillRect(0, 175, canvas.width, 32);
    ctx.fillStyle = '#ff6a1a';
    ctx.fillRect(0, 212, canvas.width, 12);

    // Crisp vertical lettering "VALKYRIE-9" on two opposite sides
    const drawVerticalText = (cx: number) => {
      ctx.save();
      ctx.fillStyle = '#182230';
      ctx.font = 'bold 54px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const letters = 'VALKYRIE'.split('');
      letters.forEach((ch, idx) => {
        ctx.fillText(ch, cx, 380 + idx * 72);
      });
      ctx.fillStyle = '#0f62fe';
      ctx.font = 'bold 74px "Segoe UI", Arial, sans-serif';
      ctx.fillText('9', cx, 380 + letters.length * 74 + 14);
      ctx.restore();
    };
    drawVerticalText(canvas.width * 0.25);
    drawVerticalText(canvas.width * 0.75);

    // Subtle dark carbon leg fairing silhouettes on lower quarter
    ctx.fillStyle = 'rgba(20, 22, 26, 0.25)';
    for (let i = 0; i < 4; i++) {
      const cx = ((i + 0.5) / 4) * canvas.width;
      ctx.fillRect(cx - 26, canvas.height * 0.72, 52, canvas.height * 0.28);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  public updateVisuals(
    basePos: THREE.Vector3,
    quat: THREE.Quaternion,
    throttle: number,
    gimbalPitch: number,
    gimbalYaw: number,
    finPitch: number,
    finYaw: number,
    legDeploy: number,
    exploded: boolean,
    dt: number
  ): void {
    this.group.position.copy(basePos);
    this.group.quaternion.copy(quat);

    // Hide intact fuselage slightly / char & collapse if exploded? Keep charred wreckage or hide core!
    this.bodyVisualGroup.visible = !exploded;

    // Gimbal center nozzle smoothly
    const maxG = ROCKET_SPECS.maxGimbalRad;
    this.centerNozzlePivot.rotation.set(gimbalPitch * maxG * 1.4, 0, -gimbalYaw * maxG * 1.4);

    // Grid fin deflections
    for (const gf of this.gridFinPivots) {
      const cmd = gf.axis === 'X' ? finPitch : finYaw;
      gf.pivot.rotation.x = cmd * gf.sign * 0.38;
    }

    // Landing leg articulation
    this.updateLegArticulation(legDeploy);

    // Dynamic Mach-diamond flame & engine point light
    this.flickerPhase += dt * 48;
    if (throttle > 0.015 && !exploded) {
      const flicker = 0.92 + 0.08 * Math.sin(this.flickerPhase) + 0.05 * Math.sin(this.flickerPhase * 2.7);
      const scaleLen = (0.35 + 1.05 * throttle) * flicker;
      const scaleRad = (0.55 + 0.55 * throttle) * (0.96 + 0.04 * flicker);

      this.flameCore.visible = true;
      this.flameOuter.visible = true;
      this.flameCore.scale.set(scaleRad, scaleLen, scaleRad);
      this.flameOuter.scale.set(scaleRad * 1.15, scaleLen * 1.18, scaleRad * 1.15);
      this.flameMatCore.opacity = Math.min(0.95, 0.35 + throttle * 0.65);
      this.flameMatOuter.opacity = Math.min(0.65, 0.2 + throttle * 0.45);

      this.engineLight.intensity = throttle * 4200 * flicker;
    } else {
      this.flameCore.visible = false;
      this.flameOuter.visible = false;
      this.engineLight.intensity = 0;
    }
  }

  private updateLegArticulation(legDeploy: number): void {
    // Smooth ease-out hydraulic curve
    const t = THREE.MathUtils.clamp(legDeploy, 0, 1);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    // Pivot angle: 0 rad = folded straight UP against fuselage
    // Fully deployed: swings out to ~118 deg (2.06 rad) so footpad reaches R = 9.2m, y = -2.6m
    const deployAngle = ease * 2.06;

    for (const leg of this.legs) {
      leg.pivot.rotation.z = -deployAngle;
      // Keep footpad level with ground as leg extends
      leg.footPad.rotation.z = deployAngle;

      // Compute telescoping upper piston geometry linking anchor (R, 10.6) to leg attachment point
      const legAttachDist = 5.4;
      const ax = Math.sin(deployAngle) * legAttachDist; // radial outward from lower hinge
      const ay = 1.4 + Math.cos(deployAngle) * legAttachDist; // height in rocket frame
      const dx = ax;
      const dy = ay - 10.6;
      const len = Math.hypot(dx, dy);
      const angle = Math.atan2(dx, -dy);

      leg.upperStrutPivot.rotation.z = angle;
      leg.upperStrutMesh.scale.set(1, Math.max(0.5, len), 1);
    }
  }

  public getNozzleWorldPosition(target = new THREE.Vector3()): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return target.copy(this.nozzleTipLocal).applyMatrix4(this.centerNozzlePivot.matrixWorld);
  }

  public getExhaustWorldDirection(target = new THREE.Vector3()): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    const q = new THREE.Quaternion();
    this.centerNozzlePivot.getWorldQuaternion(q);
    return target.set(0, -1, 0).applyQuaternion(q).normalize();
  }

  public getRCSWorldPosition(localOffset: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return target.copy(localOffset).applyMatrix4(this.group.matrixWorld);
  }
}
