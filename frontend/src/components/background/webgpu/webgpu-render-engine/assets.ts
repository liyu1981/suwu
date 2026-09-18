import { storage, texture } from 'vgpu';
import type { Gpu, StorageBuffer, Texture, TextureUsageName } from 'vgpu';

/** A host-built GPU resource, created once when the scene starts. */
export type GpuAssetBuilder<T> = (gpu: Gpu) => T | Promise<T>;

/**
 * Uploads bytes into a read-only storage buffer — the vgpu-native host → GPU
 * path for structured data (e.g. the Matrix glyph atlas).
 */
export function storageAsset(
  build: () => BufferSource | Promise<BufferSource>,
): GpuAssetBuilder<StorageBuffer> {
  return async (gpu) => {
    const data = await build();
    const buffer = storage(gpu, data.byteLength, 'read');
    buffer.write(data);
    return buffer;
  };
}

/** Uploads a 3D volume into a sampled `texture_3d` (e.g. the noise field). */
export function texture3dAsset(options: {
  readonly size: number;
  readonly format: GPUTextureFormat;
  readonly build: () => Uint8Array;
  readonly usage?: readonly [TextureUsageName, ...TextureUsageName[]];
  readonly label?: string;
}): GpuAssetBuilder<Texture> {
  return (gpu) => {
    const { size, format, build } = options;
    const volume = build();
    const tex = texture(gpu, {
      kind: '3d',
      size: [size, size, size],
      format,
      usage: options.usage ?? ['texture_binding', 'copy_dst'],
      label: options.label,
    });
    // RGBA8: 4 bytes per texel, and `size` is a multiple of 256 for the volume
    // the engine ships (64), so no row padding is needed.
    gpu.gpu.queue.writeTexture(
      { texture: tex.gpu },
      volume,
      { bytesPerRow: size * 4, rowsPerImage: size },
      { width: size, height: size, depthOrArrayLayers: size },
    );
    return tex;
  };
}
