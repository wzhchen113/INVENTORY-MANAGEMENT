// src/components/cmd/IngredientPhotoControl.test.tsx — spec 127.
//
// Verifies the admin photo control's web upload/remove wiring:
//   - picking a file downscales it (downscaleImage) then calls the store's
//     uploadIngredientImage with (catalogId, brandId, blob) — the db helper
//     reads the previous image_path internally,
//   - pressing Remove calls the store's removeIngredientImage,
//   - the control shows Upload (no photo) vs Replace + Remove (photo present).
//
// The backend-owned resolver + store actions + the downscale util are mocked;
// Platform is forced to 'web' so the picker branch renders.

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

jest.mock('../../lib/ingredientImage', () => ({
  ingredientImageUrl: (p?: string | null) => (p ? `https://cdn.test/${p}` : null),
}));

const mockDownscale = jest.fn(async (_file: unknown) => ({ __blob: true }) as any);
jest.mock('../../utils/downscaleImage', () => ({
  downscaleImage: (file: unknown) => mockDownscale(file),
}));

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#fff', panel: '#f4f4f4', panel2: '#eaeaea', border: '#ccc',
    borderStrong: '#888', fg: '#000', fg2: '#444', fg3: '#888',
    accent: '#185FA5', accentBg: '#E6F1FB', accentFg: '#fff',
    warn: '#854F0B', warnBg: '#FAEEDA', danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE', info: '#185FA5', infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

const mockUpload = jest.fn(async (_c: string, _b: string, _blob: unknown) => 'brand-1/cat-1/new.jpg');
const mockRemove = jest.fn(async (_c: string) => true);
jest.mock('../../store/useStore', () => {
  const state: any = {
    uploadIngredientImage: (c: string, b: string, blob: unknown) => mockUpload(c, b, blob),
    removeIngredientImage: (c: string) => mockRemove(c),
  };
  const useStore: any = (selector: (s: any) => any) => selector(state);
  useStore.getState = () => state;
  return { useStore };
});

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { IngredientPhotoControl } from './IngredientPhotoControl';

// Stub document.createElement('input') so pressing Upload synchronously
// drives the onchange with a fake file (jsdom won't open a real file dialog).
function stubFileInput(file: unknown) {
  const fakeInput: any = {
    type: '',
    accept: '',
    files: [file],
    onchange: null,
    click() {
      this.onchange?.();
    },
  };
  const orig = document.createElement.bind(document);
  jest
    .spyOn(document, 'createElement')
    .mockImplementation((tag: any) => (tag === 'input' ? fakeInput : orig(tag)));
  return fakeInput;
}

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('IngredientPhotoControl — admin web upload/remove', () => {
  it('shows UPLOAD (no Remove) when there is no photo', () => {
    const { getByTestId, queryByTestId } = render(
      <IngredientPhotoControl catalogId="cat-1" brandId="brand-1" imagePath={null} />,
    );
    expect(getByTestId('ingredient-photo-upload')).toBeTruthy();
    expect(queryByTestId('ingredient-photo-remove')).toBeNull();
    expect(getByTestId('ingredient-photo-placeholder')).toBeTruthy();
  });

  it('downscales then uploads the picked file with the brand-scoped args', async () => {
    const fakeFile = { name: 'x.png' };
    stubFileInput(fakeFile);

    const { getByTestId } = render(
      <IngredientPhotoControl catalogId="cat-1" brandId="brand-1" imagePath={null} />,
    );
    fireEvent.press(getByTestId('ingredient-photo-upload'));

    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    expect(mockDownscale).toHaveBeenCalledWith(fakeFile);
    // uploadIngredientImage(catalogId, brandId, blob) — db reads previousPath internally.
    expect(mockUpload).toHaveBeenCalledWith('cat-1', 'brand-1', { __blob: true });
  });

  it('shows REPLACE + REMOVE when a photo exists and replaces via uploadIngredientImage', async () => {
    const fakeFile = { name: 'y.jpg' };
    stubFileInput(fakeFile);

    const { getByTestId } = render(
      <IngredientPhotoControl
        catalogId="cat-1"
        brandId="brand-1"
        imagePath="brand-1/cat-1/old.jpg"
      />,
    );
    expect(getByTestId('ingredient-photo-preview')).toBeTruthy();
    expect(getByTestId('ingredient-photo-remove')).toBeTruthy();

    fireEvent.press(getByTestId('ingredient-photo-upload')); // labelled REPLACE
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    expect(mockUpload).toHaveBeenCalledWith('cat-1', 'brand-1', { __blob: true });
  });

  it('calls removeIngredientImage on Remove', async () => {
    const { getByTestId } = render(
      <IngredientPhotoControl
        catalogId="cat-1"
        brandId="brand-1"
        imagePath="brand-1/cat-1/old.jpg"
      />,
    );
    fireEvent.press(getByTestId('ingredient-photo-remove'));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledTimes(1));
    expect(mockRemove).toHaveBeenCalledWith('cat-1');
  });
});
