import * as THREE from 'three';
import { ROCKET_SPECS } from '../scenarios';

interface Particle {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  sizeStart: number;
  sizeEnd: number;
  colorStart: THREE.Color;
  colorEnd: THREE.Color;
  alphaStart: number;
  drag: number;
  buoyancy: number;
  collideDeck: boolean;
}

interface DebrisPiece {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  age: number;
  life: number;
  active: boolean;
}

export class ParticleSystem {
  private readonly group = new THREE.Group();

  // Fire / Additive particles
  private readonly fireMax = 1400;
  private readonly firePool: Particle[] = [];
  private readonly firePoints: THREE.Points;
  private readonly firePosArr: Float32Array;
  private readonly fireColArr: Float32Array;
  private readonly fireSizeArr: Float32Array;
  private readonly fireAlphaArr: Float32Array;
  private fireCursor = 0;

  // Smoke / Spray / RCS (Normal alpha-blended) particles
  private readonly smokeMax = 1600;
  private readonly smokePool: Particle[] = [];
  private readonly smokePoints: THREE.Points;
  private readonly smokePosArr: Float32Array;
  private readonly smokeColArr: Float32Array;
  private readonly smokeSizeArr: Float32Array;
  private readonly smokeAlphaArr: Float32Array;
  private smokeCursor = 0;

  // Explosion shockwave ring + debris chunks
  private readonly shockwave: THREE.Mesh;
  private readonly shockwaveMat: THREE.MeshBasicMaterial;
  private shockwaveAge = -1;
  private readonly debris: DebrisPiece[] = [];
  private readonly explosionLight: THREE.PointLight;
  private explosionLightAge = -1;

