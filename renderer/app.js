// Renderer: draws the avatar, records the mic, shows the speech bubble,
// and plays the voice with lip-sync. All API work happens in main.js.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const api = window.companion;
const $ = (id) => document.getElementById(id);
const bubble = $("bubble");
const bubbleText = $("bubble-text");
const statusEl = $("status");

// ---------- scene ----------

const canvas = $("stage");
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, canvas.clientWidth / canvas.clientHeight, 0.1, 20);
// Framing is derived from the loaded model's size, so a 30 cm mascot and a
// 1.6 m character both fit. zoom: 0 = whole body, 1 = face close-up.
const frame = { bodyY: 0.85, faceY: 1.4, fullDist: 3.2, faceDist: 1.0 };
let zoom = 0;
let camLie = 0; // 0..1, how far the model is lying down (set by the pose code)
const camTarget = new THREE.Vector3();

// Keep the speech bubble sitting just above the top of the head (ears
// included), wherever the character is: standing, hopping or lying down.
let headTopOffset = 0.3; // from the head bone up to the top of the model, in model heights
const headTop = new THREE.Vector3();
function pinBubbleToHead() {
  const head = vrm.humanoid.getNormalizedBoneNode("head");
  if (!head) return;
  head.getWorldPosition(headTop);
  headTop.y += headTopOffset * modelHeight * (1 - camLie);
  headTop.project(camera);
  const yInCanvas = (1 - (headTop.y + 1) / 2) * canvas.clientHeight;
  const fromBottom = canvas.clientHeight - yInCanvas + 12;
  const max = window.innerHeight - 80; // always leave room for a line or two
  document.documentElement.style.setProperty("--bubble-bottom", `${Math.min(fromBottom, max)}px`);
}

function placeCamera() {
  const dist = THREE.MathUtils.lerp(frame.fullDist, frame.faceDist, zoom) * (1 + 0.6 * camLie);
  camTarget.set(0, THREE.MathUtils.lerp(frame.bodyY, frame.faceY, zoom) * (1 - 0.55 * camLie), 0);
  // Sit the camera near eye level and aim down at the body, like looking at
  // a figure on your desk. From below, faces read as always looking up.
  const eyeY = THREE.MathUtils.lerp(camTarget.y, frame.faceY, 0.8);
  camera.position.set(0, eyeY, dist);
  camera.near = dist / 50;
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  camera.lookAt(camTarget);
}
placeCamera();

scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(1, 2, 3);
scene.add(key);

// Scroll to zoom between full body and a close-up of the face.
window.addEventListener("wheel", (e) => {
  zoom = THREE.MathUtils.clamp(zoom - e.deltaY * 0.001, 0, 1);
  placeCamera();
});

// ---------- avatar ----------

let vrm = null;
let facing = 1; // -1 for VRM0 models
let headTilt = 0; // resting nod in radians, + is down (character.json)
let speechMode = "english"; // or "pika": voice says Pikachu sounds, bubble shows English
const lookTarget = new THREE.Object3D();
scene.add(lookTarget);

async function loadVrm(bytes) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await loader.parseAsync(buffer, "");
  const next = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(next); // older VRM0 models face the other way

  if (vrm) {
    scene.remove(vrm.scene);
    VRMUtils.deepDispose(vrm.scene);
  }
  vrm = next;
  facing = vrm.meta?.metaVersion === "0" ? -1 : 1;
  scene.add(vrm.scene);
  if (vrm.lookAt) vrm.lookAt.target = lookTarget;

  // Rest the arms at the sides whatever pose the model was built in (T-pose,
  // A-pose, or a mascot with paws up). Normalized bones start world-aligned,
  // so a rotation between two directions in the model's space can be applied directly.
  lowerArms();
  findEarsAndTail();

  // Fit the whole model in view (leaving room for the toolbar and bubble),
  // and remember where the face is for the zoomed-in shot.
  vrm.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const size = box.getSize(new THREE.Vector3());
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const fitHeight = Math.max(size.y, size.x / camera.aspect) * 1.25;
  const head = vrm.humanoid.getNormalizedBoneNode("head");
  const headY = head ? head.getWorldPosition(new THREE.Vector3()).y : box.max.y - size.y * 0.15;
  frame.bodyY = box.min.y + size.y * 0.55;
  frame.faceY = headY;
  frame.fullDist = fitHeight / 2 / Math.tan(halfFov);
  frame.faceDist = frame.fullDist * 0.4;
  modelHeight = size.y;
  headTopOffset = (box.max.y - headY) / size.y;
  baseYaw = vrm.scene.rotation.y;
  hipsRest = vrm.humanoid.getNormalizedBoneNode("hips")?.position.clone() ?? null;
  const hipsNode = vrm.humanoid.getNormalizedBoneNode("hips");
  const footNode = vrm.humanoid.getNormalizedBoneNode("leftFoot");
  if (hipsNode && footNode) {
    legFrac = (hipsNode.getWorldPosition(new THREE.Vector3()).y - footNode.getWorldPosition(new THREE.Vector3()).y) / size.y;
  }
  action = null;
  zoom = 0;
  placeCamera();

  $("drop-hint").classList.add("hidden");
}

function lowerArms() {
  const h = vrm.humanoid;
  const inModel = (node) => vrm.scene.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
  for (const side of ["left", "right"]) {
    const upper = h.getNormalizedBoneNode(`${side}UpperArm`);
    const lower = h.getNormalizedBoneNode(`${side}LowerArm`);
    const hand = h.getNormalizedBoneNode(`${side}Hand`);
    if (!upper || !lower) continue;
    // Measure both segments before rotating anything.
    const upperDir = inModel(lower).sub(inModel(upper)).normalize();
    const lowerDir = hand ? inModel(hand).sub(inModel(lower)).normalize() : null;
    const out = Math.sign(upperDir.x) || (side === "left" ? 1 : -1);
    const down = new THREE.Vector3(out * 0.3, -1, 0.1).normalize();
    upper.quaternion.setFromUnitVectors(upperDir, down);
    armRest[side] = { rest: upper.quaternion.clone(), out };
    if (lowerDir) {
      // Mostly straighten the elbow so the forearm hangs with the upper arm.
      const straight = new THREE.Quaternion().setFromUnitVectors(lowerDir, upperDir);
      lower.quaternion.identity().slerp(straight, 0.8);
    }
  }
}

// ---------- ears and tail (only for models that have them) ----------

// Each entry: an ear bone plus rotation axes in its parent's space. Found by bone name, so any model with bones
// named like "...Ear1" under the head or "...Tail1" gets them.
let ears = [];
let tail = null;
const earState = { twitchSide: -1, twitchT: -1, nextTwitch: 3, perk: 0 };

function findEarsAndTail() {
  ears = [];
  tail = null;
  const head = vrm.humanoid.getRawBoneNode("head");
  if (!head) return;
  vrm.scene.updateMatrixWorld(true);
  const headInv = head.getWorldQuaternion(new THREE.Quaternion()).invert();
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(headInv);
  for (const root of head.children.filter((c) => /ear/i.test(c.name) && c.children.length)) {
    const tip = root.children[0].position.clone().applyQuaternion(root.quaternion).normalize();
    const worldX = root.getWorldPosition(new THREE.Vector3()).x;
    ears.push({
      bone: root,
      rest: root.quaternion.clone(),
      // Turning around the face's forward axis swings the ear sideways (in the
      // plane you see); turning around tip x forward tips it toward/away from you.
      swing: fwd.clone(),
      tipAxis: new THREE.Vector3().crossVectors(tip, fwd).normalize(),
      side: Math.sign(worldX) || 1, // +1 = ear on screen right
    });
  }
  vrm.scene.traverse((o) => {
    if (!tail && /tail/i.test(o.name) && !/tail/i.test(o.parent?.name || "")) {
      const parentInv = o.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      tail = { bone: o, rest: o.quaternion.clone(), wag: new THREE.Vector3(0, 1, 0).applyQuaternion(parentInv) };
    }
  });
}

