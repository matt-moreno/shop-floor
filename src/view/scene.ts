import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Program, Vec3 } from "../sim/gcode";
import type { Machine } from "../sim/machine";
import { TOLERANCE } from "../sim/score";
import type { Heightmap } from "../sim/stock";
import type { Tool } from "../sim/tools";

const PARALLEL_HEIGHT = 5;
const RAW = new THREE.Color("#7c838a");
const MACHINED = new THREE.Color("#c4ccd4");
const OK = new THREE.Color("#5fbf7a");
const LEFT = new THREE.Color("#4f8fe0");
const GOUGE = new THREE.Color("#e0524f");

export type ViewPreset = "iso" | "top" | "front";

/**
 * Plain three.js scene, kept outside React so the render loop never waits
 * on React. Work coordinates map to three as (x, z, -y), centered on the stock.
 */
export class SceneView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 1, 6000);
  private controls: OrbitControls;
  private stockGroup = new THREE.Group();
  private top!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private walls!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private toolGroup = new THREE.Group();
  private flutes = new THREE.Group();
  private pathGroup = new THREE.Group();
  private chips: Chips;
  private stock: Heightmap | null = null;
  private target: Heightmap | null = null;
  private drawnVersion = -1;
  private toolKey = "";
  private raf = 0;
  private last = 0;
  private resizeObserver: ResizeObserver;
  compareMode = false;
  showPath = true;

  constructor(
    private host: HTMLElement,
    private machine: Machine,
    private onFrame: (dt: number) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    host.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(
      new RoomEnvironment(),
      0.04,
    ).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.background = new THREE.Color("#15191d");
    this.scene.fog = new THREE.Fog("#15191d", 900, 2400);

    this.scene.add(new THREE.HemisphereLight("#dfe8f0", "#20252a", 0.35));
    const sun = new THREE.DirectionalLight("#ffffff", 1.3);
    sun.position.set(180, 320, 220);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -200;
    sc.right = sc.top = 200;
    sc.far = 1000;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;

    this.scene.add(this.stockGroup, this.toolGroup, this.pathGroup);
    this.chips = new Chips();
    this.scene.add(this.chips.points);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.setStock(machine.stock, null);
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  setMachine(machine: Machine, target: Heightmap | null) {
    this.machine = machine;
    this.setStock(machine.stock, target);
  }

  /** Map work coordinates to scene coordinates. */
  private w(p: Vec3, out = new THREE.Vector3()) {
    const s = this.stock!.spec;
    return out.set(p.x - s.width / 2, p.z, -(p.y - s.depth / 2));
  }

  private setStock(stock: Heightmap, target: Heightmap | null) {
    this.stock = stock;
    this.target = target;
    this.stockGroup.clear();
    const { width: W, depth: D, height: H } = stock.spec;
    const { nx, ny } = stock;

    // Top surface: one vertex per cell, edges stretched to the stock bounds.
    const top = new THREE.BufferGeometry();
    const pos = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = (j * nx + i) * 3;
        const x = i === 0 ? 0 : i === nx - 1 ? W : stock.cx(i);
        const y = j === 0 ? 0 : j === ny - 1 ? D : stock.cy(j);
        pos[k] = x - W / 2;
        pos[k + 2] = -(y - D / 2);
      }
    const index: number[] = [];
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i,
          b = a + 1,
          c = a + nx,
          d = c + 1;
        index.push(a, b, c, b, d, c);
      }
    top.setIndex(index);
    top.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    top.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3),
    );
    top.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3),
    );
    top.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.75,
      roughness: 0.32,
    });
    this.top = new THREE.Mesh(top, mat);
    this.top.castShadow = this.top.receiveShadow = true;

    // Side walls follow the border cells so cuts through the edge show.
    const perimeter = 2 * (nx + ny);
    const walls = new THREE.BufferGeometry();
    walls.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(perimeter * 2 * 3), 3),
    );
    walls.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(perimeter * 2 * 3), 3),
    );
    const widx: number[] = [];
    let base = 0;
    for (const n of [nx, ny, nx, ny]) {
      for (let k = 0; k < n - 1; k++) {
        const a = base + k * 2;
        widx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      base += n * 2;
    }
    walls.setIndex(widx);
    this.walls = new THREE.Mesh(
      walls,
      new THREE.MeshStandardMaterial({
        color: RAW,
        metalness: 0.7,
        roughness: 0.45,
        side: THREE.DoubleSide,
      }),
    );
    this.walls.castShadow = this.walls.receiveShadow = true;

    const bottom = new THREE.Mesh(
      new THREE.PlaneGeometry(W, D).rotateX(Math.PI / 2).translate(0, -H, 0),
      this.walls.material,
    );
    this.stockGroup.add(this.top, this.walls, bottom, ...fixtures(W, D, H));
    this.drawnVersion = -1;
    this.fitCamera("iso");
  }

  fitCamera(preset: ViewPreset) {
    const s = this.stock!.spec;
    const size = Math.max(s.width, s.depth, 60);
    const t = new THREE.Vector3(0, -s.height / 2, 0);
    const dist = size * 3.2;
    const dir =
      preset === "top"
        ? new THREE.Vector3(0, 1, 0.001)
        : preset === "front"
          ? new THREE.Vector3(0, 0.12, 1)
          : new THREE.Vector3(0.75, 0.85, 1.05);
    this.camera.position.copy(t).addScaledVector(dir.normalize(), dist);
    this.controls.target.copy(t);
    this.controls.update();
  }

  setProgram(program: Program) {
    this.pathGroup.clear();
    if (!this.stock) return;
    const feed: number[] = [];
    const rapid: number[] = [];
    const v = new THREE.Vector3();
    for (const op of program.ops) {
      if (op.kind !== "move") continue;
      const arr = op.rapid ? rapid : feed;
      this.w(op.from, v);
      arr.push(v.x, v.y, v.z);
      this.w(op.to, v);
      arr.push(v.x, v.y, v.z);
    }
    const make = (
      arr: number[],
      mat: THREE.LineBasicMaterial | THREE.LineDashedMaterial,
    ) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      const l = new THREE.LineSegments(g, mat);
      l.computeLineDistances();
      l.renderOrder = 2;
      return l;
    };
    this.pathGroup.add(
      make(
        feed,
        new THREE.LineBasicMaterial({
          color: "#38d6e8",
          transparent: true,
          opacity: 0.9,
          depthTest: false,
        }),
      ),
      make(
        rapid,
        new THREE.LineDashedMaterial({
          color: "#f0a53a",
          dashSize: 3,
          gapSize: 2,
          transparent: true,
          opacity: 0.8,
          depthTest: false,
        }),
      ),
    );
  }

  redrawColors() {
    this.drawnVersion = -1;
    this.stock?.markAllDirty();
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    this.onFrame(dt);
    this.syncStock();
    this.syncTool(dt);
    this.pathGroup.visible = this.showPath;
    this.chips.update(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private syncStock() {
    const stock = this.stock!;
    if (stock.version === this.drawnVersion || !stock.dirty) return;
    const { nx, ny, heights, spec } = stock;
    const r = stock.dirty;
    stock.dirty = null;
    this.drawnVersion = stock.version;
    const i0 = Math.max(0, r.i0 - 1),
      i1 = Math.min(nx - 1, r.i1 + 1);
    const j0 = Math.max(0, r.j0 - 1),
      j1 = Math.min(ny - 1, r.j1 + 1);
    const g = this.top.geometry;
    const pos = g.attributes.position.array as Float32Array;
    const nrm = g.attributes.normal.array as Float32Array;
    const col = g.attributes.color.array as Float32Array;
    const sx = spec.width / nx,
      sy = spec.depth / ny;
    const h = (i: number, j: number) =>
      heights[
        Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))
      ];
    const target = this.compareMode ? this.target : null;
    const c = new THREE.Color();
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        const z = heights[k];
        pos[k * 3 + 1] = z;
        const hx = (h(i + 1, j) - h(i - 1, j)) / (2 * sx);
        const hy = (h(i, j + 1) - h(i, j - 1)) / (2 * sy);
        const len = Math.hypot(hx, 1, hy);
        nrm[k * 3] = -hx / len;
        nrm[k * 3 + 1] = 1 / len;
        nrm[k * 3 + 2] = hy / len;
        if (target) {
          const d = z - target.heights[k];
          c.copy(
            d > TOLERANCE
              ? LEFT
              : d < -TOLERANCE
                ? GOUGE
                : z < -TOLERANCE
                  ? OK
                  : RAW,
          );
        } else c.copy(z < -0.01 ? MACHINED : RAW);
        col[k * 3] = c.r;
        col[k * 3 + 1] = c.g;
        col[k * 3 + 2] = c.b;
      }
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    this.updateWalls();
  }

  private updateWalls() {
    const stock = this.stock!;
    const { nx, ny, spec } = stock;
    const { width: W, depth: D, height: H } = spec;
    const g = this.walls.geometry;
    const pos = g.attributes.position.array as Float32Array;
    const nrm = g.attributes.normal.array as Float32Array;
    let v = 0;
    const put = (
      x: number,
      y: number,
      z: number,
      n: [number, number, number],
    ) => {
      pos[v * 3] = x - W / 2;
      pos[v * 3 + 1] = z;
      pos[v * 3 + 2] = -(y - D / 2);
      nrm.set(n, v * 3);
      v++;
    };
    const edgeX = (i: number) => (i === 0 ? 0 : i === nx - 1 ? W : stock.cx(i));
    const edgeY = (j: number) => (j === 0 ? 0 : j === ny - 1 ? D : stock.cy(j));
    for (let i = 0; i < nx; i++) {
      put(edgeX(i), 0, stock.at(i, 0), [0, 0, 1]);
      put(edgeX(i), 0, -H, [0, 0, 1]);
    }
    for (let j = 0; j < ny; j++) {
      put(W, edgeY(j), stock.at(nx - 1, j), [1, 0, 0]);
      put(W, edgeY(j), -H, [1, 0, 0]);
    }
    for (let i = nx - 1; i >= 0; i--) {
      put(edgeX(i), D, stock.at(i, ny - 1), [0, 0, -1]);
      put(edgeX(i), D, -H, [0, 0, -1]);
    }
    for (let j = ny - 1; j >= 0; j--) {
      put(0, edgeY(j), stock.at(0, j), [-1, 0, 0]);
      put(0, edgeY(j), -H, [-1, 0, 0]);
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.computeBoundingSphere();
  }

  private syncTool(dt: number) {
    const m = this.machine;
    const key = m.tool ? String(m.tool.number) : "none";
    if (key !== this.toolKey) {
      this.toolKey = key;
      this.toolGroup.clear();
      this.flutes = new THREE.Group();
      buildTool(this.toolGroup, this.flutes, m.tool);
    }
    this.w(m.pos, this.toolGroup.position);
    // Visual spin only; capped so it reads as rotation, not a blur.
    this.flutes.rotation.y -= dt * Math.min(m.rpm, 1800) * 0.05;
    if (m.lastRemoved > 0 && m.tool) {
      const n = Math.min(12, Math.ceil(m.lastRemoved / 4));
      this.chips.emit(this.toolGroup.position, m.tool.diameter / 2, n);
    }
  }
}

