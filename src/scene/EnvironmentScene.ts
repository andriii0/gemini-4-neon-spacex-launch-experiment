import * as THREE from 'three';
import { ROCKET_SPECS } from '../scenarios';

export class EnvironmentScene {
  public readonly group = new THREE.Group();
  public readonly sunLight: THREE.DirectionalLight;

  private readonly oceanMat: THREE.ShaderMaterial;
  private readonly beaconLights: THREE.Mesh[] = [];
  private readonly targetReticle: THREE.Group;
  private readonly reticleRingMat: THREE.MeshBasicMaterial;
  private readonly windVanePivot: THREE.Group;
  private readonly sunDir = new THREE.Vector3(0.58, 0.24, -0.78).normalize();

  private elapsedTime = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);

    // Subtle atmospheric horizon fog matching sunset haze
    scene.fog = new THREE.FogExp2(0x2c3c52, 0.00024);

    // 1. Cinematic Golden-Hour Lighting
    const hemi = new THREE.HemisphereLight(0x9bc4f2, 0x1b2d42, 0.85);
    this.group.add(hemi);

    this.sunLight = new THREE.DirectionalLight(0xffd29d, 2.9);
    this.sunLight.position.copy(this.sunDir).multiplyScalar(650);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 250;
    this.sunLight.shadow.camera.far = 1100;
    const d = 95;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0004;
    this.group.add(this.sunLight);
    this.group.add(this.sunLight.target);

    // Cool sky rim light opposite the sun for dramatic metallic sheen on fuselage
    const rimLight = new THREE.DirectionalLight(0x6ea8ff, 0.65);
    rimLight.position.set(-280, 140, 260);
    this.group.add(rimLight);

    // 2. Procedural Atmospheric Sky Dome Shader
    const skyGeo = new THREE.SphereGeometry(5200, 32, 24);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: this.sunDir.clone() }
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldDir = normalize(wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        varying vec3 vWorldDir;
        void main() {
          vec3 dir = normalize(vWorldDir);
          float h = clamp(dir.y, -0.05, 1.0);

          vec3 zenith = vec3(0.05, 0.13, 0.28);
          vec3 midSky = vec3(0.16, 0.31, 0.50);
          vec3 horizon = vec3(0.76, 0.53, 0.39);
          vec3 belowHor = vec3(0.08, 0.15, 0.23);

          vec3 col = mix(horizon, midSky, smoothstep(0.0, 0.26, h));
          col = mix(col, zenith, smoothstep(0.18, 0.82, h));
          if (h < 0.0) {
            col = mix(horizon * 0.65, belowHor, smoothstep(0.0, -0.05, h));
          }

          float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
          // Warm Mie scattering glow around sun
          col += vec3(1.0, 0.62, 0.30) * pow(sunDot, 10.0) * 0.55;
          col += vec3(1.0, 0.85, 0.60) * pow(sunDot, 120.0) * 1.1;
          // Crisp sun disc
          col += vec3(1.0, 0.96, 0.88) * smoothstep(0.99935, 0.99975, sunDot) * 3.0;

          // Subtle high-altitude cirrus bands
          float cloudBand = sin(dir.x * 9.0 + dir.z * 5.0) * sin(dir.z * 14.0 - dir.x * 4.0);
          float cloudMask = smoothstep(0.04, 0.22, h) * (1.0 - smoothstep(0.28, 0.62, h));
          col += vec3(0.95, 0.68, 0.48) * max(0.0, cloudBand) * cloudMask * 0.11;

          gl_FragColor = vec4(col, 1.0);
        }
      `
    });
    const skyDome = new THREE.Mesh(skyGeo, skyMat);
    this.group.add(skyDome);

    // 3. Animated 3D Ocean Surface with GLSL Waves, Fresnel & Specular Sun Path
    const oceanGeo = new THREE.PlaneGeometry(6400, 6400, 128, 128);
    oceanGeo.rotateX(-Math.PI / 2);
    this.oceanMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: this.sunDir.clone() }
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        varying vec3 vWorldPos;
        varying float vWaveH;
        void main() {
          vec3 p = position;
          float w1 = sin(p.x * 0.045 + uTime * 1.15) * 0.42;
          float w2 = cos(p.z * 0.062 - uTime * 0.92 + p.x * 0.02) * 0.34;
          float w3 = sin((p.x - p.z) * 0.11 + uTime * 1.75) * 0.16;
          p.y += w1 + w2 + w3;
          vWaveH = w1 + w2 + w3;
          vec4 wp = modelMatrix * vec4(p, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uSunDir;
        varying vec3 vWorldPos;
        varying float vWaveH;

        void main() {
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 L = normalize(uSunDir);

          // Procedural high-frequency water ripples for normals
          vec2 uv = vWorldPos.xz;
          float nx = cos(uv.x * 0.045 + uTime * 1.15) * 0.08 +
                     cos(uv.x * 0.23 + uv.y * 0.17 + uTime * 2.1) * 0.055 +
                     sin(uv.x * 0.52 - uv.y * 0.41 + uTime * 3.1) * 0.035;
          float nz = -sin(uv.y * 0.062 - uTime * 0.92 + uv.x * 0.02) * 0.08 +
                     sin(uv.y * 0.27 - uv.x * 0.19 - uTime * 1.9) * 0.055 +
                     cos(uv.y * 0.48 + uv.x * 0.37 - uTime * 2.8) * 0.035;
          vec3 N = normalize(vec3(-nx, 1.0, -nz));

          float fresnel = pow(1.0 - max(dot(N, V), 0.0), 4.0);
          vec3 deepWater = vec3(0.02, 0.09, 0.17);
          vec3 shallowTint = vec3(0.04, 0.17, 0.25);
          vec3 skyReflect = vec3(0.32, 0.45, 0.62);

          vec3 col = mix(deepWater, shallowTint, clamp(vWaveH * 0.6 + 0.5, 0.0, 1.0));
          col = mix(col, skyReflect, clamp(fresnel * 0.85, 0.0, 0.85));

          // Golden specular sun path
          vec3 H = normalize(L + V);
          float spec = pow(max(dot(N, H), 0.0), 140.0);
          float broadSpec = pow(max(dot(N, H), 0.0), 16.0);
          col += vec3(1.0, 0.72, 0.40) * broadSpec * 0.22;
          col += vec3(1.0, 0.91, 0.72) * spec * 1.65;

          // Subtle white sea foam wake around the ASDS barge hull (58m x 86m)
          float bx = max(abs(uv.x) - 29.0, 0.0);
          float bz = max(abs(uv.y) - 43.0, 0.0);
          float bargeDist = length(vec2(bx, bz));
          float foamPulse = 0.65 + 0.35 * sin(uTime * 2.4 + uv.x * 0.3 + uv.y * 0.3);
          float foam = (1.0 - smoothstep(0.0, 4.5, bargeDist)) * foamPulse * 0.55;
          col = mix(col, vec3(0.84, 0.90, 0.95), foam);

          // Atmospheric distance fade into horizon
          float dist = length(cameraPosition - vWorldPos);
          float fogFactor = 1.0 - exp(-pow(dist * 0.00032, 2.0));
          vec3 horizonCol = vec3(0.46, 0.42, 0.44);
          col = mix(col, horizonCol, clamp(fogFactor, 0.0, 0.96));

          gl_FragColor = vec4(col, 1.0);
        }
      `
    });
    const ocean = new THREE.Mesh(oceanGeo, this.oceanMat);
    ocean.position.y = 0;
    this.group.add(ocean);

    // 4. Autonomous Spaceport Drone Ship (ASDS) Landing Platform
    this.windVanePivot = new THREE.Group();
    this.buildLandingPlatform();

    // 5. Projected Landing Error Reticle (on deck/water plane)
    this.targetReticle = new THREE.Group();
    this.reticleRingMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const outerRing = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.85, 36), this.reticleRingMat);
    outerRing.rotation.x = -Math.PI / 2;
    this.targetReticle.add(outerRing);

    const innerDot = new THREE.Mesh(new THREE.CircleGeometry(0.65, 16), this.reticleRingMat);
    innerDot.rotation.x = -Math.PI / 2;
    this.targetReticle.add(innerDot);

    // Crosshair ticks
    const tickGeo = new THREE.PlaneGeometry(2.0, 0.32);
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(tickGeo, this.reticleRingMat);
      tick.rotation.x = -Math.PI / 2;
      tick.rotation.z = (i * Math.PI) / 2;
      const a = (i * Math.PI) / 2;
      tick.position.set(Math.cos(a) * 4.8, 0, Math.sin(a) * 4.8);
      this.targetReticle.add(tick);
    }
    this.targetReticle.position.y = ROCKET_SPECS.padDeckY + 0.08;
    this.group.add(this.targetReticle);
  }

  private buildLandingPlatform(): void {
    const bargeGroup = new THREE.Group();
    this.group.add(bargeGroup);

    const deckY = ROCKET_SPECS.padDeckY; // 3.4m
    const widthX = 58;
    const lengthZ = 86;
    const hullH = 5.4;

    // Steel hull body
    const hullMat = new THREE.MeshStandardMaterial({
      color: 0x1b2129,
      roughness: 0.68,
      metalness: 0.55
    });
    const hull = new THREE.Mesh(new THREE.BoxGeometry(widthX, hullH, lengthZ), hullMat);
    hull.position.y = deckY - hullH * 0.5 - 0.05;
    hull.receiveShadow = true;
    hull.castShadow = true;
    bargeGroup.add(hull);

    // Red-oxide waterline anti-fouling stripe around hull
    const waterline = new THREE.Mesh(
      new THREE.BoxGeometry(widthX + 0.25, 1.3, lengthZ + 0.25),
      new THREE.MeshStandardMaterial({ color: 0x7a2323, roughness: 0.72, metalness: 0.2 })
    );
    waterline.position.y = 0.25;
    bargeGroup.add(waterline);

    // Main Landing Deck Surface with custom procedural target/bullseye texture
    const deckTex = this.createDeckTexture();
    const deckMat = new THREE.MeshStandardMaterial({
      map: deckTex,
      roughness: 0.78,
      metalness: 0.28
    });
    const deckPlane = new THREE.Mesh(new THREE.PlaneGeometry(widthX - 0.8, lengthZ - 0.8), deckMat);
    deckPlane.rotation.x = -Math.PI / 2;
    deckPlane.position.y = deckY;
    deckPlane.receiveShadow = true;
    bargeGroup.add(deckPlane);

    // Bow & Stern Equipment Containers & Blast Walls (outside the 27.5m target circle!)
    const containerMat = new THREE.MeshStandardMaterial({
      color: 0x2c3440,
      roughness: 0.55,
      metalness: 0.45
    });
    const accentContainerMat = new THREE.MeshStandardMaterial({
      color: 0xc2491d,
      roughness: 0.6,
      metalness: 0.35
    });

    // North/South end containers (at z = ±37.5m)
    const placements: [number, number, number, number, number, boolean][] = [
      [-18, 38, 12, 3.4, 4.5, false],
      [0, 39, 14, 3.8, 4.0, true],
      [18, 38, 12, 3.4, 4.5, false],
      [-17, -38.5, 13, 3.4, 4.5, false],
      [17, -38.5, 13, 3.4, 4.5, true]
    ];
    for (const [px, pz, sx, sy, sz, isAccent] of placements) {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(sx, sy, sz),
        isAccent ? accentContainerMat : containerMat
      );
      box.position.set(px, deckY + sy * 0.5, pz);
      box.castShadow = true;
      box.receiveShadow = true;
      bargeGroup.add(box);
    }

    // 4 Corner Light & Thruster Masts with Blinking Red Aviation Beacons
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x464e59, roughness: 0.4, metalness: 0.75 });
    const beaconGeo = new THREE.SphereGeometry(0.42, 12, 12);
    const corners: [number, number][] = [
      [-26.5, -40.5],
      [26.5, -40.5],
      [-26.5, 40.5],
      [26.5, 40.5]
    ];
    for (const [cx, cz] of corners) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 7.5, 10), mastMat);
      mast.position.set(cx, deckY + 3.75, cz);
      mast.castShadow = true;
      bargeGroup.add(mast);

      const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff2b2b });
      const beacon = new THREE.Mesh(beaconGeo, beaconMat);
      beacon.position.set(cx, deckY + 7.7, cz);
      bargeGroup.add(beacon);
      this.beaconLights.push(beacon);
    }

    // Subtle perimeter deck LED strip markers
    const ledMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24 });
    for (let z = -34; z <= 34; z += 8.5) {
      for (const x of [-28.2, 28.2]) {
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.25, 0.85), ledMat);
        led.position.set(x, deckY + 0.14, z);
        bargeGroup.add(led);
      }
    }

    // Wind direction indicator vane mounted on northeast mast
    this.windVanePivot.position.set(26.5, deckY + 6.4, -40.5);
    const arrowShaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 4.2, 8),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
    );
    arrowShaft.rotation.z = -Math.PI / 2;
    arrowShaft.position.x = 1.6;
    this.windVanePivot.add(arrowShaft);

    const arrowCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 1.3, 10),
      new THREE.MeshBasicMaterial({ color: 0xff6a1a })
    );
    arrowCone.rotation.z = -Math.PI / 2;
    arrowCone.position.x = 3.9;
    this.windVanePivot.add(arrowCone);
    bargeGroup.add(this.windVanePivot);
  }

  private createDeckTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1536;
    const ctx = canvas.getContext('2d')!;

    // Dark weathered marine steel deck base
    ctx.fillStyle = '#242931';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Subtle deck plating grid
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 2;
    for (let x = 0; x < canvas.width; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Center exhaust scorch discoloration from previous booster landings
    const cx = canvas.width * 0.5;
    const cy = canvas.height * 0.5;
    const scorch = ctx.createRadialGradient(cx, cy, 20, cx, cy, 360);
    scorch.addColorStop(0, 'rgba(10, 10, 12, 0.72)');
    scorch.addColorStop(0.5, 'rgba(22, 22, 26, 0.35)');
    scorch.addColorStop(1, 'rgba(22, 22, 26, 0)');
    ctx.fillStyle = scorch;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Yellow perimeter safety border
    ctx.strokeStyle = '#eab308';
    ctx.lineWidth = 18;
    ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);

    // Outer dashed landing zone circle (radius ~24m)
    const pxPerMeter = canvas.width / 57.2;
    const outerR = 23.5 * pxPerMeter;
    const innerR = 11.5 * pxPerMeter;

    ctx.strokeStyle = 'rgba(241, 245, 249, 0.88)';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.stroke();

    // Inner amber ring
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.75)';
    ctx.lineWidth = 7;
    ctx.setLineDash([28, 18]);
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Bold stylized SpaceX-inspired "X" bullseye
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 28;
    ctx.lineCap = 'square';
    const arm = 128;
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy - arm);
    ctx.lineTo(cx + arm, cy + arm);
    ctx.moveTo(cx + arm, cy - arm);
    ctx.lineTo(cx - arm, cy + arm);
    ctx.stroke();

    // Crisp deck stencil lettering
    ctx.fillStyle = 'rgba(226, 232, 240, 0.65)';
    ctx.font = 'bold 46px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('ASDS-01  •  AUTONOMOUS LANDING ZONE', cx, 130);
    ctx.fillText('VALKYRIE RECOVERY PLATFORM', cx, canvas.height - 96);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  public update(
    dt: number,
    estX: number,
    estZ: number,
    estErr: number,
    windX: number,
    windZ: number,
    showReticle: boolean
  ): void {
    this.elapsedTime += dt;
    this.oceanMat.uniforms.uTime.value = this.elapsedTime;

    // Pulse red corner aviation beacons
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsedTime * 4.5);
    for (let i = 0; i < this.beaconLights.length; i++) {
      const m = this.beaconLights[i].material as THREE.MeshBasicMaterial;
      const intensity = pulse > 0.65 ? 1.0 : 0.25;
      m.color.setRGB(intensity, 0.08 * intensity, 0.08 * intensity);
    }

    // Update wind vane direction
    if (Math.hypot(windX, windZ) > 0.2) {
      this.windVanePivot.rotation.y = -Math.atan2(windZ, windX);
    }

    // Update projected landing reticle
    this.targetReticle.visible = showReticle;
    if (showReticle) {
      const overBarge = Math.abs(estX) <= 29 && Math.abs(estZ) <= 43;
      this.targetReticle.position.set(estX, overBarge ? ROCKET_SPECS.padDeckY + 0.1 : 0.35, estZ);
      this.targetReticle.rotation.y = this.elapsedTime * 0.8;

      if (estErr <= 10) {
        this.reticleRingMat.color.setHex(0x22c55e); // green bullseye
      } else if (estErr <= 24) {
        this.reticleRingMat.color.setHex(0x38bdf8); // cyan on-pad
      } else {
        this.reticleRingMat.color.setHex(0xf97316); // orange off-target warning
      }
    }
  }
}