const tmpQ = new THREE.Quaternion();
function turnInParent(bone, axis, angle) {
  bone.quaternion.premultiply(tmpQ.setFromAxisAngle(axis, angle));
}

// Spring bones switch off matrixAutoUpdate, so push the new pose through by hand.
function commit(bone) {
  bone.updateMatrix();
  bone.updateMatrixWorld(true);
}

// Back to the resting angle each frame, so the turns below never pile up on
// models whose ears aren't driven by spring bones.
function resetEarsAndTail() {
  for (const ear of ears) ear.bone.quaternion.copy(ear.rest);
  if (tail) tail.bone.quaternion.copy(tail.rest);
}

// Runs after vrm.update(), so it adds to whatever the spring bones did.
function animateEarsAndTail(t, dt) {
  const listening = !!recorder;
  const talking = mouth > 0.05;
  earState.perk = THREE.MathUtils.lerp(earState.perk, listening || isExcited() ? 1 : 0, 0.1);

  if (earState.twitchT < 0 && t > earState.nextTwitch && ears.length) {
    earState.twitchT = 0;
    earState.twitchSide = Math.random() < 0.3 ? 0 : ears[Math.floor(Math.random() * ears.length)].side;
  }
  let twitch = 0;
  if (earState.twitchT >= 0) {
    earState.twitchT += dt;
    twitch = Math.sin(Math.min(earState.twitchT / 0.28, 1) * Math.PI);
    if (earState.twitchT > 0.28) {
      earState.twitchT = -1;
      earState.nextTwitch = t + 2.5 + Math.random() * 5;
    }
  }

  for (const ear of ears) {
    const mine = earState.twitchSide === 0 || earState.twitchSide === ear.side;
    // Positive "up" = swing toward the middle of the head (ear stands taller).
    const sway = Math.sin(t * 0.9 + ear.side) * 0.04;
    const bounce = talking ? Math.sin(t * 14 + ear.side) * 0.08 * mouth : 0;
    const up = 0.3 * earState.perk + sway + bounce - (mine ? twitch * 0.3 : 0) - 0.4 * pose.sleep;
    turnInParent(ear.bone, ear.swing, up * ear.side);
    // A twitch also flicks the ear back a little, like a real one.
    if (mine && twitch) turnInParent(ear.bone, ear.tipAxis, -twitch * 0.25);
    commit(ear.bone);
  }

  if (tail) {
    const speed = talking ? 9 : 2.2;
    const amount = talking ? 0.3 : 0.12;
    turnInParent(tail.bone, tail.wag, Math.sin(t * speed) * amount);
    commit(tail.bone);
  }
}

// ---------- body moves ----------

// Each move describes a target pose per frame; the live pose eases toward it,
// so moves blend in and out instead of snapping.
let action = null; // { type, t0, dur, dir }
let baseYaw = 0;
let hipsRest = null;
let modelHeight = 1;
let legFrac = 0.3; // hip height as a fraction of the model's height
const armRest = {};
const POSE_KEYS = [
  "hipsY", "hipsSway", "spineSway", "lean", "yaw", "nod", "lookYaw",
  "raiseL", "raiseR", "swingL", "swingR", "legL", "legR", "kneeL", "kneeR", "spreadL", "spreadR",
  "lie", "sleep",
];
const SLOW_KEYS = new Set(["lie", "sleep"]); // lying down and waking up take their time
const pose = Object.fromEntries(POSE_KEYS.map((k) => [k, 0]));
let spin = 0; // twirl angle, not eased (a full turn ends where it started)
let nextIdleMove = 30;
let lastInteraction = 0;
let cheeredThisReply = false;
const axisX = new THREE.Vector3(1, 0, 0);
const axisZ = new THREE.Vector3(0, 0, 1);

const smooth = (x) => x * x * (3 - 2 * x);

