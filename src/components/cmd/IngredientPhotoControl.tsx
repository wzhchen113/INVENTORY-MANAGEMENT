// src/components/cmd/IngredientPhotoControl.tsx — spec 127.
//
// Admin photo control for the Cmd ingredient editor (EDIT mode only — a photo
// needs a saved catalog id + brand for its storage path, spec 127 §10). Shows
// the current photo (or a placeholder) plus Upload / Replace / Remove actions.
//
// Upload is WEB-ONLY (spec 127 §0.6 — native admin upload is out of scope):
// the picker uses the same programmatic `document.createElement('input')`
// pattern as UploadCsvModal, then downscales client-side (src/utils/
// downscaleImage) before handing the JPEG blob to the store action, which
// delegates the storage upload + `image_path` set to `db.ts`. On native the
// control renders view-only (preview + a note, no picker).

import React from 'react';
import { View, Text, TouchableOpacity, Image, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { SectionCaption } from './SectionCaption';
import { useStore } from '../../store/useStore';
import { ingredientImageUrl } from '../../lib/ingredientImage';
import { downscaleImage } from '../../utils/downscaleImage';

interface Props {
  catalogId: string;
  brandId: string;
  imagePath?: string | null;
}

const PREVIEW = 72;

export const IngredientPhotoControl: React.FC<Props> = ({ catalogId, brandId, imagePath }) => {
  const C = useCmdColors();
  const uploadIngredientImage = useStore((s) => s.uploadIngredientImage);
  const removeIngredientImage = useStore((s) => s.removeIngredientImage);

  // Local mirror of the current path so preview updates immediately on
  // upload/remove regardless of prop staleness. Re-sync when the host swaps
  // the edited item (imagePath changes).
  const [path, setPath] = React.useState<string | null>(imagePath ?? null);
  React.useEffect(() => { setPath(imagePath ?? null); }, [imagePath]);

  const [status, setStatus] = React.useState<'idle' | 'uploading' | 'removing'>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const busy = status !== 'idle';

  const uri = ingredientImageUrl(path);
  const isWeb = Platform.OS === 'web';

  const handleFile = React.useCallback(
    async (file: File) => {
      setStatus('uploading');
      setError(null);
      try {
        const blob = await downscaleImage(file);
        const newPath = await uploadIngredientImage(catalogId, brandId, blob);
        if (newPath) {
          setPath(newPath);
        } else {
          // Store already toasted via notifyBackendError; surface inline too.
          setError('Upload failed');
        }
      } catch (e: any) {
        setError(e?.message || 'Could not process image');
      } finally {
        setStatus('idle');
      }
    },
    [catalogId, brandId, uploadIngredientImage],
  );

  const openPicker = React.useCallback(() => {
    if (!isWeb || busy) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) handleFile(f as File);
    };
    input.click();
  }, [isWeb, busy, handleFile]);

  const handleRemove = React.useCallback(async () => {
    if (busy || !path) return;
    setStatus('removing');
    setError(null);
    try {
      const ok = await removeIngredientImage(catalogId);
      if (ok) setPath(null);
      else setError('Remove failed');
    } finally {
      setStatus('idle');
    }
  }, [busy, path, catalogId, removeIngredientImage]);

  const statusLabel =
    status === 'uploading' ? 'uploading…' : status === 'removing' ? 'removing…' : null;

  return (
    <View style={{ marginTop: 14, marginBottom: 6 }}>
      <SectionCaption tone="fg3" size={9.5}>PHOTO</SectionCaption>
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 8, alignItems: 'flex-start' }}>
        {/* Preview / placeholder — fixed box, no layout shift between states. */}
        {uri ? (
          <Image
            source={{ uri }}
            style={{ width: PREVIEW, height: PREVIEW, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}
            resizeMode="cover"
            {...(isWeb ? ({ accessibilityIgnoresInvertColors: true } as any) : {})}
            testID="ingredient-photo-preview"
          />
        ) : (
          <View
            style={{
              width: PREVIEW, height: PREVIEW, borderRadius: CmdRadius.sm,
              borderWidth: 1, borderColor: C.border, backgroundColor: C.panel2,
              alignItems: 'center', justifyContent: 'center',
            }}
            testID="ingredient-photo-placeholder"
          >
            <Text style={{ fontFamily: mono(400), fontSize: 22, color: C.fg3 }}>▤</Text>
          </View>
        )}

        <View style={{ flex: 1, gap: 8 }}>
          {isWeb ? (
            <>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <TouchableOpacity
                  onPress={openPicker}
                  disabled={busy}
                  accessibilityRole="button"
                  testID="ingredient-photo-upload"
                  style={{
                    paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm,
                    backgroundColor: C.accent, opacity: busy ? 0.5 : 1,
                  }}
                >
                  <Text style={{ fontFamily: mono(700), fontSize: 11, color: '#000' }}>
                    {path ? 'REPLACE' : 'UPLOAD'}
                  </Text>
                </TouchableOpacity>
                {path ? (
                  <TouchableOpacity
                    onPress={handleRemove}
                    disabled={busy}
                    accessibilityRole="button"
                    testID="ingredient-photo-remove"
                    style={{
                      paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm,
                      borderWidth: 1, borderColor: C.border, opacity: busy ? 0.5 : 1,
                    }}
                  >
                    <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.danger }}>REMOVE</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              <Text style={{ fontFamily: mono(400), fontSize: 10, color: error ? C.danger : C.fg3 }}>
                {error || statusLabel || 'JPG/PNG · shown to counting staff · shared across all brand stores'}
              </Text>
            </>
          ) : (
            // Native admin build: view-only (spec 127 §0.6).
            <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.fg3 }}>
              {path ? 'Photo set. Edit photos from the web app.' : 'No photo. Add one from the web app.'}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
};
