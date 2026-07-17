// src/utils/downscaleImage.test.ts — spec 127.
//
// Runs in the node-env unit project (src/utils/**/*.test.ts). Platform is
// mocked to 'web' so the browser code path is exercised; `createImageBitmap`
// and `document.createElement('canvas')` are stubbed since node/jsdom don't
// implement them.

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

import { downscaleImage, fitWithinMaxEdge } from './downscaleImage';

describe('fitWithinMaxEdge — aspect + no-upscale contract', () => {
  it('caps the longest edge and preserves aspect ratio (landscape)', () => {
    expect(fitWithinMaxEdge(1600, 800, 800)).toEqual({ width: 800, height: 400 });
  });

  it('caps the longest edge (portrait)', () => {
    expect(fitWithinMaxEdge(800, 1600, 800)).toEqual({ width: 400, height: 800 });
  });

  it('never upscales a source already within the cap', () => {
    expect(fitWithinMaxEdge(300, 200, 800)).toEqual({ width: 300, height: 200 });
  });

  it('leaves a source exactly at the cap unchanged', () => {
    expect(fitWithinMaxEdge(800, 600, 800)).toEqual({ width: 800, height: 600 });
  });

  it('rounds to integer pixels and clamps to >= 1', () => {
    const { width, height } = fitWithinMaxEdge(801, 3, 800);
    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
    expect(height).toBeGreaterThanOrEqual(1);
  });
});

describe('downscaleImage — browser path', () => {
  const realDoc = (global as any).document;
  const realBitmap = (global as any).createImageBitmap;

  afterEach(() => {
    (global as any).document = realDoc;
    (global as any).createImageBitmap = realBitmap;
    jest.clearAllMocks();
  });

  it('draws to a capped canvas and returns a JPEG blob at the given quality', async () => {
    const drawImage = jest.fn();
    const sentinelBlob = { __blob: true, type: 'image/jpeg' };
    const toBlob = jest.fn(
      (cb: (b: unknown) => void, _type: string, _q: number) => cb(sentinelBlob),
    );
    const canvas: any = {
      width: 0,
      height: 0,
      getContext: jest.fn(() => ({ drawImage })),
      toBlob,
    };
    (global as any).document = { createElement: jest.fn(() => canvas) };
    (global as any).createImageBitmap = jest.fn(async () => ({
      width: 1600,
      height: 800,
      close: jest.fn(),
    }));

    const out = await downscaleImage({} as Blob, 800, 0.7);

    expect(out).toBe(sentinelBlob);
    // Longest edge capped to 800, aspect preserved.
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(400);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 400);
    // JPEG type + forwarded quality.
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.7);
  });

  it('rejects when the browser cannot decode / canvas produces null', async () => {
    const toBlob = jest.fn((cb: (b: unknown) => void) => cb(null));
    const canvas: any = {
      width: 0,
      height: 0,
      getContext: jest.fn(() => ({ drawImage: jest.fn() })),
      toBlob,
    };
    (global as any).document = { createElement: jest.fn(() => canvas) };
    (global as any).createImageBitmap = jest.fn(async () => ({
      width: 100,
      height: 100,
      close: jest.fn(),
    }));

    await expect(downscaleImage({} as Blob)).rejects.toThrow(/toBlob returned null/);
  });

  it('rejects when browser image APIs are unavailable', async () => {
    (global as any).document = undefined;
    (global as any).createImageBitmap = undefined;
    await expect(downscaleImage({} as Blob)).rejects.toThrow(/browser environment/);
  });
});