// One dance move's pose at time `at` into the move.
function dancePose(style, at, bpm = danceBpm, dur = 8) {
  const p = Object.fromEntries(POSE_KEYS.map((k) => [k, 0]));
  // Spotify no longer shares song tempo with new apps, so dance to a steady
  // ~116 bpm. `beat` counts beats; sin(beat * PI) peaks once per beat.
  const beat = at * (bpm / 60);
  const bounce = Math.abs(Math.sin(beat * Math.PI));
  const half = Math.sin(beat * Math.PI / 2); // swings over two beats
  // Graceful moves are shaped over the whole move, not the beat: `u` runs
  // 0 to 1 across it, and `env` eases in, holds the line, and eases out.
  const u = Math.min(at / dur, 1);
  const env = smooth(Math.min(1, u * 3)) * smooth(Math.min(1, (1 - u) * 3));
  switch (style) {
    // ---- graceful: long lines, slow stretches (for soft, slow music) ----
    case "portdebras": { // arms sweep up in a big arc, torso following, then down
      const rise = Math.sin(u * Math.PI);
      const follow = Math.sin(Math.max(0, u - 0.12) / 0.88 * Math.PI);
      // Peaks at a high V (2.3), not straight up: short arms vanish behind the head.
      p.raiseR = 0.3 + 2.0 * rise;
      p.raiseL = 0.3 + 2.0 * follow;
      p.swingL = p.swingR = 0.3 * rise;
      p.lean = 0.12 * rise; // gentle back arch at the top
      p.spineSway = 0.08 * Math.sin(u * Math.PI * 2);
      p.nod = -0.06 * rise; // eyes follow the hands up
      break;
    }
    case "arabesque": // one leg long behind, arms reaching, leaning into the line
      p.legR = -0.9 * env;
      p.lean = -0.18 * env;
      p.raiseL = 0.3 + 1.9 * env;
      p.swingL = 0.8 * env;
      p.raiseR = 0.3 + 1.2 * env;
      p.swingR = -0.2 * env;
      p.hipsY = 0.02 * env;
      break;
    case "plie": { // two slow plie-and-rise cycles, arms rounding overhead on the rise
      const w = Math.sin(u * Math.PI * 4);
      const bend = Math.max(0, w);
      const rise = Math.max(0, -w);
      p.kneeL = p.kneeR = 0.45 * bend;
      p.legL = p.legR = 0.2 * bend;
      p.spreadL = p.spreadR = 0.15 * bend;
      p.hipsY = -0.05 * bend + 0.03 * rise;
      p.raiseL = p.raiseR = 1.1 + 1.1 * rise;
      p.swingL = p.swingR = 0.5;
      break;
    }
    case "sidereach": { // long side bend with the far arm stretched overhead, each side
      const side = u < 0.5 ? 1 : -1;
      const reach = Math.sin(((u * 2) % 1) * Math.PI);
      p.spineSway = 0.3 * reach * side;
      p.hipsSway = -0.1 * reach * side;
      p.raiseR = side > 0 ? 0.3 + 2.0 * reach : 0.4;
      p.raiseL = side < 0 ? 0.3 + 2.0 * reach : 0.4;
      p.yaw = 0.1 * side * reach;
      break;
    }
    case "developpe": { // a leg slowly lifts, unfolds forward, and lowers; then the other
      const left = u < 0.5;
      const lift = Math.sin(((u * 2) % 1) * Math.PI);
      const unfold = 0.8 * Math.sin(lift * Math.PI); // bent on the way, straight at the top
      if (left) { p.legL = 1.1 * lift; p.kneeL = unfold; } else { p.legR = 1.1 * lift; p.kneeR = unfold; }
      p.raiseL = p.raiseR = 0.3 + 1.4 * lift;
      p.hipsY = 0.02 * lift;
      p.lean = 0.05 * lift;
      break;
    }
    case "swan": { // slow wing-like arm waves, gentle rise and fall
      const wave = Math.sin(u * Math.PI * 4);
      p.raiseL = p.raiseR = 1.4 + 0.6 * wave;
      p.swingL = p.swingR = -0.2 + 0.2 * Math.sin(u * Math.PI * 4 + 1);
      p.hipsY = 0.02 * wave;
      p.kneeL = p.kneeR = 0.15 * (1 - wave) / 2;
      p.nod = -0.03 * wave;
      break;
    }
    case "lunge": // step into a long lunge, reaching forward and up
      p.legL = 0.6 * env;
      p.kneeL = 0.6 * env;
      p.legR = -0.45 * env;
      p.kneeR = 0.1 * env;
      p.hipsY = -0.05 * env;
      p.lean = -0.12 * env;
      p.raiseL = p.raiseR = 0.3 + 1.7 * env;
      p.swingL = p.swingR = 0.7 * env;
      break;
    case "reverence": // the ballet bow: one leg back, arms opening low, bowing forward
      p.legR = -0.35 * env;
      p.kneeL = 0.4 * env;
      p.hipsY = -0.04 * env;
      p.lean = -0.3 * env;
      p.raiseL = p.raiseR = 0.3 + 0.9 * env;
      p.swingL = p.swingR = -0.3 * env;
      p.nod = 0.12 * env;
      break;

    // ---- energetic: on the beat (for pop, hip hop, dance music) ----
    case "sway": // arms up overhead, swaying side to side
      p.hipsSway = half * 0.18;
      p.spineSway = -p.hipsSway * 0.8;
      p.raiseL = p.raiseR = 2.4 + half * 0.3;
      p.yaw = half * 0.15;
      p.hipsY = -bounce * 0.015;
      p.nod = Math.sin(beat * Math.PI) * 0.05;
      break;
    case "shuffle": { // step out left, then right, arms swinging
      const s = Math.sin(beat * Math.PI);
      p.spreadL = Math.max(0, s) * 0.4;
      p.spreadR = Math.max(0, -s) * 0.4;
      p.hipsSway = s * 0.1;
      p.swingL = s * 0.5;
      p.swingR = -s * 0.5;
      p.raiseL = p.raiseR = 0.6;
      p.hipsY = Math.abs(s) * 0.03;
      break;
    }
    case "bop": // head bops on every beat with a fist pump
      p.nod = -bounce * 0.12;
      p.raiseR = 1.8 + Math.max(0, Math.sin(beat * Math.PI * 2)) * 0.9;
      p.raiseL = 0.4;
      p.kneeL = p.kneeR = bounce * 0.25;
      p.hipsY = -bounce * 0.02;
      p.yaw = 0.15;
      break;
    case "punch": { // alternate arms punch the air, one per beat
      const up = Math.floor(beat) % 2 === 0;
      p.raiseL = up ? 2.8 : 0.6;
      p.raiseR = up ? 0.6 : 2.8;
      p.hipsY = -bounce * 0.025;
      p.kneeL = p.kneeR = bounce * 0.25;
      p.yaw = (up ? 1 : -1) * 0.12;
      break;
    }
    case "hop": // bounce on the beat, arms up, legs kicking out
      p.hipsY = bounce * 0.1;
      p.raiseL = p.raiseR = 2.2;
      p.spreadL = p.spreadR = bounce * 0.15;
      p.kneeL = p.kneeR = (1 - bounce) * 0.3;
      break;
    case "ymca": { // Y, M, C, A: one letter per beat
      const letter = Math.floor(beat) % 4;
      const shapes = [
        { raiseL: 2.6, raiseR: 2.6 }, // Y: arms up and wide
        { raiseL: 1.9, raiseR: 1.9, swingL: 0.5, swingR: 0.5 }, // M: hands to head
        { raiseL: 2.4, raiseR: 1.1, hipsSway: 0.1 }, // C: curved to one side
        { raiseL: 2.9, raiseR: 2.9, swingL: 0.2, swingR: 0.2 }, // A: arms up and together
      ];
      Object.assign(p, shapes[letter]);
      p.hipsY = -bounce * 0.02;
      break;
    }
    case "disco": { // point up to the sky, then down across the body
      const up = Math.floor(beat) % 2 === 0;
      p.raiseR = up ? 2.7 : 0.4;
      p.swingR = up ? 0.3 : -0.5;
      p.raiseL = 0.3;
      p.hipsSway = up ? 0.12 : -0.12;
      p.yaw = up ? 0.25 : -0.1;
      p.kneeL = p.kneeR = bounce * 0.2;
      break;
    }
    case "robot": { // stiff poses that snap on each beat
      const poses = [
        { raiseL: 1.6, raiseR: 0.2, yaw: 0.3 },
        { raiseL: 0.2, raiseR: 1.6, yaw: -0.3 },
        { raiseL: 1.6, raiseR: 1.6, yaw: 0 },
        { raiseL: 0.2, raiseR: 0.2, yaw: 0, nod: 0.1 },
      ];
      Object.assign(p, poses[Math.floor(beat) % 4]);
      break;
    }
    case "floss": { // arms swing one way while the hips go the other
      const f = Math.sin(beat * Math.PI * 2);
      p.swingL = p.swingR = f * 0.7;
      p.raiseL = p.raiseR = 0.35;
      p.hipsSway = -f * 0.15;
      p.spineSway = f * 0.05;
      break;
    }
    case "wiggle": // hands back, knees bent, fast hip wiggle
      p.hipsSway = Math.sin(beat * Math.PI * 4) * 0.15;
      p.kneeL = p.kneeR = 0.3;
      p.legL = p.legR = 0.15;
      p.raiseL = p.raiseR = 0.5;
      p.swingL = p.swingR = -0.3;
      p.hipsY = -0.02;
      p.nod = Math.sin(beat * Math.PI * 2) * 0.04;
      break;
    case "guitar": // air guitar: strumming hand, headbang
      p.raiseL = 1.0;
      p.swingL = 0.9;
      p.raiseR = 0.4;
      p.swingR = 0.4 + Math.sin(beat * Math.PI * 4) * 0.3;
      p.nod = -bounce * 0.15;
      p.kneeL = p.kneeR = bounce * 0.3;
      p.yaw = 0.25;
      break;
    case "stepturn": { // face left, front, right, front with a little hop
      const step = Math.floor(beat) % 4;
      p.yaw = [0, 0.7, 0, -0.7][step];
      p.hipsY = bounce * 0.04;
      p.raiseL = step % 2 ? 1.4 : 0.6;
      p.raiseR = step % 2 ? 0.6 : 1.4;
      break;
    }
    case "clap": { // clap in front on every beat, with a bounce
      const clap = Math.max(0, Math.sin(beat * Math.PI * 2));
      p.raiseL = p.raiseR = 0.25; // raising swings arms outward on some rigs; swing brings them in front
      p.swingL = p.swingR = 1.0 + clap * 0.35;
      p.hipsY = -bounce * 0.025;
      p.kneeL = p.kneeR = bounce * 0.25;
      p.nod = bounce * 0.05;
      break;
    }
    case "carlton": { // both arms swing together, side to side
      p.raiseL = 1.2 + half * 0.9;
      p.raiseR = 1.2 - half * 0.9;
      p.hipsSway = -half * 0.12;
      p.yaw = half * 0.2;
      p.kneeL = p.kneeR = bounce * 0.2;
      break;
    }
    case "chicken": // flapping wings, pecking head, bent knees
      p.raiseL = p.raiseR = 0.9 + Math.sin(beat * Math.PI * 4) * 0.5;
      p.swingL = p.swingR = -0.3;
      p.nod = Math.max(0, Math.sin(beat * Math.PI * 2)) * 0.12;
      p.kneeL = p.kneeR = 0.35;
      p.legL = p.legR = 0.15;
      p.hipsY = -0.02 - bounce * 0.015;
      break;
    case "sprinkler": { // arm out, turning in steps, then sweeping back
      const step = Math.floor(beat) % 8;
      p.yaw = step < 6 ? -0.6 + step * 0.24 : 0.6 - (step - 5) * 0.6;
      p.raiseR = 1.6;
      p.swingR = 0.6;
      p.raiseL = 2.6; // other hand behind the head
      p.swingL = -0.4;
      p.hipsY = -bounce * 0.02;
      break;
    }
    case "cabbage": { // arms churning in circles in front, hips circling
      const c = beat * Math.PI;
      p.raiseL = 1.1 + Math.cos(c) * 0.4;
      p.raiseR = 1.1 + Math.cos(c + Math.PI) * 0.4;
      p.swingL = 0.6 + Math.sin(c) * 0.4;
      p.swingR = 0.6 + Math.sin(c + Math.PI) * 0.4;
      p.hipsSway = Math.sin(c) * 0.1;
      p.kneeL = p.kneeR = 0.25;
      break;
    }
    case "leanback": // lean back with arms wide, bouncing
      p.lean = 0.22;
      p.raiseL = p.raiseR = 1.6 + bounce * 0.3;
      p.kneeL = p.kneeR = 0.3 + bounce * 0.15;
      p.hipsY = -0.02 - bounce * 0.02;
      p.nod = -0.08;
      break;
    case "kick": { // kick one leg forward, then the other, with a hop
      const left = Math.floor(beat) % 2 === 0;
      const kick = Math.sin((beat % 1) * Math.PI);
      p.legL = left ? kick * 0.8 : 0;
      p.legR = left ? 0 : kick * 0.8;
      p.hipsY = kick * 0.05;
      p.raiseL = left ? 0.6 : 1.4;
      p.raiseR = left ? 1.4 : 0.6;
      break;
    }
    default: // "groove": squat-bounce, hip sway, alternating arm pumps
      p.hipsY = -bounce * 0.03;
      p.kneeL = p.kneeR = bounce * 0.35;
      p.legL = p.legR = bounce * 0.18; // squat: thighs forward, knees back
      p.hipsSway = half * 0.14;
      p.spineSway = -p.hipsSway * 0.7;
      p.raiseL = 0.5 + Math.max(0, half) * 1.4;
      p.raiseR = 0.5 + Math.max(0, -half) * 1.4;
      p.yaw = Math.sin(beat * Math.PI / 4) * 0.35;
      p.nod = Math.sin(beat * Math.PI) * 0.08;
  }
  return p;
}

