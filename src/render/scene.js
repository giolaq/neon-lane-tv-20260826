import {
  ACESFilmicToneMapping,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";

const LANE_X = Object.freeze({
  LEFT: -3.8,
  CENTER: 0,
  RIGHT: 3.8,
});
const TRACK_CENTER_Z = -8;
const TRACK_LENGTH = 68;
const GATE_START_Z = -24;
const GATE_TRAVEL = 3.6;

function craftGeometry() {
  const outline = [
    [0, -1.75],
    [0.48, -0.35],
    [1.55, 0.8],
    [0.48, 0.58],
    [0, 0.95],
    [-0.48, 0.58],
    [-1.55, 0.8],
    [-0.48, -0.35],
  ];
  const top = 0.42;
  const bottom = 0;
  const positions = [];

  for (let index = 0; index < outline.length; index += 1) {
    const next = (index + 1) % outline.length;
    positions.push(
      0, top + 0.16, 0,
      outline[index][0], top, outline[index][1],
      outline[next][0], top, outline[next][1],
      0, bottom, 0,
      outline[next][0], bottom, outline[next][1],
      outline[index][0], bottom, outline[index][1],
      outline[index][0], bottom, outline[index][1],
      outline[next][0], bottom, outline[next][1],
      outline[next][0], top, outline[next][1],
      outline[index][0], bottom, outline[index][1],
      outline[next][0], top, outline[next][1],
      outline[index][0], top, outline[index][1],
    );
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.computeVertexNormals();
  return geometry;
}

function addTrack(scene) {
  const laneGeometry = new BoxGeometry(3.5, 0.16, TRACK_LENGTH);
  const laneMaterials = [
    new MeshStandardMaterial({
      color: 0x111820,
      roughness: 0.84,
      metalness: 0.22,
    }),
    new MeshStandardMaterial({
      color: 0x151d25,
      roughness: 0.8,
      metalness: 0.24,
    }),
  ];

  Object.values(LANE_X).forEach((x, index) => {
    const lane = new Mesh(laneGeometry, laneMaterials[index % 2]);
    lane.position.set(x, -0.12, TRACK_CENTER_Z);
    scene.add(lane);
  });

  const markerMaterial = new MeshStandardMaterial({
    color: 0xb9c2c7,
    emissive: 0x30383d,
    emissiveIntensity: 0.45,
    roughness: 0.42,
  });
  const markerGeometry = new BoxGeometry(0.07, 0.035, 2.25);

  for (const x of [-5.7, -1.9, 1.9, 5.7]) {
    for (let z = -39; z <= 17; z += 4.2) {
      const marker = new Mesh(markerGeometry, markerMaterial);
      marker.position.set(x, 0, z);
      scene.add(marker);
    }
  }

  const horizonGeometry = new BoxGeometry(11.4, 0.08, 0.18);
  const horizonMaterial = new MeshStandardMaterial({
    color: 0x56636b,
    emissive: 0x20272b,
    emissiveIntensity: 0.35,
    roughness: 0.55,
  });
  for (let z = -38; z <= 10; z += 6) {
    const crossMarker = new Mesh(horizonGeometry, horizonMaterial);
    crossMarker.position.set(0, -0.01, z);
    scene.add(crossMarker);
  }
}

function createCraft() {
  const craft = new Group();
  const hull = new Mesh(
    craftGeometry(),
    new MeshStandardMaterial({
      color: 0x20e5ff,
      emissive: 0x008ca8,
      emissiveIntensity: 1.25,
      metalness: 0.52,
      roughness: 0.28,
      flatShading: true,
    }),
  );
  const canopy = new Mesh(
    new SphereGeometry(0.38, 16, 8),
    new MeshStandardMaterial({
      color: 0xb8f8ff,
      emissive: 0x006d80,
      emissiveIntensity: 0.75,
      metalness: 0.65,
      roughness: 0.2,
    }),
  );
  canopy.scale.set(0.72, 0.52, 1.15);
  canopy.position.set(0, 0.59, 0.04);
  craft.add(hull, canopy);
  craft.position.set(0, 0.24, -1.45);
  return craft;
}

function gateColor(id) {
  return id % 2 === 0 ? 0xff2ca8 : 0xffb000;
}

function createGate(id) {
  const group = new Group();
  const color = gateColor(id);
  const material = new MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 1.35,
    metalness: 0.34,
    roughness: 0.32,
  });
  const pillarGeometry = new BoxGeometry(0.23, 3.15, 0.28);
  const topGeometry = new BoxGeometry(3.15, 0.25, 0.28);
  const braceGeometry = new BoxGeometry(3.1, 0.13, 0.24);

  for (const x of [-1.45, 1.45]) {
    const pillar = new Mesh(pillarGeometry, material);
    pillar.position.set(x, 1.58, 0);
    group.add(pillar);
  }

  const top = new Mesh(topGeometry, material);
  top.position.set(0, 3.08, 0);
  group.add(top);

  for (const rotation of [-0.72, 0.72]) {
    const brace = new Mesh(braceGeometry, material);
    brace.position.set(0, 1.48, 0);
    brace.rotation.z = rotation;
    group.add(brace);
  }
  return group;
}

