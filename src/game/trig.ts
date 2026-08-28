import { ANGLE_UNITS } from './constants.ts';

// Angles are integers 0..ANGLE_UNITS-1 and resolve through a lookup table.
//
// This exists for determinism. +, -, *, / and sqrt are exactly specified by
// IEEE 754 and give identical results everywhere; Math.cos and Math.sin are
// not, and may differ in the last bit between engines. Keeping them out of the
// step function means the sim is built entirely from exact operations.

const COS = new Float64Array(ANGLE_UNITS);
const SIN = new Float64Array(ANGLE_UNITS);

for (let i = 0; i < ANGLE_UNITS; i++) {
  const rad = (i / ANGLE_UNITS) * Math.PI * 2;
  COS[i] = Math.cos(rad);
  SIN[i] = Math.sin(rad);
}

export function wrapAngle(i: number): number {
  return ((i % ANGLE_UNITS) + ANGLE_UNITS) % ANGLE_UNITS;
}

export function cosA(i: number): number {
  return COS[wrapAngle(i)];
}

export function sinA(i: number): number {
  return SIN[wrapAngle(i)];
}

export function radiansToAngle(rad: number): number {
  return wrapAngle(Math.round((rad / (Math.PI * 2)) * ANGLE_UNITS));
}

export function angleToRadians(i: number): number {
  return (wrapAngle(i) / ANGLE_UNITS) * Math.PI * 2;
}