const LOWER_KEYS = ["hipsY", "hipsSway", "legL", "legR", "kneeL", "kneeR", "spreadL", "spreadR"];
const MIRROR_PAIRS = [["raiseL", "raiseR"], ["swingL", "swingR"], ["legL", "legR"], ["kneeL", "kneeR"], ["spreadL", "spreadR"]];
function mirrorPose(q) {
  for (const [l, r] of MIRROR_PAIRS) [q[l], q[r]] = [q[r], q[l]];
  for (const k of ["hipsSway", "spineSway", "yaw"]) q[k] = -q[k];
}

function targetPose(t) {
  const p = Object.fromEntries(POSE_KEYS.map((k) => [k, 0]));
  spin = 0;
  if (!action) return p;
  const at = t - action.t0;
  const a = action.type;

  if (a === "walk") {
    const ph = at * Math.PI * 2 * 1.8; // steps per second
    p.legL = Math.sin(ph) * 0.45;
    p.legR = -p.legL;
    p.kneeL = Math.max(0, -Math.sin(ph)) * 0.6; // bend the leg that's lifting
    p.kneeR = Math.max(0, Math.sin(ph)) * 0.6;
    p.swingL = -p.legL * 0.8;
    p.swingR = -p.legR * 0.8;
    p.hipsY = Math.abs(Math.sin(ph)) * 0.025;
    p.spineSway = Math.sin(ph) * 0.04;
    p.yaw = action.dir * 0.75; // three-quarter turn: heading that way, face still visible
  }

  if (a === "dance") {
    // Mix and match: arms (and head) from one move, hips and legs from
    // another, sometimes mirrored left-right.
    const q = dancePose(action.style, at, action.bpm, action.dur);
    if (action.legs) {
      const r = dancePose(action.legs, at, action.bpm, action.dur);
      for (const k of LOWER_KEYS) q[k] = r[k];
    }
    if (action.mirror) mirrorPose(q);
    Object.assign(p, q);
  }

  if (a === "hop") {
    const ph = (at % 0.55) / 0.55; // one hop every 0.55 s
    const air = Math.sin(ph * Math.PI);
    p.hipsY = air * 0.12;
    p.kneeL = p.kneeR = (1 - air) * 0.3 + air * 0.5;
    p.legL = p.legR = air * 0.3;
    p.raiseL = p.raiseR = 0.4 + air * 1.2;
  }

  if (a === "happy") {
    // Bouncy and bright: quick little hops with alternating paw pumps.
    const beat = at * 3;
    const air = Math.abs(Math.sin(beat * Math.PI));
    p.hipsY = air * 0.06;
    p.kneeL = p.kneeR = (1 - air) * 0.3;
    p.raiseL = 1.2 + Math.max(0, Math.sin(beat * Math.PI / 2)) * 1.2;
    p.raiseR = 1.2 + Math.max(0, -Math.sin(beat * Math.PI / 2)) * 1.2;
    p.hipsSway = Math.sin(beat * Math.PI / 2) * 0.08;
    p.nod = -0.04;
  }

  if (a === "cheer") {
    // Both paws up, bouncing: for exciting news.
    const air = Math.abs(Math.sin(at * Math.PI * 3));
    p.raiseL = p.raiseR = 2.5 + Math.sin(at * 18) * 0.15;
    p.hipsY = air * 0.05;
    p.kneeL = p.kneeR = (1 - air) * 0.25;
    p.nod = -0.05;
  }

  if (a === "twirl") {
    // Quick spin with arms out; or, for graceful music, a slow pirouette up on
    // the toes with the arms held round in front.
    const k = Math.min(at / (action.slow ? 3 : 1.3), 1);
    spin = smooth(k) * Math.PI * 2;
    if (action.slow) {
      p.raiseL = p.raiseR = 1.0;
      p.swingL = p.swingR = 0.7;
      p.hipsY = 0.03 * Math.sin(k * Math.PI);
      p.nod = -0.04;
    } else {
      p.raiseL = p.raiseR = 1.3;
      p.hipsY = Math.sin(k * Math.PI) * 0.05;
    }
  }

  if (a === "wave") {
    p.raiseR = 2.4 + Math.sin(at * 12) * 0.35;
    p.raiseL = 0.1;
    p.hipsSway = 0.04;
    p.nod = 0.05;
  }

  if (a === "stretch") {
    const k = Math.sin(Math.min(at / action.dur, 1) * Math.PI); // up, hold, down
    p.raiseL = p.raiseR = 2.7 * k;
    p.lean = 0.18 * k;
    p.hipsY = 0.02 * k;
  }

  if (a === "look") {
    p.lookYaw = Math.sin(at * Math.PI / 2) * 0.55; // left, then right
    p.nod = 0.04;
  }

  if (a === "sit") {
    // Plop down with legs out in front.
    p.legL = p.legR = 1.45;
    p.hipsY = -legFrac * 0.85;
    p.swingL = p.swingR = 0.3;
    p.raiseL = p.raiseR = 0.15;
    p.hipsSway = Math.sin(at * 0.8) * 0.03;
  }

  if (a === "nap") {
    p.lie = 1;
    p.sleep = 1;
    p.legL = p.legR = 0.35;
    p.kneeL = p.kneeR = 0.5;
    p.raiseL = p.raiseR = 0.2;
    p.swingL = p.swingR = 0.4;
  }

  if (action.dur && at > action.dur) {
    // A nap ends in a stretch; everything else goes back to standing.
    action = a === "nap" ? { type: "stretch", t0: t, dur: 2.5 } : null;
    if (a === "nap") setStatus("");
  }
  return p;
}