function disposeGate(gate) {
  const geometries = new Set();
  const materials = new Set();

  gate.traverse((object) => {
    if (object.geometry) {
      geometries.add(object.geometry);
    }
    const objectMaterials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of objectMaterials) {
      if (material) {
        materials.add(material);
      }
    }
  });

  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

function obstacleWorldZ(progress) {
  return GATE_START_Z + progress * GATE_TRAVEL;
}

export function createScene(container = document.body) {
  if (!container || typeof container.append !== "function") {
    throw new TypeError("container must be an element");
  }

  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x03060a, 1);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.domElement.className = "game-canvas";
  renderer.domElement.setAttribute("aria-label", "Neon Lane three-lane track");

  const scene = new Scene();
  scene.background = new Color(0x03060a);
  scene.fog = new Fog(0x03060a, 33, 72);

  const camera = new PerspectiveCamera(52, 1, 0.1, 90);
  camera.position.set(0, 8.5, 14);
  camera.lookAt(0, 0.35, -10);

  const hemisphere = new HemisphereLight(0xbfeaff, 0x11131a, 2.15);
  const keyLight = new DirectionalLight(0xffffff, 2.8);
  keyLight.position.set(-5, 13, 8);
  scene.add(hemisphere, keyLight);

  addTrack(scene);
  const craft = createCraft();
  const obstacleLayer = new Group();
  scene.add(craft, obstacleLayer);
  container.append(renderer.domElement);

  return {
    renderer,
    scene,
    camera,
    craft,
    obstacleLayer,
    gates: new Map(),
    viewport: { width: 0, height: 0 },
  };
}

export function renderScene(view, snapshot) {
  if (!view || !snapshot) {
    throw new TypeError("scene view and snapshot are required");
  }

  view.craft.position.x = LANE_X[snapshot.playerLane];
  const visibleIds = new Set();

  for (const obstacle of snapshot.obstacles) {
    visibleIds.add(obstacle.id);
    let gate = view.gates.get(obstacle.id);
    if (!gate) {
      gate = createGate(obstacle.id);
      view.gates.set(obstacle.id, gate);
      view.obstacleLayer.add(gate);
    }
    gate.position.set(
      LANE_X[obstacle.blockedLane],
      0,
      obstacleWorldZ(obstacle.z),
    );
  }

  for (const [id, gate] of view.gates) {
    if (!visibleIds.has(id)) {
      view.obstacleLayer.remove(gate);
      disposeGate(gate);
      view.gates.delete(id);
    }
  }

  view.renderer.render(view.scene, view.camera);
}

export function resizeScene(view, width, height) {
  if (!view || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new TypeError("scene view and finite dimensions are required");
  }

  const nextWidth = Math.max(1, Math.floor(width));
  const nextHeight = Math.max(1, Math.floor(height));
  view.viewport.width = nextWidth;
  view.viewport.height = nextHeight;
  view.camera.aspect = nextWidth / nextHeight;
  view.camera.updateProjectionMatrix();
  view.renderer.setSize(nextWidth, nextHeight, false);
  return Object.freeze({ width: nextWidth, height: nextHeight });
}
