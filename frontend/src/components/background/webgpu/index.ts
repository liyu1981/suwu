/**
 * The WebGPU background family.
 *
 * - `webgpu-render-engine/` is the shared host + declarative pass pipeline.
 * - `shadertoys/` holds the backgrounds built on it. Each is one `setup.ts`
 *   (metadata, parameters and the scene) plus its `shaders/`. The setup only
 *   registers metadata on the eager path and lazily imports the engine and WGSL
 *   when the background actually starts.
 *
 * Importing this module registers every shadertoy (side-effect imports).
 */
import './shadertoys/atmospheric-landscape/setup';
import './shadertoys/cosmos-in-crystal/setup';
import './shadertoys/interactive-fluid/setup';
import './shadertoys/matrix-rain/setup';
import './shadertoys/rainforest/setup';
import './shadertoys/seascape/setup';