// Normalized bones start world-aligned, so these axes mean the same thing on
// every model. `facing` fixes the sign for VRM0 models, which face -Z inside.
function applyBodyPose(t, dt) {
  const target = targetPose(t);
  const ease = 1 - Math.exp(-dt * (action?.soft ? 2.5 : 10)); // graceful moves flow slowly
  const slowEase = 1 - Math.exp(-dt * 2.5);
  for (const k of POSE_KEYS) pose[k] += (target[k] - pose[k]) * (SLOW_KEYS.has(k) ? slowEase : ease);

  const b = (name) => vrm.humanoid.getNormalizedBoneNode(name);
  const hips = b("hips");
  if (hips && hipsRest) {
    hips.position.copy(hipsRest);
    hips.position.y += pose.hipsY * modelHeight;
    hips.rotation.set(0, 0, pose.hipsSway);
  }
  if (b("spine")) {
    b("spine").rotation.z = Math.sin(t * 0.5) * 0.02 + pose.spineSway;
    b("spine").rotation.x = -pose.lean * facing;
  }

  for (const [side, raise, swing] of [["left", pose.raiseL, pose.swingL], ["right", pose.raiseR, pose.swingR]]) {
    const upper = b(`${side}UpperArm`);
    const rest = armRest[side];
    if (!upper || !rest) continue;
    upper.quaternion.copy(rest.rest);
    upper.quaternion.premultiply(tmpQ.setFromAxisAngle(axisZ, raise * rest.out));
    upper.quaternion.premultiply(tmpQ.setFromAxisAngle(axisX, -swing * facing));
  }

  for (const [side, leg, knee, spread] of [["left", pose.legL, pose.kneeL, pose.spreadL], ["right", pose.legR, pose.kneeR, -pose.spreadR]]) {
    b(`${side}UpperLeg`) && (b(`${side}UpperLeg`).rotation.x = -leg * facing);
    b(`${side}UpperLeg`) && (b(`${side}UpperLeg`).rotation.z = spread * facing); // step out sideways
    b(`${side}LowerLeg`) && (b(`${side}LowerLeg`).rotation.x = knee * facing);
  }

  // Lying down: roll onto the side around the feet, then slide back into the
  // middle of the window and up off the floor.
  camLie = pose.lie;
  vrm.scene.rotation.set(0, baseYaw + pose.yaw + spin, pose.lie * Math.PI / 2);
  vrm.scene.position.set(facing * modelHeight * 0.42 * pose.lie, modelHeight * 0.18 * pose.lie, 0);
}

function startAction(type, dur, extra = {}) {
  if (!vrm || action?.type === "walk") return false;
  action = { type, t0: timer.getElapsed(), dur, ...extra };
  return true;
}

// Tempo: heard from the music when possible, otherwise a steady 116 bpm.
const DEFAULT_BPM = 116;
let danceBpm = DEFAULT_BPM;
const COUNTS_PER_MOVE = 8; // dance mode changes move every "5, 6, 7, 8"
const DANCE_STYLES = ["groove", "sway", "shuffle", "bop", "punch", "hop", "ymca", "disco", "robot", "floss", "wiggle", "guitar", "stepturn", "clap", "carlton", "chicken", "sprinkler", "cabbage", "leanback", "kick"];
const randomStyle = (not) => {
  const pool = DANCE_STYLES.filter((s) => s !== not);
  return pool[Math.floor(Math.random() * pool.length)];
};
const dance = (seconds = 8, style = randomStyle()) => startAction("dance", seconds, { style, bpm: danceBpm });

// Dance mode: while Spotify is playing, keep dancing, changing moves every
// set of 8 counts with the odd twirl. Talking, listening and walking come first.
let musicOn = false;
// Moves come out of a shuffled bag, so every move shows up before any repeats.
let danceBag = [];
const nextStyle = () => {
  if (!danceBag.length) danceBag = [...DANCE_STYLES].sort(() => Math.random() - 0.5);
  return danceBag.pop();
};
// Graceful set, for slow, soft music (classical, piano, ambient, contemporary).
const ELEGANT_STYLES = ["portdebras", "arabesque", "plie", "sidereach", "developpe", "swan", "lunge", "reverence"];
let elegantBag = [];
const nextElegant = () => {
  if (!elegantBag.length) elegantBag = [...ELEGANT_STYLES].sort(() => Math.random() - 0.5);
  return elegantBag.pop();
};
let musicMood = "energetic"; // or "elegant"; set from how strong the beat is
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
let movesUntilTwirl = randInt(3, 7);

let lastDanceBlockLog = 0;
function maybeDanceToMusic() {
  if (musicOn && (!vrm || busy || recorder || (action && action.type !== "dance" && action.type !== "twirl"))) {
    // Log why dance mode is waiting, at most every 10 s.
    const now = timer.getElapsed();
    if (now - lastDanceBlockLog > 10) {
      lastDanceBlockLog = now;
      api.log(`dance waiting: action=${action?.type ?? "none"} busy=${busy} listening=${!!recorder} model=${!!vrm}`);
    }
  }
  if (!musicOn || !vrm || action || busy || recorder) return;
  const elegant = musicMood === "elegant";
  if (--movesUntilTwirl <= 0) {
    movesUntilTwirl = randInt(3, 7); // next twirl after 3 to 7 moves
    return elegant ? startAction("twirl", 3.3, { slow: true, soft: true }) : twirl();
  }
  if (elegant) {
    // Long, clean lines: at least 7 s per move, not mixed, sometimes mirrored.
    const dur = Math.max(COUNTS_PER_MOVE * 60 / danceBpm, 7);
    return startAction("dance", dur, { style: nextElegant(), mirror: Math.random() < 0.5, bpm: danceBpm, soft: true });
  }
  const style = nextStyle();
  const legs = Math.random() < 0.5 ? nextStyle() : null; // half the time, mix two moves
  startAction("dance", COUNTS_PER_MOVE * 60 / danceBpm, { style, legs, mirror: Math.random() < 0.4, bpm: danceBpm });
}
const hop = () => startAction("hop", 1.1);
const cheer = () => startAction("cheer", 1.4);
const happyBounce = () => startAction("happy", 2.6);