function fixtures(W: number, D: number, H: number) {
  const steel = new THREE.MeshStandardMaterial({
    color: "#5a6168",
    metalness: 0.8,
    roughness: 0.4,
  });
  const tableMat = new THREE.MeshStandardMaterial({
    color: "#2b3036",
    metalness: 0.6,
    roughness: 0.6,
  });
  const out: THREE.Object3D[] = [];
  for (const y of [D * 0.18, D * 0.82]) {
    const p = new THREE.Mesh(
      new THREE.BoxGeometry(W + 20, PARALLEL_HEIGHT, 6),
      steel,
    );
    p.position.set(0, -H - PARALLEL_HEIGHT / 2, -(y - D / 2));
    p.castShadow = p.receiveShadow = true;
    out.push(p);
  }
  const tw = Math.max(W, D) * 4 + 300;
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(tw, 40, tw * 0.55),
    tableMat,
  );
  table.position.y = -H - PARALLEL_HEIGHT - 20;
  table.receiveShadow = true;
  out.push(table);
  const slotMat = new THREE.MeshStandardMaterial({
    color: "#16191c",
    roughness: 0.9,
  });
  for (let k = -3; k <= 3; k++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(tw, 0.4, 14), slotMat);
    s.position.set(0, -H - PARALLEL_HEIGHT + 0.01, k * 50);
    out.push(s);
  }
  return out;
}

function flutesTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = "#6d6f73";
  g.lineWidth = 9;
  for (let k = -64; k < 128; k += 32) {
    g.beginPath();
    g.moveTo(k, 64);
    g.lineTo(k + 64, 0);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const FLUTE_TEX = typeof document !== "undefined" ? flutesTexture() : null;

function buildTool(group: THREE.Group, flutes: THREE.Group, tool: Tool | null) {
  const dark = new THREE.MeshStandardMaterial({
    color: "#2d3237",
    metalness: 0.7,
    roughness: 0.35,
  });
  const holderMat = new THREE.MeshStandardMaterial({
    color: "#8c939a",
    metalness: 0.9,
    roughness: 0.25,
  });
  let y = 0;
  if (tool) {
    const r = tool.diameter / 2;
    const tex = FLUTE_TEX!.clone();
    tex.repeat.set(tool.flutes, tool.fluteLength / (tool.diameter * 1.2));
    tex.needsUpdate = true;
    const cutMat = new THREE.MeshStandardMaterial({
      color: tool.color,
      metalness: 0.85,
      roughness: 0.3,
      map: tex,
    });
    if (tool.tip === "ball") {
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(
          r,
          24,
          12,
          0,
          Math.PI * 2,
          Math.PI / 2,
          Math.PI / 2,
        ),
        cutMat,
      );
      cap.position.y = r;
      flutes.add(cap);
      y = r;
    } else if (tool.tip === "drill") {
      const h = r * 0.6009;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(r, h, 24).rotateX(Math.PI),
        cutMat,
      );
      cone.position.y = h / 2;
      flutes.add(cone);
      y = h;
    }
    const fl = Math.max(0.1, tool.fluteLength - y);
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, fl, 28),
      cutMat,
    );
    body.position.y = y + fl / 2;
    flutes.add(body);
    y = tool.fluteLength;
    const shankLen = tool.diameter > 30 ? 8 : 18;
    const shankR = tool.diameter > 30 ? 11 : r;
    const shank = new THREE.Mesh(
      new THREE.CylinderGeometry(shankR, shankR, shankLen, 24),
      holderMat,
    );
    shank.position.y = y + shankLen / 2;
    flutes.add(shank);
    y += shankLen;
    group.add(flutes);
    for (const m of flutes.children) m.castShadow = true;
  }
  const holderR = Math.max(16, (tool?.diameter ?? 0) * 0.6);
  const holder = new THREE.Mesh(
    new THREE.CylinderGeometry(holderR, holderR * 0.8, 30, 32),
    holderMat,
  );
  holder.position.y = y + 15;
  const flange = new THREE.Mesh(
    new THREE.CylinderGeometry(26, 26, 10, 32),
    dark,
  );
  flange.position.y = y + 35;
  const nose = new THREE.Mesh(
    new THREE.CylinderGeometry(34, 34, 400, 40),
    dark,
  );
  nose.position.y = y + 40 + 200;
  for (const m of [holder, flange, nose]) {
    m.castShadow = true;
    group.add(m);
  }
}

class Chips {
  private n = 400;
  private pos = new Float32Array(this.n * 3);
  private vel = new Float32Array(this.n * 3);
  private life = new Float32Array(this.n);
  private next = 0;
  points: THREE.Points;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.points = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: "#e6eaee",
        size: 1.4,
        sizeAttenuation: true,
      }),
    );
    this.points.frustumCulled = false;
    this.pos.fill(-1e5);
  }

  emit(at: THREE.Vector3, radius: number, count: number) {
    for (let k = 0; k < count; k++) {
      const i = this.next++ % this.n;
      const a = Math.random() * Math.PI * 2;
      this.pos.set(
        [at.x + Math.cos(a) * radius, at.y + 0.5, at.z + Math.sin(a) * radius],
        i * 3,
      );
      const s = 40 + Math.random() * 60;
      this.vel.set(
        [Math.cos(a + 1.3) * s, 30 + Math.random() * 50, Math.sin(a + 1.3) * s],
        i * 3,
      );
      this.life[i] = 0.6 + Math.random() * 0.6;
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const k = i * 3;
      this.vel[k + 1] -= 400 * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.life[i] <= 0) this.pos[k + 1] = -1e5;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}