  private readonly _tmpColor = new THREE.Color();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);

    const spriteTex = this.createSoftParticleTexture();

    // 1. Additive Fire Buffer
    this.firePosArr = new Float32Array(this.fireMax * 3);
    this.fireColArr = new Float32Array(this.fireMax * 3);
    this.fireSizeArr = new Float32Array(this.fireMax);
    this.fireAlphaArr = new Float32Array(this.fireMax);

    for (let i = 0; i < this.fireMax; i++) {
      this.firePool.push(this.makeEmptyParticle());
    }
    this.firePoints = this.createPointsCloud(
      this.firePosArr,
      this.fireColArr,
      this.fireSizeArr,
      this.fireAlphaArr,
      spriteTex,
      THREE.AdditiveBlending
    );
    this.group.add(this.firePoints);

    // 2. Normal-Blended Smoke / Steam / RCS Buffer
    this.smokePosArr = new Float32Array(this.smokeMax * 3);
    this.smokeColArr = new Float32Array(this.smokeMax * 3);
    this.smokeSizeArr = new Float32Array(this.smokeMax);
    this.smokeAlphaArr = new Float32Array(this.smokeMax);

    for (let i = 0; i < this.smokeMax; i++) {
      this.smokePool.push(this.makeEmptyParticle());
    }
    this.smokePoints = this.createPointsCloud(
      this.smokePosArr,
      this.smokeColArr,
      this.smokeSizeArr,
      this.smokeAlphaArr,
      spriteTex,
      THREE.NormalBlending
    );
    this.group.add(this.smokePoints);

    // 3. Shockwave Ring
    this.shockwaveMat = new THREE.MeshBasicMaterial({
      color: 0xffb366,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.shockwave = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.0, 48), this.shockwaveMat);
    this.shockwave.rotation.x = -Math.PI / 2;
    this.shockwave.visible = false;
    this.group.add(this.shockwave);

    // 4. Explosion Flash PointLight
    this.explosionLight = new THREE.PointLight(0xff7722, 0, 320, 1.4);
    this.group.add(this.explosionLight);

    // 5. Tumbling 3D Debris Chunks
    const debrisMatWhite = new THREE.MeshStandardMaterial({
      color: 0xd9dde2,
      roughness: 0.65,
      metalness: 0.3
    });
    const debrisMatDark = new THREE.MeshStandardMaterial({
      color: 0x202328,
      roughness: 0.75,
      metalness: 0.5
    });
    for (let i = 0; i < 38; i++) {
      const geo =
        i % 3 === 0
          ? new THREE.BoxGeometry(1.4 + Math.random() * 2.2, 0.35, 1.2 + Math.random() * 1.8)
          : new THREE.CylinderGeometry(0.4 + Math.random() * 0.8, 0.5 + Math.random() * 0.9, 1.4 + Math.random() * 2.4, 7);
      const mesh = new THREE.Mesh(geo, i % 2 === 0 ? debrisMatWhite : debrisMatDark);
      mesh.visible = false;
      mesh.castShadow = true;
      this.group.add(mesh);
      this.debris.push({
        mesh,
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        age: 0,
        life: 6,
        active: false
      });
    }
  }

  private makeEmptyParticle(): Particle {
    return {
      active: false,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      age: 0,
      life: 1,
      sizeStart: 1,
      sizeEnd: 2,
      colorStart: new THREE.Color(1, 1, 1),
      colorEnd: new THREE.Color(1, 1, 1),
      alphaStart: 1,
      drag: 0.5,
      buoyancy: 0,
      collideDeck: false
    };
  }

  private createSoftParticleTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.28, 'rgba(255,255,255,0.78)');
    g.addColorStop(0.62, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  private createPointsCloud(
    posArr: Float32Array,
    colArr: Float32Array,
    sizeArr: Float32Array,
    alphaArr: Float32Array,
    tex: THREE.CanvasTexture,
    blending: THREE.Blending
  ): THREE.Points {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colArr, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizeArr, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphaArr, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending,
      uniforms: {
        uMap: { value: tex }
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPos;
          gl_PointSize = clamp(aSize * (520.0 / max(1.0, -mvPos.z)), 1.0, 260.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.005) discard;
          vec4 tex = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(vColor, tex.a * vAlpha);
        }
      `
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    return pts;
  }

  private spawnFire(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    life: number,
    sizeStart: number,
    sizeEnd: number,
    cStart: number,
    cEnd: number,
    alphaStart: number,
    drag = 0.8,
    buoyancy = 0,
    collideDeck = true
  ): void {
    const p = this.firePool[this.fireCursor];
    this.fireCursor = (this.fireCursor + 1) % this.fireMax;
    p.active = true;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.age = 0;
    p.life = life;
    p.sizeStart = sizeStart;
    p.sizeEnd = sizeEnd;
    p.colorStart.setHex(cStart);
    p.colorEnd.setHex(cEnd);
    p.alphaStart = alphaStart;
    p.drag = drag;
    p.buoyancy = buoyancy;
    p.collideDeck = collideDeck;
  }

  private spawnSmoke(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    life: number,
    sizeStart: number,
    sizeEnd: number,
    cStart: number,
    cEnd: number,
    alphaStart: number,
    drag = 1.4,
    buoyancy = 2.5,
    collideDeck = true
  ): void {
    const p = this.smokePool[this.smokeCursor];
    this.smokeCursor = (this.smokeCursor + 1) % this.smokeMax;
    p.active = true;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.age = 0;
    p.life = life;
    p.sizeStart = sizeStart;
    p.sizeEnd = sizeEnd;
    p.colorStart.setHex(cStart);
    p.colorEnd.setHex(cEnd);
    p.alphaStart = alphaStart;
    p.drag = drag;
    p.buoyancy = buoyancy;
    p.collideDeck = collideDeck;
  }

  public clear(): void {
    for (const p of this.firePool) p.active = false;
    for (const p of this.smokePool) p.active = false;
    for (const d of this.debris) {
      d.active = false;
      d.mesh.visible = false;
    }
    this.shockwave.visible = false;
    this.shockwaveAge = -1;
    this.explosionLight.intensity = 0;
    this.explosionLightAge = -1;
  }

  public emitEngineExhaust(
    nozzlePos: THREE.Vector3,
    exhaustDir: THREE.Vector3,
    rocketVel: THREE.Vector3,
    throttle: number,
    altitude: number,
    dt: number
  ): void {
    if (throttle <= 0.015) return;

    const rateScale = Math.min(2.2, dt * 60);
    const fireCount = Math.max(1, Math.round(throttle * 11 * rateScale));
    const smokeCount = Math.max(1, Math.round(throttle * 6 * rateScale));

    for (let i = 0; i < fireCount; i++) {
      const spread = 0.08 + (1 - throttle) * 0.05;
      const speed = (65 + throttle * 75) * (0.82 + Math.random() * 0.36);
      const v = new THREE.Vector3(
        exhaustDir.x + (Math.random() - 0.5) * spread,
        exhaustDir.y + (Math.random() - 0.5) * spread,
        exhaustDir.z + (Math.random() - 0.5) * spread
      )
        .normalize()
        .multiplyScalar(speed)
        .addScaledVector(rocketVel, 0.35);

      const p = nozzlePos.clone().addScaledVector(exhaustDir, Math.random() * 1.6);
      this.spawnFire(
        p,
        v,
        0.16 + Math.random() * 0.16 * throttle,
        2.1 + throttle * 1.6,
        5.5 + throttle * 4.5,
        0xfff6d8,
        0xff4d0d,
        0.82,
        1.9,
        0,
        true
      );
    }

    for (let i = 0; i < smokeCount; i++) {
      const speed = (38 + throttle * 42) * (0.7 + Math.random() * 0.5);
      const v = new THREE.Vector3(
        exhaustDir.x + (Math.random() - 0.5) * 0.22,
        exhaustDir.y + (Math.random() - 0.5) * 0.22,
        exhaustDir.z + (Math.random() - 0.5) * 0.22
      )
        .normalize()
        .multiplyScalar(speed)
        .addScaledVector(rocketVel, 0.25);

      const p = nozzlePos.clone().addScaledVector(exhaustDir, 3.5 + Math.random() * 3.0);
      this.spawnSmoke(
        p,
        v,
        0.7 + Math.random() * 0.9,
        3.2,
        14.0 + throttle * 9.0,
        0xd9cec5,
        0x8d959e,
        0.24 * throttle,
        1.5,
        3.5,
        true
      );
    }

    // Dramatic Ground-Effect / Deck Impingement Radial Plume when < 62m!
    if (altitude < 62 && throttle > 0.08) {
      const proximity = 1 - altitude / 62;
      const washCount = Math.max(1, Math.round(proximity * throttle * 12 * rateScale));
      const overBarge = Math.abs(nozzlePos.x) <= 30 && Math.abs(nozzlePos.z) <= 44;
      const surfY = overBarge ? ROCKET_SPECS.padDeckY + 0.45 : 0.45;

      for (let i = 0; i < washCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radialSpd = (18 + proximity * 42 * throttle) * (0.7 + Math.random() * 0.6);
        const startR = 1.5 + Math.random() * 4.5;
        const p = new THREE.Vector3(
          nozzlePos.x + Math.cos(angle) * startR,
          surfY + Math.random() * 1.4,
          nozzlePos.z + Math.sin(angle) * startR
        );
        const v = new THREE.Vector3(
          Math.cos(angle) * radialSpd,
          2.5 + Math.random() * 6.5 * proximity,
          Math.sin(angle) * radialSpd
        );
        this.spawnSmoke(
          p,
          v,
          0.95 + Math.random() * 1.15,
          4.5,
          20.0 + proximity * 14.0,
          overBarge ? 0xf2dfd0 : 0xe4f1f8,
          0x9ca6b2,
          0.34 * proximity * throttle,
          1.35,
          4.2,
          false
        );

        // Occasional hot deck sparks/embers when very close
        if (proximity > 0.55 && Math.random() < 0.35) {
          this.spawnFire(
            p,
            v.clone().multiplyScalar(1.15),
            0.25 + Math.random() * 0.25,
            2.4,
            7.0,
            0xffbe66,
            0xff4800,
            0.55 * proximity,
            2.2,
            2.0,
            false
          );
        }
      }
    }
  }

  public emitRCSPuff(worldPos: THREE.Vector3, worldDir: THREE.Vector3, intensity: number, rocketVel: THREE.Vector3): void {
    const mag = Math.abs(intensity);
    if (mag < 0.14) return;
    const count = mag > 0.6 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const v = worldDir
        .clone()
        .multiplyScalar(16 + mag * 22)
        .add(new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3))
        .add(rocketVel);
      this.spawnSmoke(
        worldPos,
        v,
        0.24 + Math.random() * 0.16,
        0.9,
        4.6,
        0xf8fafc,
        0xcbd5e1,
        0.42 * mag,
        2.6,
        0.5,
        false
      );
    }
  }

  public triggerExplosion(pos: THREE.Vector3, baseVel: THREE.Vector3): void {
    // Huge bright fireball burst
    for (let i = 0; i < 240; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.85 + 0.05, Math.random() - 0.5).normalize();
      const spd = 12 + Math.random() * 68;
      this.spawnFire(
        pos.clone().addScaledVector(dir, Math.random() * 3.5),
        dir.multiplyScalar(spd).addScaledVector(baseVel, 0.25),
        0.85 + Math.random() * 1.4,
        6.5 + Math.random() * 5.0,
        22.0 + Math.random() * 16.0,
        0xfff0c2,
        0xd92600,
        0.95,
        1.1,
        14.0,
        true
      );
    }

    // Thick black/grey rising smoke column
    for (let i = 0; i < 180; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.1, Math.random() - 0.5).normalize();
      const spd = 8 + Math.random() * 44;
      this.spawnSmoke(
        pos.clone().addScaledVector(dir, Math.random() * 5.0),
        dir.multiplyScalar(spd),
        2.8 + Math.random() * 3.4,
        9.0,
        36.0 + Math.random() * 18.0,
        0x3b3532,
        0x16181c,
        0.65,
        0.9,
        11.0,
        true
      );
    }

    // Shockwave ring
    this.shockwave.position.set(pos.x, Math.max(ROCKET_SPECS.padDeckY + 0.3, pos.y - 2.0), pos.z);
    this.shockwave.scale.set(1, 1, 1);
    this.shockwave.visible = true;
    this.shockwaveAge = 0;

    // Bright flash light
    this.explosionLight.position.copy(pos).add(new THREE.Vector3(0, 6, 0));
    this.explosionLight.intensity = 24000;
    this.explosionLightAge = 0;

    // Launch tumbling 3D debris chunks
    for (const d of this.debris) {
      d.active = true;
      d.age = 0;
      d.life = 6.0 + Math.random() * 4.0;
      d.mesh.visible = true;
      d.mesh.position.copy(pos).add(
        new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 14, (Math.random() - 0.5) * 6)
      );
      d.mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      const a = Math.random() * Math.PI * 2;
      const hSpd = 10 + Math.random() * 38;
      d.vel.set(Math.cos(a) * hSpd, 14 + Math.random() * 34, Math.sin(a) * hSpd);
      d.angVel.set((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9);
    }
  }

  public triggerWaterSplash(pos: THREE.Vector3, speed: number): void {
    const scale = THREE.MathUtils.clamp(speed / 35, 0.5, 2.2);
    for (let i = 0; i < 160; i++) {
      const a = Math.random() * Math.PI * 2;
      const rSpd = (6 + Math.random() * 24) * scale;
      const upSpd = (14 + Math.random() * 36) * scale;
      this.spawnSmoke(
        new THREE.Vector3(pos.x + Math.cos(a) * 2.5, 0.5, pos.z + Math.sin(a) * 2.5),
        new THREE.Vector3(Math.cos(a) * rSpd, upSpd, Math.sin(a) * rSpd),
        1.5 + Math.random() * 1.8,
        5.0,
        22.0,
        0xf0f9ff,
        0xcbe4f5,
        0.62,
        0.55,
        -18.0, // gravity pulls spray back down
        false
      );
    }
  }

  public update(dt: number, windVec: THREE.Vector3): void {
    if (dt <= 0) return;

    this.stepPool(
      this.firePool,
      this.firePosArr,
      this.fireColArr,
      this.fireSizeArr,
      this.fireAlphaArr,
      this.firePoints,
      dt,
      windVec
    );
    this.stepPool(
      this.smokePool,
      this.smokePosArr,
      this.smokeColArr,
      this.smokeSizeArr,
      this.smokeAlphaArr,
      this.smokePoints,
      dt,
      windVec
    );

    // Update shockwave ring
    if (this.shockwaveAge >= 0) {
      this.shockwaveAge += dt;
      const dur = 0.85;
      if (this.shockwaveAge >= dur) {
        this.shockwave.visible = false;
        this.shockwaveAge = -1;
      } else {
        const u = this.shockwaveAge / dur;
        const radius = 4 + u * 95;
        this.shockwave.scale.set(radius, radius, 1);
        this.shockwaveMat.opacity = (1 - u) * (1 - u) * 0.85;
      }
    }

    // Update explosion flash light
    if (this.explosionLightAge >= 0) {
      this.explosionLightAge += dt;
      const fade = Math.exp(-this.explosionLightAge * 2.4);
      this.explosionLight.intensity = 24000 * fade;
      if (fade < 0.01) {
        this.explosionLight.intensity = 0;
        this.explosionLightAge = -1;
      }
    }

    // Update tumbling debris
    for (const d of this.debris) {
      if (!d.active) continue;
      d.age += dt;
      if (d.age >= d.life) {
        d.active = false;
        d.mesh.visible = false;
        continue;
      }
      d.vel.y -= 9.81 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.angVel.x * dt;
      d.mesh.rotation.y += d.angVel.y * dt;
      d.mesh.rotation.z += d.angVel.z * dt;

      // Trailing smoke from burning debris early on
      if (d.age < 2.2 && Math.random() < dt * 16) {
        this.spawnFire(
          d.mesh.position,
          new THREE.Vector3((Math.random() - 0.5) * 3, 2, (Math.random() - 0.5) * 3),
          0.35,
          2.2,
          5.5,
          0xffaa44,
          0x441100,
          0.55,
          1.2,
          4.0,
          false
        );
      }

      // Bounce off deck or sink into ocean
      const overBarge = Math.abs(d.mesh.position.x) <= 29 && Math.abs(d.mesh.position.z) <= 43;
      const floorY = overBarge ? ROCKET_SPECS.padDeckY + 0.4 : -5;
      if (overBarge && d.mesh.position.y < floorY) {
        d.mesh.position.y = floorY;
        d.vel.y = -d.vel.y * 0.35;
        d.vel.x *= 0.65;
        d.vel.z *= 0.65;
        d.angVel.multiplyScalar(0.6);
      }
    }
  }

  private stepPool(
    pool: Particle[],
    posArr: Float32Array,
    colArr: Float32Array,
    sizeArr: Float32Array,
    alphaArr: Float32Array,
    points: THREE.Points,
    dt: number,
    windVec: THREE.Vector3
  ): void {
    const n = pool.length;
    for (let i = 0; i < n; i++) {
      const p = pool[i];
      if (!p.active) {
        alphaArr[i] = 0;
        sizeArr[i] = 0;
        continue;
      }
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        alphaArr[i] = 0;
        sizeArr[i] = 0;
        continue;
      }

      // Air drag toward ambient wind + buoyancy
      const dragK = Math.min(1, p.drag * dt);
      p.vel.x += (windVec.x - p.vel.x) * dragK;
      p.vel.z += (windVec.z - p.vel.z) * dragK;
      p.vel.y += (p.buoyancy - p.vel.y * p.drag * 0.5) * dt;

      p.pos.addScaledVector(p.vel, dt);

      // Deflect exhaust radially outward upon striking deck/ocean
      if (p.collideDeck) {
        const overBarge = Math.abs(p.pos.x) <= 30 && Math.abs(p.pos.z) <= 44;
        const surfY = overBarge ? ROCKET_SPECS.padDeckY + 0.35 : 0.35;
        if (p.pos.y < surfY) {
          p.pos.y = surfY;
          const speedDown = Math.abs(p.vel.y);
          p.vel.y = Math.max(0.8, speedDown * 0.08);
          const a = Math.random() * Math.PI * 2;
          p.vel.x += Math.cos(a) * speedDown * 0.45;
          p.vel.z += Math.sin(a) * speedDown * 0.45;
        }
      }

      const u = p.age / p.life;
      posArr[i * 3] = p.pos.x;
      posArr[i * 3 + 1] = p.pos.y;
      posArr[i * 3 + 2] = p.pos.z;

      this._tmpColor.copy(p.colorStart).lerp(p.colorEnd, u);
      colArr[i * 3] = this._tmpColor.r;
      colArr[i * 3 + 1] = this._tmpColor.g;
      colArr[i * 3 + 2] = this._tmpColor.b;

      sizeArr[i] = THREE.MathUtils.lerp(p.sizeStart, p.sizeEnd, u);
      // Smooth fade-in and fade-out envelope
      const env = u < 0.1 ? u / 0.1 : Math.pow(1 - (u - 0.1) / 0.9, 1.35);
      alphaArr[i] = p.alphaStart * env;
    }

    (points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (points.geometry.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (points.geometry.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (points.geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }
}