// Excited mode: for fun moments (music, games, good news). Raises the
// voice, perks the ears, shows a happy face and adds bouncy body language.
let excitedUntil = 0;
let excitement = 0; // eased 0..1
const EXCITED_PITCH = 1.15; // on top of the character's normal pitch
function getExcited(seconds = 8) {
  excitedUntil = Math.max(excitedUntil, timer.getElapsed() + seconds);
}
const isExcited = () => timer.getElapsed() < excitedUntil;
const FUN_WORDS = /\b(music|songs?|play(ing)?|spotify|party|dance|dancing|games?|gaming|fun|yay|woo+|awesome|let'?s go|celebrate|birthday|won|win|weekend|holiday)\b/i;
const twirl = () => startAction("twirl", 1.5);
const wave = () => startAction("wave", 2.2);
const stretch = () => startAction("stretch", 2.5);
const lookAround = () => startAction("look", 4);
const sit = (seconds = 12 + Math.random() * 10) => startAction("sit", seconds);

function nap(seconds = 30 + Math.random() * 30) {
  if (startAction("nap", seconds)) setStatus("Zzz…");
}

// Anything Jax does wakes it up (with a stretch) or makes it stand up.
function wake() {
  lastInteraction = timer.getElapsed();
  if (action?.type === "nap") {
    setStatus("");
    action = { type: "stretch", t0: timer.getElapsed(), dur: 2.5 };
  } else if (action?.type === "sit") {
    action = null;
  }
}

async function walk(dx) {
  if (!vrm || action?.type === "walk" || Math.abs(dx) < 30) return;
  action = { type: "walk", t0: timer.getElapsed(), dir: Math.sign(dx) };
  await api.walk(dx);
  action = null;
}

function wander() {
  const dist = 150 + Math.random() * 350;
  return walk(Math.random() < 0.5 ? -dist : dist);
}

// Pick something to do. Naps only when Jax hasn't talked to it for a while.
function randomMove() {
  const t = timer.getElapsed();
  const moves = [
    [wander, 26], [hop, 10], [() => dance(6), 9], [twirl, 12], [wave, 8],
    [stretch, 8], [lookAround, 12], [sit, 9],
  ];
  if (t - lastInteraction > 120 && !musicOn) moves.push([nap, 10]);
  let r = Math.random() * moves.reduce((sum, [, w]) => sum + w, 0);
  for (const [move, w] of moves) if ((r -= w) < 0) return move();
}

// Every so often when nothing else is happening, do something on its own.
function maybeIdleMove(t) {
  if (action || busy || recorder || mouth > 0.02 || t < nextIdleMove) return;
  nextIdleMove = t + 25 + Math.random() * 35;
  randomMove();
}

// Moves asked for in what the user says.
function movesFromText(text) {
  const s = text.toLowerCase();
  if (/\bdanc(e|ing)\b|\bboogie\b/.test(s)) dance(10);
  else if (/\b(spin|twirl)\b/.test(s)) twirl();
  else if (/\b(nap|sleep|lie down|go to bed)\b/.test(s)) nap();
  else if (/\bsit( down)?\b/.test(s)) sit();
  else if (/\bstretch\b/.test(s)) stretch();
  else if (/\blook around\b/.test(s)) lookAround();
  else if (/\bwave\b|^(hi|hello|hey|yo)\b/.test(s)) wave();
  else if (/\bcome (here|over|closer)\b|\bover here\b/.test(s)) walk(cursor.x - cursor.w / 2);
  else if (/\b(go|walk|move) (to the )?left\b/.test(s)) walk(-300);
  else if (/\b(go|walk|move) (to the )?right\b/.test(s)) walk(300);
  else if (/\b(walk around|go for a walk|take a walk|wander)\b/.test(s)) wander();
  else if (/\b(hop|jump)\b/.test(s)) hop();
  else return false;
  return true;
}

// Drag a .vrm onto the window to swap bodies; it's saved for next launch.
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", () => document.body.classList.remove("dragging"));
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const file = [...e.dataTransfer.files].find((f) => f.name.toLowerCase().endsWith(".vrm"));
  if (!file) return say("That isn't a .vrm file.", { speak: false });
  const bytes = await file.arrayBuffer();
  try {
    await loadVrm(bytes);
    await api.saveVrm(file.name, new Uint8Array(bytes));
  } catch (err) {
    console.error(err);
    say("I couldn't load that model.", { speak: false });
  }
});

// ---------- idle life: breathing, blinking, arms down, eyes on the cursor ----------

let cursor = { x: 190, y: 200, w: 380, h: 620 };
api.onCursor((p) => (cursor = p));

let nextBlink = 2;
let blinkT = -1;
let mouth = 0; // 0..1, driven by voice loudness
const gaze = { yaw: 0, pitch: 0 };
let lastCursor = { x: 0, y: 0 };
let lastMove = -10;
const timer = new THREE.Timer();

function animate(now) {
  requestAnimationFrame(animate);
  timer.update(now);
  const dt = timer.getDelta();
  const t = timer.getElapsed();

  if (vrm) {
    const h = vrm.humanoid;
    const bone = (name) => h.getNormalizedBoneNode(name);

    // Breathing, then whatever move is playing (walk, dance, hop).
    bone("chest") && (bone("chest").rotation.x = Math.sin(t * 1.6) * 0.015);
    applyBodyPose(t, dt);
    maybeDanceToMusic();
    maybeIdleMove(t);
    placeCamera();
    pinBubbleToHead();

    // Where to look. The mouse is usually far above this small window, so use
    // angles against a "screen distance" (far cursor = modest turn), cap the
    // tilt, and drift back to the viewer when the mouse sits still.
    const dx = cursor.x - cursor.w / 2;
    const dy = cursor.y - cursor.h * 0.35;
    if (Math.abs(cursor.x - lastCursor.x) + Math.abs(cursor.y - lastCursor.y) > 2) {
      lastCursor = { ...cursor };
      lastMove = t;
    }
    const following = t - lastMove < 3 && pose.sleep < 0.5;
    const idleYaw = Math.sin(t * 0.23) * 0.12 + Math.sin(t * 0.61) * 0.05;
    const idlePitch = Math.sin(t * 0.31) * 0.03;
    const yawT = following ? THREE.MathUtils.clamp(Math.atan2(dx, 900), -0.45, 0.45) : idleYaw;
    const pitchT = following ? THREE.MathUtils.clamp(Math.atan2(dy, 900), -0.1, 0.18) : idlePitch;
    gaze.yaw = THREE.MathUtils.lerp(gaze.yaw, yawT, 0.04);
    gaze.pitch = THREE.MathUtils.lerp(gaze.pitch, pitchT, 0.04);

    // Eyes lead, the head follows about half as far.
    const headNode = bone("head");
    const headPos = headNode ? headNode.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 1.4, 0);
    // Eyes aim at the viewer (the camera), offset by the gaze.
    const reach = camera.position.distanceTo(headPos);
    lookTarget.position.set(
      camera.position.x + Math.sin(gaze.yaw + pose.lookYaw) * reach,
      camera.position.y - Math.sin(gaze.pitch) * reach,
      camera.position.z,
    );
    // Simple rigs (e.g. mascots) have no neck, so turn the head itself, more gently.
    const neck = bone("neck") || headNode;
    const turn = bone("neck") ? 0.6 : 0.4;
    if (neck) {
      neck.rotation.y = gaze.yaw * turn + pose.lookYaw;
      // VRM0 models face -Z internally, which flips which way "nod down" goes.
      // Capped: tilting a neckless head too far opens a seam at the collar.
      const nod = Math.min(headTilt + gaze.pitch * turn + mouth * 0.04 + pose.nod, 0.22);
      neck.rotation.x = nod * facing;
    }

    // Blink every few seconds.
    const em = vrm.expressionManager;
    if (em) {
      if (blinkT < 0 && t > nextBlink) blinkT = 0;
      if (blinkT >= 0) {
        blinkT += dt;
        const b = blinkT < 0.08 ? blinkT / 0.08 : Math.max(0, 1 - (blinkT - 0.08) / 0.1);
        em.setValue("blink", Math.max(b, pose.sleep));
        if (blinkT > 0.18) {
          blinkT = -1;
          nextBlink = t + 2 + Math.random() * 4;
        }
      }
      if (blinkT < 0) em.setValue("blink", pose.sleep);
      em.setValue("aa", mouth);
      excitement += ((isExcited() ? 1 : 0) - excitement) * Math.min(1, dt * 4);
      em.setValue("happy", excitement * 0.8);
      em.setValue("relaxed", 0.25 * (1 - excitement));
    }

    resetEarsAndTail();
    vrm.update(dt);
    animateEarsAndTail(t, dt);
  }

  renderer.render(scene, camera);
}
animate();

// ---------- UI helpers ----------

let bubbleTimer;
function showBubble(text, { you = false } = {}) {
  clearTimeout(bubbleTimer);
  bubbleText.textContent = text;
  bubble.classList.toggle("you", you);
  bubble.classList.remove("hidden", "faded");
  bubbleText.scrollTop = bubbleText.scrollHeight;
}
function fadeBubbleSoon(ms = 7000) {
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.add("faded"), ms);
}
function setStatus(text, live = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("hidden", !text);
  statusEl.classList.toggle("live", live);
}

// ---------- voice out: queue sentences, play with lip-sync ----------

const audioCtx = new AudioContext();
const analyser = audioCtx.createAnalyser();
analyser.fftSize = 512;
analyser.connect(audioCtx.destination);
const levels = new Float32Array(analyser.fftSize);

let epoch = 0; // bumped on interrupt so stale audio is dropped
let playChain = Promise.resolve();
let currentSource = null;

