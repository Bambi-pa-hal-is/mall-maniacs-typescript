import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _want = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _wq = new THREE.Quaternion();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();

/** Rotate `bone` (in world space) so that the direction `from` maps onto `to`. */
function aimBone(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
  if (from.lengthSq() < 1e-6 || to.lengthSq() < 1e-6) return;
  _q.setFromUnitVectors(_from.copy(from).normalize(), _to.copy(to).normalize());
  bone.getWorldQuaternion(_wq);
  bone.parent ? bone.parent.getWorldQuaternion(_pq) : _pq.identity();
  // local = parentWorld^-1 * delta * world
  bone.quaternion.copy(_pq.invert().multiply(_q).multiply(_wq));
  bone.updateMatrixWorld(true);
}

/**
 * Analytic two-bone IK: rotates `upper` and `lower` so that `end` (the wrist) reaches `target`,
 * bending towards `pole`. Positions are world space; bone lengths come from the current pose.
 */
export function solveTwoBone(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  end: THREE.Object3D,
  target: THREE.Vector3,
  pole: THREE.Vector3,
): void {
  upper.getWorldPosition(_a);
  lower.getWorldPosition(_b);
  end.getWorldPosition(_c);
  const lenA = _a.distanceTo(_b);
  const lenB = _b.distanceTo(_c);
  if (lenA < 1e-3 || lenB < 1e-3) return;
  _dir.subVectors(target, _a);
  const d = THREE.MathUtils.clamp(_dir.length(), Math.abs(lenA - lenB) + 1e-3, lenA + lenB - 1e-3);
  _dir.normalize();
  // Elbow position on the circle around the shoulder-target axis, on the pole side.
  const cosA = (lenA * lenA + d * d - lenB * lenB) / (2 * lenA * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _perp.subVectors(pole, _a);
  _perp.addScaledVector(_dir, -_perp.dot(_dir));
  if (_perp.lengthSq() < 1e-6) _perp.set(0, 1, 0).addScaledVector(_dir, -_dir.y);
  _perp.normalize();
  _want.copy(_a).addScaledVector(_dir, lenA * cosA).addScaledVector(_perp, lenA * sinA);
  aimBone(upper, _b.clone().sub(_a), _want.clone().sub(_a));
  lower.getWorldPosition(_b);
  end.getWorldPosition(_c);
  aimBone(lower, _c.clone().sub(_b), target.clone().sub(_b));
}
