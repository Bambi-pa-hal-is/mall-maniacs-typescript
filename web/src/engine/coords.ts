import * as THREE from 'three';

/** Angle16_Sin/Cos (0x42d030/0x42d050) scale int16 angles by 2*pi/65536 (double at 0x44b788). */
export const ANGLE_TO_RAD = (2 * Math.PI) / 65536;

/**
 * The engine is Y-down. Everything game-related lives under this root, which rotates 180 degrees
 * about X so that engine coordinates (and the engine's Ry*Rx*Rz = 'YXZ' Euler order) can be used
 * unchanged inside it.
 */
export function createEngineRoot(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'engine-root';
  root.rotation.x = Math.PI;
  return root;
}

/** Node/object rotation from int16 engine angles (Node_BuildLocalMatrix 0x42f030). */
export function engineEuler(rx: number, ry: number, rz: number, target = new THREE.Euler()): THREE.Euler {
  return target.set(rx * ANGLE_TO_RAD, ry * ANGLE_TO_RAD, rz * ANGLE_TO_RAD, 'YXZ');
}