function cleanForSpeech(text) {
  return text
    .replace(/\*[^*]*\*/g, " ") // stage directions
    .replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, "")
    .replace(/[#_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// "pika" mode: the bubble shows Claude's English; the voice is just one short
// burst per reply ("Peeka!", "Peekachoo!", "Peeka?"), matched to the mood.
// Spelled how they sound, so the voice never reads "pi" as "pie".
let pikaBudget = 1; // bursts left in this reply; reset per reply

function pikaify(sentence) {
  if (pikaBudget < 1) return "";
  pikaBudget -= 1;
  if (/\?\s*$/.test(sentence)) return "Peeka?";
  if (isExcited()) return Math.random() < 0.6 ? "Peekachoo!!" : "Peeka peeka!";
  return ["Peeka!", "Peekachoo!", "Pee-ka!"][Math.floor(Math.random() * 3)];
}

function queueSpeech(sentence) {
  if (/!\s*$/.test(sentence.trim()) && !cheeredThisReply && !action) {
    cheeredThisReply = true;
    cheer();
  }
  if (/!\s*$/.test(sentence.trim())) getExcited(5);
  if (isExcited() && !action) happyBounce();
  let text = cleanForSpeech(sentence);
  if (speechMode === "pika" && /[a-z0-9]/i.test(text)) text = pikaify(text);
  if (!/[a-z0-9]/i.test(text)) return;
  const myEpoch = epoch;
  const audioPromise = api.speak(text); // generate ahead while earlier lines play
  playChain = playChain.then(async () => {
    const res = await audioPromise;
    if (myEpoch !== epoch) return;
    // No Windows robot voice as a stand-in: if the real voice isn't ready,
    // stay quiet (the bubble still shows the words). main.js logs why.
    if (res.error) return;
    await playSamples(res.samples, res.rate);
  });
}

function playSamples(samples, rate) {
  return new Promise((resolve) => {
    const buf = audioCtx.createBuffer(1, samples.length, rate);
    buf.copyToChannel(samples instanceof Float32Array ? samples : new Float32Array(samples), 0);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    if (isExcited()) src.playbackRate.value = EXCITED_PITCH; // higher and a touch quicker
    src.connect(analyser);
    currentSource = src;
    src.onended = () => {
      if (currentSource === src) currentSource = null;
      resolve();
    };
    src.start();
  });
}

// Fallback if the local voice model isn't available: Windows' built-in voice.
function speakWithSystemVoice(text) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.onend = u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

function stopSpeaking() {
  epoch++;
  playChain = Promise.resolve();
  try { currentSource?.stop(); } catch {}
  speechSynthesis.cancel();
}

// Mouth opens with the loudness of whatever is playing.
(function lipSync() {
  requestAnimationFrame(lipSync);
  analyser.getFloatTimeDomainData(levels);
  let sum = 0;
  for (const v of levels) sum += v * v;
  const rms = Math.sqrt(sum / levels.length);
  const synthTalking = speechSynthesis.speaking ? 0.35 + Math.sin(performance.now() / 70) * 0.3 : 0;
  const target = Math.max(Math.min(1, rms * 9), synthTalking);
  mouth += (target - mouth) * 0.35;
})();

// ---------- conversation ----------

let pending = ""; // streamed text not yet sent to the voice
let reply = "";
let busy = false;

api.onChatDelta((delta) => {
  if (!reply) setStatus("");
  reply += delta;
  pending += delta;
  showBubble(reply);
  // Speak each sentence as soon as it's complete, so she starts talking early.
  let m;
  while ((m = pending.match(/^[\s\S]*?[.!?…]+["')\]]*(\s|$)/)) && m[0].trim().length > 1 && /\s$/.test(m[0])) {
    queueSpeech(m[0]);
    pending = pending.slice(m[0].length);
  }
});

async function send(text) {
  if (!text.trim() || busy) return;
  busy = true;
  stopSpeaking();
  audioCtx.resume();
  showBubble(text, { you: true });
  wake();
  cheeredThisReply = false;
  if (movesFromText(text)) cheeredThisReply = true;
  if (FUN_WORDS.test(text)) getExcited(10);
  setStatus("Thinking…");
  reply = "";
  pikaBudget = 1;
  pending = "";
  await api.chat(text);
  if (pending.trim()) queueSpeech(pending);
  pending = "";
  setStatus("");
  busy = false;
  await playChain;
  fadeBubbleSoon();
}

function say(text, { speak = true } = {}) {
  showBubble(text);
  if (speak) queueSpeech(text);
  fadeBubbleSoon();
}

// ---------- voice in: toggle to record, toggle again to send ----------

let recorder = null;
let chunks = [];
let recordStart = 0;

async function toggleListen() {
  if (recorder) return recorder.stop();
  if (busy) return;

  wake();
  stopSpeaking();
  audioCtx.resume();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return say("I can't reach your microphone.", { speak: false });
  }
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((tr) => tr.stop());
    recorder = null;
    $("btn-mic").classList.remove("live");
    if (performance.now() - recordStart < 500) return setStatus("");
    setStatus("Listening back…");
    const bytes = new Uint8Array(await new Blob(chunks, { type: "audio/webm" }).arrayBuffer());
    const res = await api.transcribe(bytes);
    setStatus("");
    if (res.error) return say(res.error, { speak: false });
    if (res.text) send(res.text);
  };
  recorder.start();
  recordStart = performance.now();
  $("btn-mic").classList.add("live");
  setStatus("Listening… press again to send", true);
}

api.onToggleListen(toggleListen);

// Tools report what they're doing ("Looking at your screen…").
api.onStatus((text) => setStatus(text));

// Music started (or something else fun happened): celebrate.
// Spotify playback state, polled by main.js every few seconds.
// Music is on when Spotify says it's playing, or when the computer is
// playing something with a steady beat (YouTube, games, any app).
let spotifyPlaying = false;
let heardMusic = false;
function updateMusic() {
  const playing = spotifyPlaying || heardMusic;
  if (playing === musicOn) return;
  api.log(`music ${playing ? "on" : "off"} (spotify=${spotifyPlaying} heard=${heardMusic}) bpm=${danceBpm}`);
  musicOn = playing;
  if (playing) {
    wake();
    getExcited(6);
  } else {
    if (action?.type === "dance") action = null;
    danceBpm = DEFAULT_BPM;
  }
}

api.onMusic(({ playing }) => {
  spotifyPlaying = playing;
  updateMusic();
});

// ---------- hearing music on the computer ----------

// Listens to the computer's sound output (loopback) and only measures it:
// its level 50 times a second. Music is steady; talking keeps dipping between
// words. The bass beat sets the dance tempo. Nothing is recorded or sent anywhere.
const SAMPLE_HZ = 50;
const WINDOW_S = 8;
const bassHistory = []; // bass energy per sample, newest last
const loudHistory = [];
const bassShareHistory = []; // bass energy / all energy, per sample
let musicVotes = 0;
let beatAvg = 0.1; // smoothed beat strength, for choosing graceful vs energetic
let sysAnalyser = null;
let sysFreq = null;
let sysWave = null;

async function startHearingMusic() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) return api.log("system audio: no audio track");
    const ctx = new AudioContext();
    sysAnalyser = ctx.createAnalyser();
    sysAnalyser.fftSize = 2048;
    sysAnalyser.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(stream).connect(sysAnalyser); // measured only, never played
    sysFreq = new Uint8Array(sysAnalyser.frequencyBinCount);
    sysWave = new Float32Array(sysAnalyser.fftSize);
    setInterval(sampleSystemAudio, 1000 / SAMPLE_HZ);
    setInterval(judgeMusic, 1000);
    api.log(`system audio: listening (${ctx.sampleRate} Hz)`);
  } catch (err) {
    api.log(`system audio unavailable: ${err.message}`);
  }
}

