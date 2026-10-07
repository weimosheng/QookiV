import type { VisualClip } from "../../core/types";
import type { LayerDefinition } from "../types";
import { backgroundLayer } from "./background";
import { deviceLayer } from "./device";
import { imageLayer, videoLayer } from "./media";
import { shapeLayer } from "./shape";
import { textLayer } from "./text";

/**
 * Layer registry.
 *
 * Adding a clip kind means adding one entry here plus its payload in
 * `core/types.ts`; the compositor, inspector and exporter pick it up
 * automatically.
 */
export const LAYERS: Record<VisualClip["kind"], LayerDefinition> = {
  background: backgroundLayer,
  image: imageLayer,
  video: videoLayer,
  text: textLayer,
  shape: shapeLayer,
  device: deviceLayer,
};

export function getLayer(kind: VisualClip["kind"]): LayerDefinition | undefined {
  return LAYERS[kind];
}

export { backgroundLayer, deviceLayer, imageLayer, videoLayer, shapeLayer, textLayer };