function sampleSystemAudio() {
  // Pikachu's own voice comes out of the speakers too; don't dance to that.
  const ownVoice = mouth > 0.02;
  sysAnalyser.getByteFrequencyData(sysFreq);
  sysAnalyser.getFloatTimeDomainData(sysWave);
  const binHz = sysAnalyser.context.sampleRate / sysAnalyser.fftSize;
  const bassBins = Math.max(2, Math.round(150 / binHz));
  let bass = 0;
  for (let i = 1; i <= bassBins; i++) bass += sysFreq[i];
  let all = 0;
  for (let i = 1; i < sysFreq.length / 4; i++) all += sysFreq[i]; // up to ~6 kHz
  let sum = 0;
  for (const v of sysWave) sum += v * v;
  const rms = Math.sqrt(sum / sysWave.length);
  const keep = SAMPLE_HZ * WINDOW_S;
  bassHistory.push(ownVoice ? (bassHistory.at(-1) ?? 0) : bass / bassBins);
  loudHistory.push(ownVoice ? 0 : rms);
  if (bassHistory.length > keep) bassHistory.shift();
  if (loudHistory.length > keep) loudHistory.shift();
  if (!ownVoice && rms > 0.01) bassShareHistory.push(bass / (all || 1));
  if (bassShareHistory.length > keep) bassShareHistory.shift();
}

// How strongly the bass pulses at a regular tempo, and at what tempo.
function findBeat() {
  // Onsets: how much the bass jumped since the previous sample.
  const onset = bassHistory.map((v, i) => (i ? Math.max(0, v - bassHistory[i - 1]) : 0));
  const mean = onset.reduce((a, b) => a + b, 0) / onset.length;
  const o = onset.map((v) => v - mean);
  const energy = o.reduce((a, v) => a + v * v, 0) || 1;
  let best = { strength: 0, bpm: DEFAULT_BPM };
  for (let bpm = 70; bpm <= 180; bpm += 1) {
    const lag = (60 / bpm) * SAMPLE_HZ;
    const l0 = Math.floor(lag);
    const frac = lag - l0;
    let acc = 0;
    for (let i = l0 + 1; i < o.length; i++) acc += o[i] * (o[i - l0] * (1 - frac) + o[i - l0 - 1] * frac);
    const strength = acc / energy;
    if (strength > best.strength) best = { strength, bpm };
  }
  // Fold into a comfortable dancing range.
  while (best.bpm < 85) best.bpm *= 2;
  while (best.bpm > 160) best.bpm /= 2;
  return best;
}

let lastAudioLog = 0;
function judgeMusic() {
  if (loudHistory.length < SAMPLE_HZ * WINDOW_S) return; // still filling the window
  const loudFrac = loudHistory.filter((v) => v > 0.01).length / loudHistory.length;
  const beat = findBeat();
  // Speech dips between syllables; music stays full. Share of sounding
  // moments that fall below half the average level.
  const sounding = loudHistory.filter((v) => v > 0.01);
  const avg = sounding.reduce((a, b) => a + b, 0) / (sounding.length || 1);
  const dipRatio = sounding.filter((v) => v < avg * 0.5).length / (sounding.length || 1);
  const bassShare = bassShareHistory.reduce((a, b) => a + b, 0) / (bassShareHistory.length || 1);
  // Measured on this PC: music scored 0.76-0.94, people talking 0.48-0.68.
  // (Beat strength and bass share overlapped too much to decide with.)
  const musicScore = loudFrac - 0.5 * dipRatio;
  const looksLikeMusic = musicScore > MUSIC_SCORE_MIN;
  // Hysteresis: a couple of seconds to switch on, a few more to switch off.
  musicVotes = Math.max(-4, Math.min(3, musicVotes + (looksLikeMusic ? 1 : -1)));
  const now = timer.getElapsed();
  if (now - lastAudioLog > 10) {
    lastAudioLog = now;
    api.log(`audio: score=${musicScore.toFixed(2)} loud=${loudFrac.toFixed(2)} dips=${dipRatio.toFixed(2)} bass=${bassShare.toFixed(3)} beat=${beat.strength.toFixed(2)} bpm=${Math.round(beat.bpm)} votes=${musicVotes}`);
  }
  if (musicVotes >= 2 && !heardMusic) heardMusic = true;
  if (musicVotes <= -3 && heardMusic) heardMusic = false;
  if (heardMusic && beat.strength > MUSIC_BEAT_MIN) danceBpm = Math.round(danceBpm * 0.6 + beat.bpm * 0.4);
  // Graceful or energetic: soft piano measured beat 0.02-0.06, pop 0.07-0.25.
  // A gap between the two thresholds stops it flip-flopping.
  if (looksLikeMusic) {
    beatAvg = beatAvg * 0.6 + beat.strength * 0.4;
    const mood = beatAvg < 0.065 ? "elegant" : beatAvg > 0.09 ? "energetic" : musicMood;
    if (mood !== musicMood) {
      musicMood = mood;
      api.log(`dance mood: ${mood} (beat ${beatAvg.toFixed(3)})`);
    }
  }
  updateMusic();
}
const MUSIC_SCORE_MIN = 0.72; // between talking (max 0.68) and music (min 0.76)
const MUSIC_BEAT_MIN = 0.09; // only trust a tempo estimate above this

// Started once the config says which OS this is (see the start section):
// hearing the computer's sound only works on Windows.

api.onMood((mood) => {
  if (mood !== "party") return;
  getExcited(14);
  dance(8);
});

// A reminder came due: wake up, wave, and say it.
api.onReminder((text) => {
  wake();
  wave();
  audioCtx.resume();
  showBubble(`⏰ ${text}`);
  pikaBudget = 1;
  queueSpeech(text.endsWith("!") ? text : `${text}!`);
  playChain.then(() => fadeBubbleSoon(15000));
});

// ---------- toolbar ----------

$("btn-mic").onclick = toggleListen;
$("btn-close").onclick = () => api.quit();
$("btn-dance").onclick = () => {
  wake();
  dance(8);
};
$("btn-walk").onclick = () => {
  wake();
  randomMove();
};
$("btn-reset").onclick = async () => {
  await api.resetChat();
  stopSpeaking();
  say("Fresh start. What's up?");
};
$("btn-type").onclick = () => {
  $("typebox").classList.toggle("hidden");
  if (!$("typebox").classList.contains("hidden")) $("typein").focus();
};
$("typebox").onsubmit = (e) => {
  e.preventDefault();
  const text = $("typein").value;
  $("typein").value = "";
  send(text);
};

window.addEventListener("resize", () => {
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
});

// ---------- click-through ----------

// The window is taller than the character so the bubble has room. Only the
// character and the UI catch the mouse; empty space passes clicks through.
// Windows stops sending mouse events once clicks pass through, so hit-test
// with the cursor position main.js already sends for the eyes instead.
let through = null;
function hitTest(p) {
  const inside = p.x >= 0 && p.y >= 0 && p.x < p.w && p.y < p.h;
  const el = inside ? document.elementFromPoint(p.x, p.y) : null;
  const onUi = el?.closest("#toolbar, #bubble:not(.faded), #typebox:not(.hidden), #status:not(.hidden)");
  const onStage = inside && p.y > window.innerHeight - canvas.clientHeight;
  const hot = !!onUi || onStage;
  document.body.classList.toggle("hot", hot);
  if (through !== !hot) {
    through = !hot;
    api.mouseThrough(through);
  }
}
api.onCursor(hitTest);

// ---------- start ----------

const config = await api.loadConfig();
headTilt = config.headTilt ?? 0;
speechMode = config.speech ?? "english";
if (config.platform === "win32") startHearingMusic(); // Mac: dance mode follows Spotify only
if (config.vrm) {
  try {
    await loadVrm(config.vrm);
  } catch (err) {
    console.error(err);
    $("drop-hint").classList.remove("hidden");
  }
} else {
  $("drop-hint").classList.remove("hidden");
}
